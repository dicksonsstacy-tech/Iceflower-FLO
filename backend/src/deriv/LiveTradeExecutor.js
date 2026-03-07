import DerivClient from './derivClient.js'

class LiveTradeExecutor {
  constructor(derivClient, options = {}) {
    this.deriv = derivClient
    this.config = {
      maxStake: options.maxStake || 0.5,
      maxDailyLoss: options.maxDailyLoss || 1.0,
      minProbability: options.minProbability || 0.8,
      ...options
    }
    
    this.dailyStats = {
      totalTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      startTime: Date.now()
    }
  }

  async executeLiveTrade(position) {
    try {
      console.log(`🚀 Executing LIVE trade: ${position.id.slice(-8)}`)
      
      // Validate position
      if (!this.validatePosition(position)) {
        throw new Error('Position validation failed')
      }

      // Prepare contract proposal
      const proposalOpts = {
        amount: position.stake,
        basis: 'stake',
        contract_type: this.getContractType(position),
        symbol: position.symbol || 'R_100',
        duration: position.duration || 1,
        currency: 'USD'
      }

      console.log('📋 Sending proposal:', proposalOpts)

      // Get proposal from Deriv
      const proposal = await this.deriv.proposeContract(proposalOpts, 30000) // 30 second timeout
      
      if (!proposal || !proposal.proposal_id) {
        throw new Error('Failed to get valid proposal')
      }

      console.log('✅ Proposal received:', proposal.proposal_id)

      // Execute the trade
      const buyResult = await this.deriv.buyContract(proposal.proposal_id, 30000) // 30 second timeout
      
      if (!buyResult || !buyResult.transaction_id) {
        throw new Error('Failed to execute buy')
      }

      const orderId = buyResult.transaction_id
      
      // Log successful live trade
      const tradeRecord = {
        type: 'live_trade_executed',
        position,
        orderId,
        proposal,
        buyResult,
        timestamp: Date.now(),
        status: 'executed'
      }

      console.log('Trade executed:', orderId)
      
      return {
        ok: true,
        orderId,
        simulated: false,
        proposal,
        buyResult,
        tradeRecord
      }

    } catch (error) {
      console.error('❌ Live trade execution failed:', error)
      
      // Log failed trade
      console.log('Live trade failed:', error.message)

      return {
        ok: false,
        error: error.message,
        simulated: false
      }
    }
  }

  validatePosition(position) {
    // Check stake limits
    if (position.stake > this.config.maxStake) {
      console.log(`❌ Stake too high: $${position.stake} > $${this.config.maxStake}`)
      return false
    }

    // Check probability
    if (position.profitProbability < this.config.minProbability) {
      console.log(`❌ Probability too low: ${position.profitProbability} < ${this.config.minProbability}`)
      return false
    }

    // Check daily loss limit
    if (this.dailyStats.totalLoss >= this.config.maxDailyLoss) {
      console.log(`❌ Daily loss limit reached: $${this.dailyStats.totalLoss} >= $${this.config.maxDailyLoss}`)
      return false
    }

    return true
  }

  getContractType(position) {
    // Map position prediction to Deriv contract types
    const prediction = position.prediction
    
    if (prediction >= 0 && prediction <= 9) {
      // Digit contracts - match the exact digit
      return 'DIGITMATCH'
    }
    
    // Default to rise/fall based on prediction
    return prediction >= 5 ? 'RISE' : 'FALL'
  }

  async checkTradeResult(orderId) {
    try {
      // Check the trade result from Deriv
      const result = await this.deriv.getContractInfo(orderId)
      
      if (!result) {
        throw new Error('Could not fetch contract info')
      }

      const isWon = result.status === 'won'
      const profit = isWon ? result.payout : -result.buy_price

      // Update daily stats
      this.dailyStats.totalTrades++
      if (profit > 0) {
        this.dailyStats.totalProfit += profit
      } else {
        this.dailyStats.totalLoss += Math.abs(profit)
      }

      // Log result
      const resultRecord = {
        type: 'live_trade_result',
        orderId,
        isWon,
        profit,
        payout: result.payout,
        buyPrice: result.buy_price,
        sellPrice: result.sell_price,
        contractType: result.contract_type,
        entryTick: result.entry_tick,
        exitTick: result.exit_tick,
        timestamp: Date.now(),
        dailyStats: this.dailyStats
      }

      console.log('Trade result:', isWon ? 'WON' : 'LOST', profit)

      return {
        ok: true,
        isWon,
        profit,
        result,
        dailyStats: this.dailyStats
      }

    } catch (error) {
      console.error('❌ Failed to check trade result:', error)
      
      console.log('Trade result check failed:', error.message)

      return {
        ok: false,
        error: error.message
      }
    }
  }

  getDailyStats() {
    return {
      ...this.dailyStats,
      netProfit: this.dailyStats.totalProfit - this.dailyStats.totalLoss,
      winRate: this.dailyStats.totalTrades > 0 ? 
        (this.dailyStats.totalProfit / (this.dailyStats.totalProfit + this.dailyStats.totalLoss) * 100) : 0
    }
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

export default LiveTradeExecutor
