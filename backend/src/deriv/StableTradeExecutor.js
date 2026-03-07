class StableTradeExecutor {
  constructor(derivClient, options = {}) {
    this.deriv = derivClient
    this.config = {
      maxStake: options.maxStake || 6000,
      maxDailyLoss: options.maxDailyLoss || 10000,
      minProbability: options.minProbability || 0.7,
      liveTrading: options.liveTrading !== false,
      ...options
    }
    
    this.dailyStats = {
      totalTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      startTime: Date.now()
    }
    
    console.log('🛡️ Stable Trade Executor Initialized')
    console.log(`💰 Max Stake: $${this.config.maxStake}`)
    console.log(`🔴 Live Trading: ${this.config.liveTrading ? 'ENABLED' : 'DISABLED'}`)
  }

  async executeLiveTrade(position) {
    try {
      console.log(`🚀 Executing trade: $${position.stake} on digit ${position.prediction}`)
      
      // Validate position
      if (!this.validatePosition(position)) {
        throw new Error('Position validation failed')
      }

      // Check if we should use simulation or real trading
      if (!this.config.liveTrading || !this.deriv?.isAuthorized) {
        console.log('🟡 Using SIMULATION mode')
        return this.executeSimulation(position)
      }

      console.log('🔴 Attempting REAL trade...')
      
      // Attempt real trade with timeout protection
      try {
        const result = await this.executeRealTrade(position)
        console.log('✅ REAL trade executed successfully')
        return result
      } catch (realTradeError) {
        console.log('❌ Real trade failed, falling back to simulation:', realTradeError.message)
        return this.executeSimulation(position)
      }

    } catch (error) {
      console.error('❌ Trade execution failed:', error.message)
      return {
        ok: false,
        error: error.message,
        simulated: true,
        fallback: true
      }
    }
  }

  async executeRealTrade(position) {
    // Prepare contract proposal
    const proposalOpts = {
      amount: position.stake,
      basis: 'stake',
      contract_type: 'DIGITMATCH',
      symbol: position.symbol || 'R_100',
      duration: position.duration || 1,
      currency: 'USD'
    }

    console.log('📋 Sending proposal:', proposalOpts)

    // Get proposal from Deriv with timeout
    const proposal = await this.withTimeout(
      this.deriv.proposeContract(proposalOpts),
      20000,
      'Proposal timeout'
    )
    
    if (!proposal || !proposal.proposal_id) {
      throw new Error('Failed to get valid proposal')
    }

    console.log('✅ Proposal received:', proposal.proposal_id)

    // Execute the trade with timeout
    const buyResult = await this.withTimeout(
      this.deriv.buyContract(proposal.proposal_id),
      20000,
      'Buy timeout'
    )
    
    if (!buyResult || !buyResult.transaction_id) {
      throw new Error('Failed to execute buy')
    }

    const orderId = buyResult.transaction_id
    
    console.log('🎯 REAL Trade executed! Order ID:', orderId)
    
    return {
      ok: true,
      orderId,
      simulated: false,
      proposal,
      buyResult,
      profit: position.stake * 0.95 // Assume 95% return for now
    }
  }

  async executeSimulation(position) {
    // Simulate trade outcome
    const won = Math.random() > 0.4 // 60% win rate for simulation
    const profit = won ? position.stake * 0.95 : -position.stake
    
    console.log(`🎮 SIMULATION: ${won ? 'WON' : 'LOST'} $${Math.abs(profit).toFixed(2)}`)
    
    return {
      ok: true,
      simulated: true,
      isWon: won,
      profit: profit,
      stake: position.stake,
      orderId: `SIM_${Date.now()}`
    }
  }

  withTimeout(promise, timeout, errorText) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(errorText || 'Timeout')), timeout)
      })
    ])
  }

  validatePosition(position) {
    if (!position.stake || position.stake <= 0) {
      console.error('❌ Invalid stake:', position.stake)
      return false
    }
    
    if (position.stake > this.config.maxStake) {
      console.error('❌ Stake exceeds maximum:', position.stake, '>', this.config.maxStake)
      return false
    }
    
    if (position.prediction < 0 || position.prediction > 9) {
      console.error('❌ Invalid prediction:', position.prediction)
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
    
    console.log('📊 Daily stats reset')
    return previous
  }
}

export default StableTradeExecutor
