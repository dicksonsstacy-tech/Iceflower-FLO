class RealTradeExecutor {
  constructor(derivClient, options = {}) {
    this.deriv = derivClient
    this.config = {
      maxStake: options.maxStake || 6000,
      maxDailyLoss: options.maxDailyLoss || 10000,
      minProbability: options.minProbability || 0.7,
      liveTrading: options.liveTrading !== false,
      allowSimulationFallback: options.allowSimulationFallback === true,
      ...options
    }

    this.dailyStats = {
      totalTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      startTime: Date.now()
    }
    this.settledContracts = new Set()

    console.log('Iceflower FLO Realm Trade Executor Initialized')
    console.log(`Max Stake: $${this.config.maxStake}`)
    console.log(`Live Trading: ${this.config.liveTrading ? 'ENABLED' : 'DISABLED'}`)
  }

  async executeLiveTrade(position) {
    try {
      console.log(`Executing REAL trade: $${position.stake} on digit ${position.prediction}`)

      if (!this.validatePosition(position)) {
        throw new Error('Position validation failed')
      }

      if (!this.config.liveTrading) {
        throw new Error('Live trading is disabled')
      }

      if (!this.deriv.connected || !this.deriv.authorized) {
        console.log('Reconnecting to Deriv...')
        await this.deriv.connect()
      }

      if (!this.deriv.authorized) {
        throw new Error('Not authorized with Deriv')
      }

      return await this.executeRealTrade(position)
    } catch (error) {
      console.error('REAL trade failed:', error.message)

      if (this.config.allowSimulationFallback) {
        console.log('Simulation fallback enabled, using simulated trade')
        return this.executeSimulation(position)
      }

      return {
        ok: false,
        simulated: false,
        error: error.message
      }
    }
  }

  async executeRealTrade(position) {
    const proposalOpts = {
      amount: position.stake,
      basis: 'stake',
      contract_type: 'DIGITMATCH',
      symbol: position.symbol || 'R_100',
      duration: position.duration || 1,
      duration_unit: position.duration_unit || 't',
      currency: 'USD',
      barrier: String(position.prediction)
    }

    const proposal = await this.deriv.proposeContract(proposalOpts)
    if (!proposal || !proposal.id) {
      throw new Error('Failed to get valid proposal from Deriv')
    }

    const buyResult = await this.deriv.buyContract(proposal.id)
    if (!buyResult || !buyResult.transaction_id) {
      throw new Error('Failed to execute buy on Deriv')
    }

    const buyPrice = Number(buyResult.buy_price ?? position.stake)
    const contractId = Number(buyResult.contract_id ?? buyResult?.buy?.contract_id)
    if (!Number.isFinite(contractId) || contractId <= 0) {
      throw new Error('Missing contract_id from buy response')
    }

    try {
      const settlement = await this.settleTrade(contractId, buyPrice, {
        timeoutMs: position.settlementTimeoutMs || 90000
      })
      return {
        ok: true,
        simulated: false,
        real: true,
        placed: true,
        settled: true,
        orderId: buyResult.transaction_id,
        contractId,
        proposal,
        buyResult,
        stake: buyPrice,
        ...settlement
      }
    } catch (error) {
      return {
        ok: true,
        simulated: false,
        real: true,
        placed: true,
        settled: false,
        orderId: buyResult.transaction_id,
        contractId,
        proposal,
        buyResult,
        stake: buyPrice,
        profit: 0,
        error: `Settlement pending: ${error.message}`
      }
    }
  }

  async settleOpenTrade(trade, options = {}) {
    const contractId = Number(trade?.contractId)
    if (!Number.isFinite(contractId) || contractId <= 0) {
      throw new Error('Invalid pending trade contract id')
    }

    const stake = Number(trade?.stake ?? 0)
    const settlement = await this.settleTrade(contractId, stake, options)
    return {
      ok: true,
      simulated: false,
      real: true,
      placed: true,
      settled: true,
      orderId: trade.orderId,
      contractId,
      stake,
      ...settlement
    }
  }

  async settleTrade(contractId, buyPrice, options = {}) {
    const contract = await this.deriv.waitForContractClose(contractId, {
      timeoutMs: options.timeoutMs || 90000,
      pollIntervalMs: options.pollIntervalMs || 1000
    })

    const normalized = this.normalizeSettlement(contract, buyPrice)
    this.applySettlementStats(contractId, normalized.profit)
    return normalized
  }

  normalizeSettlement(contract, buyPrice) {
    const parsedBuyPrice = Number(contract.buy_price ?? buyPrice ?? 0)
    const payout = Number(contract.payout ?? 0)
    const sellPrice = Number(contract.sell_price ?? payout)
    const contractProfit = Number(contract.profit)

    let profit = Number.isFinite(contractProfit) ? contractProfit : (sellPrice - parsedBuyPrice)
    if (!Number.isFinite(profit)) profit = 0

    const status = String(contract.status || '').toLowerCase()
    const isWon = status === 'won' || profit > 0

    return {
      profit,
      isWon,
      status: status || 'unknown',
      payout: Number.isFinite(payout) ? payout : 0,
      sellPrice: Number.isFinite(sellPrice) ? sellPrice : 0,
      contract
    }
  }

  applySettlementStats(contractId, profit) {
    if (this.settledContracts.has(contractId)) return
    this.settledContracts.add(contractId)

    this.dailyStats.totalTrades += 1
    if (profit > 0) this.dailyStats.totalProfit += profit
    if (profit < 0) this.dailyStats.totalLoss += Math.abs(profit)
  }

  executeSimulation(position) {
    const won = Math.random() > 0.4
    const profit = won ? position.stake * 0.95 : -position.stake

    return {
      ok: true,
      simulated: true,
      real: false,
      isWon: won,
      profit,
      stake: position.stake,
      orderId: `SIM_${Date.now()}`
    }
  }

  validatePosition(position) {
    if (!position.stake || position.stake <= 0) {
      console.error('Invalid stake:', position.stake)
      return false
    }

    if (position.stake > this.config.maxStake) {
      console.error('Stake exceeds maximum:', position.stake, '>', this.config.maxStake)
      return false
    }

    if (position.prediction < 0 || position.prediction > 9) {
      console.error('Invalid prediction:', position.prediction)
      return false
    }

    return true
  }

  getDailyStats() {
    return this.dailyStats
  }

  resetDailyStats() {
    const previous = { ...this.dailyStats }
    this.dailyStats = {
      totalTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      startTime: Date.now()
    }

    console.log('Daily stats reset')
    return previous
  }
}

export default RealTradeExecutor
