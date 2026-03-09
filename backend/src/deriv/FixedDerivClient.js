import WebSocket from 'ws'
import EventEmitter from 'events'

export default class FixedDerivClient extends EventEmitter {
  constructor({ url = 'wss://ws.derivws.com/websockets/v3', token, appId } = {}) {
    super()
    this.url = url
    this.token = token
    this.appId = appId
    this.ws = null
    this.connected = false
    this.authorized = false
    this.accountInfo = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authorized) {
        resolve()
        return
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Already connected, just need to authorize
        if (this.token) {
          this.send({ authorize: this.token })
        }
        resolve()
        return
      }

      const fullUrl = this.appId ? `${this.url}?app_id=${this.appId}` : this.url
      this.ws = new WebSocket(fullUrl)

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'))
      }, 10000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.connected = true
        console.log('✅ Deriv WebSocket connected')
        
        if (this.token) {
          this.send({ authorize: this.token })
        }
      })

      this.ws.on('message', (raw) => {
        try {
          const json = JSON.parse(raw.toString())

          if (json.authorize) {
            this.authorized = true
            this.accountInfo = json.authorize
            console.log('✅ Deriv authorized:', this.accountInfo.loginid)
            this.emit('authorized', json.authorize)
            resolve() // Resolve when authorized
            return
          }

          if (json.error) {
            console.error('❌ Deriv error:', json.error)
            this.emit('deriv_error', json.error)
            return
          }

          this.emit('message', json)
        } catch (e) {
          console.error('❌ Message parse error:', e)
        }
      })

      this.ws.on('error', (error) => {
        clearTimeout(timeout)
        console.error('❌ WebSocket error:', error)
        reject(error)
      })

      this.ws.on('close', () => {
        console.log('🔌 WebSocket closed')
        this.connected = false
        this.authorized = false
      })
    })
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }
    this.ws.send(JSON.stringify(obj))
  }

  async sendRequest(obj, expectedKey, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const reqId = Math.floor(Math.random() * 1_000_000_000)
      const payload = { ...obj, req_id: reqId }

      const cleanup = () => {
        clearTimeout(timer)
        this.off('message', handler)
      }

      const handler = (json) => {
        if (json.req_id !== reqId) {
          return
        }
        if (json.error) {
          cleanup()
          reject(new Error(json.error.message))
          return
        }
        if (expectedKey && json[expectedKey] !== undefined) {
          cleanup()
          resolve(json[expectedKey])
        }
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('timeout'))
      }, timeoutMs)

      this.on('message', handler)
      try {
        this.send(payload)
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
  }

  async proposeContract(opts = {}) {
    const req = { proposal: 1, ...opts }
    const proposal = await this.sendRequest(req, 'proposal', 30000)
    return proposal
  }

  async buyContract(proposalId) {
    const req = { buy: proposalId }
    const buy = await this.sendRequest(req, 'buy', 30000)
    return buy
  }

  async getLatestTick(symbol = 'R_100', timeoutMs = 10000) {
    return await this.sendRequest({ ticks: symbol }, 'tick', timeoutMs)
  }

  async getContractInfo(contractId, timeoutMs = 30000) {
    const parsedContractId = Number(contractId)
    if (!Number.isFinite(parsedContractId) || parsedContractId <= 0) {
      throw new Error('Invalid contract id')
    }

    return await this.sendRequest(
      { proposal_open_contract: 1, contract_id: parsedContractId },
      'proposal_open_contract',
      timeoutMs
    )
  }

  async waitForContractClose(contractId, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90000
    const pollIntervalMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : 1000
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const info = await this.getContractInfo(contractId, Math.min(10000, timeoutMs))
      if (info && (info.is_sold === 1 || info.is_sold === true)) {
        return info
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error('Contract settlement timeout')
  }

  async validateOnce(timeoutMs = 10000) {
    try {
      await Promise.race([
        this.connect(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Authorization timeout')), timeoutMs)
        })
      ])
      return { ok: true, authorized: this.authorized, accountInfo: this.accountInfo }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  getAccountInfo() {
    return this.accountInfo
  }
}

