// High-Profit Trading Configuration
export const tradingConfig = {
  // RETIREMENT MODE - Maximum Profit Settings
  maxStakePerTrade: 6000,        // $6,000 max per trade
  minProfitTarget: 100,          // $100 minimum profit
  maxDailyLoss: 10000,           // $10,000 daily loss limit (for big trades)
  
  // Aggressive Profit Targets
  profitTargets: {
    conservative: 100,           // $100 minimum
    moderate: 500,              // $500 target
    aggressive: 2000,            // $2,000 target
    maximum: 6000               // $6,000 maximum
  },
  
  // Dynamic Volatility Based on Profit Targets
  volatilitySettings: {
    low: {
      threshold: 0.3,
      stakeMultiplier: 0.5,
      profitTarget: 100
    },
    medium: {
      threshold: 0.6,
      stakeMultiplier: 1.0,
      profitTarget: 500
    },
    high: {
      threshold: 0.8,
      stakeMultiplier: 2.0,
      profitTarget: 2000
    },
    extreme: {
      threshold: 0.9,
      stakeMultiplier: 3.0,
      profitTarget: 6000
    }
  },
  
  // Auto-Execution Settings
  autoExecution: {
    enabled: true,
    confidenceThreshold: 0.7,    // 70% minimum confidence
    executionDelay: 0,           // Instant execution
    maxConcurrentTrades: 3,      // Multiple trades for scaling
    autoReinvest: true,          // Reinvest profits automatically
    compoundGrowth: true         // Compound profits
  },
  
  // Retirement Mode - No Learning Required
  retirementMode: {
    enabled: true,
    autoStart: true,             // Start trading automatically
    noIntervention: true,        // No manual decisions needed
    passiveIncome: true,          // Generate passive income
    wealthBuilding: true          // Build wealth automatically
  }
}
