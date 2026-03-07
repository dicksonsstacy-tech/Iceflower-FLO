import WebSocket from 'ws'
import EventEmitter from 'events'

export default class DerivClient extends EventEmitter {
  constructor({ url = 'wss://ws.derivws.com/websockets/v3', token, appId } = {}) {
    super()
    this.url = url
    this.token = token
    this.appId = appId
    this.ws = null
    this.connected = false
    this.authorized = false
    this.accountInfo = null
    this._pendingSubscriptions = []
  }

  connect() {
    if (this.ws) return
    const fullUrl = this.appId ? `${this.url}?app_id=${this.appId}` : this.url
    this.ws = new WebSocket(fullUrl)

    this.ws.on('open', () => {
      this.connected = true
      if (this.token) {
        this.send({ authorize: this.token })
      }
      this.emit('open')
    })

    this.ws.on('message', (raw) => {
      try {
        const json = JSON.parse(raw.toString())

        // Authorization response
        if (json.authorize) {
          this.authorized = true
          this.accountInfo = json.authorize
          this.emit('authorized', json.authorize)
          // flush any pending subscriptions now that we're authorized
          this._flushPendingSubscriptions()
          return
        }

        // Authorization error
        if (json.error && json.echo_req && json.echo_req.authorize) {
          this.emit('auth_error', json.error)
          return
        }

        // Tick message
        if (json.tick) {
          this.emit('tick', json.tick)
          // Produce a lightweight prediction (prototype only)
          const pred = this._predictionFromTick(json.tick)
          this.emit('prediction', pred)
          return
        }

        // Generic messages
        this.emit('message', json)
      } catch (err) {
        // ignore parse errors
      }
    })

    this.ws.on('close', () => {
      this.connected = false
      this.ws = null
      this.emit('close')
      // auto-reconnect after a short delay
      setTimeout(() => this.connect(), 3000)
    })

    this.ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  // Send a request and wait for a matching response key within a timeout.
  // matchKey is a string that should appear as a top-level key in the response (e.g., 'proposal', 'buy').
  async sendRequest(obj, matchKey, timeoutMs = 5000) {
    this.connect()
    return new Promise((resolve, reject) => {
      let timer = null
      const handler = (json) => {
        try {
          if (json && Object.prototype.hasOwnProperty.call(json, matchKey)) {
            clearTimeout(timer)
            this.off('message', handler)
            resolve(json[matchKey])
          }
        } catch (e) {
          // ignore
        }
      }

      timer = setTimeout(() => {
        this.off('message', handler)
        reject(new Error('timeout'))
      }, timeoutMs)

      this.on('message', handler)
      try {
        this.send(obj)
      } catch (e) {
        clearTimeout(timer)
        this.off('message', handler)
        reject(e)
      }
    })
  }

  // Propose a contract using Deriv's proposal endpoint. Returns the proposal object.
  async proposeContract(opts = {}, timeoutMs = 5000) {
    // opts should contain fields like amount, basis, contract_type, symbol, duration, barrier, etc.
    const req = { proposal: 1, ...opts }
    const proposal = await this.sendRequest(req, 'proposal', timeoutMs)
    return proposal
  }

  // Buy a contract using a proposal id. Returns the buy response object.
  async buyContract(proposalId, timeoutMs = 5000) {
    const req = { buy: proposalId }
    const buy = await this.sendRequest(req, 'buy', timeoutMs)
    return buy
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(obj))
  }

  subscribeTicks(symbol = 'R_100') {
    this.connect()
    // queue the subscription until the socket is open and (if required) authorized
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || (this.token && !this.authorized)) {
      if (!this._pendingSubscriptions.includes(symbol)) this._pendingSubscriptions.push(symbol)
      return
    }

    this.send({ ticks: symbol, subscribe: 1 })
  }

  _flushPendingSubscriptions() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    while (this._pendingSubscriptions.length) {
      const symbol = this._pendingSubscriptions.shift()
      try {
        this.send({ ticks: symbol, subscribe: 1 })
      } catch (e) {
        // push back on error
        this._pendingSubscriptions.unshift(symbol)
        break
      }
    }
  }

  close() {
    if (this.ws) this.ws.close()
  }

  async validateOnce(timeoutMs = 5000) {
    return new Promise((resolve) => {
      let timer
      const onAuth = (data) => {
        clearTimeout(timer)
        this.off('auth_error', onErr)
        resolve({ ok: true, data })
      }
      const onErr = (err) => {
        clearTimeout(timer)
        this.off('authorized', onAuth)
        resolve({ ok: false, err })
      }
      timer = setTimeout(() => {
        this.off('authorized', onAuth)
        this.off('auth_error', onErr)
        resolve({ ok: false, err: 'timeout' })
      }, timeoutMs)

      this.once('authorized', onAuth)
      this.once('auth_error', onErr)
      // Make sure client connects and sends authorize
      this.connect()
    })
  }

  _predictionFromTick(tick) {
    // Very naive prototype prediction derived from tick.quote
    const quote = Number(tick.quote)
    const prediction = Math.floor(quote) % 10
    const strength = Math.min(95, 40 + Math.floor((quote % 1) * 100))
    return {
      // Use the predicted digit as the entry point so UI reflects live predictions
      entry: prediction,
      prediction,
      strength,
      symbol: tick.symbol,
      ts: tick.epoch ? tick.epoch * 1000 : Date.now(),
      quote,
    }
  }

  getAccountInfo() {
    return this.accountInfo || null
  }

  // Check if client is authorized
  get isAuthorized() {
    return this.authorized
  }
}
