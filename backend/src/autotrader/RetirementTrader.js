import { tradingConfig } from '../config/trading-config.js'
import RealTradeExecutor from '../deriv/RealTradeExecutor.js'

const noopLedger = {
  append: async () => {},
  getRecent: async () => [],
  getSummary: async () => ({})
}

const noopAlertManager = {
  alert: () => false,
  alertEmergencyStop: () => false,
  alertDailyLoss: () => false,
  alertConsecutiveLosses: () => false
}

export default class RetirementTrader {
  constructor(derivClient, options = {}) {
    this.deriv = derivClient
    this.config = { ...tradingConfig, ...options }
    this.mlPredictUrl = options.mlPredictUrl || process.env.ML_PREDICT_URL || 'http://localhost:8000/predict'
    this.tradeLedger = options.tradeLedger || noopLedger
    this.alertManager = options.alertManager || noopAlertManager

    this.isRunning = false
    this.positions = new Map()
    this.totalProfits = 0
    this.dailyStats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      totalLoss: 0,
      startTime: Date.now()
    }

    this.runtime = {
      startedAt: null,
      lastLoopAt: null,
      lastTradeAt: null,
      loopCount: 0,
      loopErrors: 0,
      mlFailures: 0,
      reconnectionAttempts: 0,
      skippedByRisk: 0,
      skippedByConfidence: 0
    }

    this.risk = {
      emergencyStop: false,
      emergencyReason: '',
      emergencyAt: null,
      consecutiveLosses: 0,
      maxConsecutiveLosses: Number(options.maxConsecutiveLosses || process.env.MAX_CONSECUTIVE_LOSSES || 3),
      maxPendingTradeAgeMs: Number(options.maxPendingTradeAgeMs || process.env.MAX_PENDING_TRADE_AGE_MS || 180000),
      maxConcurrentTrades: Number(options.maxConcurrentTrades || 1),
      peakEquity: 0,
      currentEquity: 0,
      maxDrawdown: 0
    }

    this.currentVolatility = 0.5
    this.profitHistory = []

    this.executor = new RealTradeExecutor(derivClient, {
      maxStake: this.config.maxStakePerTrade,
      maxDailyLoss: this.config.maxDailyLoss,
      minProbability: this.config.confidenceThreshold,
      liveTrading: true,
      allowReal: true
    })

    console.log('Iceflower FLO Realm Initialized - Institutional Mode')
    console.log(`Max Stake: $${this.config.maxStakePerTrade}`)
    console.log(`Max Daily Loss: $${this.config.maxDailyLoss}`)
  }

  start() {
    if (this.isRunning) return
    this.isRunning = true
    this.runtime.startedAt = Date.now()
    this.tradeLedger.append({ type: 'trader_started', config: this.getRiskConfigSnapshot() }).catch(() => {})
    this.autoTradeLoop()
  }

  stop(reason = 'manual_stop') {
    this.isRunning = false
    this.tradeLedger.append({ type: 'trader_stopped', reason }).catch(() => {})
  }

  emergencyStop(reason, data = {}) {
    this.risk.emergencyStop = true
    this.risk.emergencyReason = reason
    this.risk.emergencyAt = Date.now()
    this.alertManager.alertEmergencyStop?.(reason, { ...data, pending: this.positions.size })
    this.tradeLedger.append({ type: 'emergency_stop', reason, data }).catch(() => {})
    this.stop(reason)
  }

  clearEmergencyStop(actor = 'admin') {
    this.risk.emergencyStop = false
    this.risk.emergencyReason = ''
    this.risk.emergencyAt = null
    this.risk.consecutiveLosses = 0
    this.tradeLedger.append({ type: 'emergency_cleared', actor }).catch(() => {})
  }

  autoTradeLoop() {
    if (!this.isRunning) return

    setTimeout(async () => {
      await this.executeAutoTrade()
      this.autoTradeLoop()
    }, 5000)
  }

  async executeAutoTrade() {
    this.runtime.loopCount += 1
    this.runtime.lastLoopAt = Date.now()

    try {
      await this.reconcilePendingTrades()

      if (this.risk.emergencyStop) {
        this.runtime.skippedByRisk += 1
        return
      }

      const riskGate = this.checkRiskGate()
      if (!riskGate.ok) {
        this.runtime.skippedByRisk += 1
        if (riskGate.hardStop) this.emergencyStop(riskGate.reason, riskGate)
        return
      }

      const stake = this.calculateDynamicStake()
      const profitTarget = this.calculateProfitTarget(stake)
      const prediction = await this.getMarketPrediction()

      if (!prediction.ok) {
        this.runtime.mlFailures += 1
        return
      }

      if (prediction.confidence < this.config.confidenceThreshold) {
        this.runtime.skippedByConfidence += 1
        await this.tradeLedger.append({
          type: 'trade_skipped_confidence',
          confidence: prediction.confidence,
          threshold: this.config.confidenceThreshold
        })
        return
      }

      const trade = await this.executeTrade({
        stake,
        profitTarget,
        prediction: prediction.value,
        confidence: prediction.confidence,
        volatility: this.currentVolatility
      })

      if (!trade.ok) {
        await this.tradeLedger.append({ type: 'trade_execution_error', error: trade.error || 'unknown' })
        return
      }

      this.runtime.lastTradeAt = Date.now()
      await this.tradeLedger.append({
        type: 'trade_placed',
        orderId: trade.orderId,
        contractId: trade.contractId,
        stake: trade.stake,
        symbol: 'R_100',
        prediction: prediction.value,
        confidence: prediction.confidence
      })

      if (trade.settled) {
        this.trackTrade(trade)
      } else if (trade.contractId) {
        this.positions.set(trade.contractId, {
          contractId: trade.contractId,
          orderId: trade.orderId,
          stake: trade.stake,
          openedAt: Date.now()
        })
      }
    } catch (error) {
      this.runtime.loopErrors += 1
      this.alertManager.alertSystemError?.('autotrade_loop', error)
      await this.tradeLedger.append({ type: 'loop_error', error: error.message }).catch(() => {})
    }
  }

  checkRiskGate() {
    if (this.positions.size >= this.risk.maxConcurrentTrades) {
      return { ok: false, reason: 'max_concurrent_trades', hardStop: false }
    }

    if (this.dailyStats.totalLoss >= Number(this.config.maxDailyLoss || 0)) {
      this.alertManager.alertDailyLoss?.(
        this.dailyStats.totalLoss,
        Number(this.config.maxDailyLoss || 0),
        Number(this.config.maxDailyLoss || 0) > 0 ? this.dailyStats.totalLoss / Number(this.config.maxDailyLoss) : 1
      )
      return { ok: false, reason: 'daily_loss_limit_reached', hardStop: true }
    }

    if (this.risk.consecutiveLosses >= this.risk.maxConsecutiveLosses) {
      this.alertManager.alertConsecutiveLosses?.(this.risk.consecutiveLosses, this.risk.maxConsecutiveLosses)
      return { ok: false, reason: 'consecutive_loss_limit_reached', hardStop: true }
    }

    return { ok: true }
  }

  async reconcilePendingTrades() {
    if (this.positions.size === 0) return

    const now = Date.now()
    const pendingTrades = Array.from(this.positions.values())
    for (const pending of pendingTrades) {
      const ageMs = now - Number(pending.openedAt || now)
      if (ageMs > this.risk.maxPendingTradeAgeMs) {
        await this.tradeLedger.append({
          type: 'pending_trade_timeout',
          contractId: pending.contractId,
          orderId: pending.orderId,
          ageMs
        })
      }

      try {
        const settled = await this.executor.settleOpenTrade(pending, { timeoutMs: 2500, pollIntervalMs: 500 })
        if (settled?.ok && settled.settled) {
          this.trackTrade(settled)
          this.positions.delete(pending.contractId)
        }
      } catch {
        // Keep pending for next cycle if not closed yet.
      }
    }
  }

  calculateDynamicStake() {
    let stake = Number(this.config.minProfitTarget || 1)

    if (this.currentVolatility > 0.8) {
      stake = Math.min(stake * 10, 2000)
    } else if (this.currentVolatility > 0.6) {
      stake = Math.min(stake * 5, 1000)
    } else if (this.currentVolatility > 0.3) {
      stake = Math.min(stake * 2.5, 500)
    }

    const recentProfits = this.profitHistory.slice(-10)
    const avgProfit = recentProfits.reduce((sum, p) => sum + p, 0) / recentProfits.length || 0
    if (avgProfit > 0) {
      stake = Math.min(stake * 1.1, Number(this.config.maxStakePerTrade || stake))
    }

    const cap = Number(this.config.maxStakePerTrade || stake)
    return Math.max(0.35, Math.min(stake, cap))
  }

  calculateProfitTarget(stake) {
    const baseReturn = 0.95
    const minTarget = Number(this.config.minProfitTarget || 0)
    const maxTarget = Number(stake || 0) * baseReturn
    return Math.max(minTarget, maxTarget)
  }

  async getMarketPrediction() {
    try {
      const response = await fetch(this.mlPredictUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confidence: true })
      })

      if (!response.ok) {
        throw new Error(`ML service returned HTTP ${response.status}`)
      }

      const data = await response.json()
      if (!Number.isFinite(Number(data.prediction)) || !Number.isFinite(Number(data.confidence))) {
        throw new Error('ML response missing prediction/confidence')
      }

      return {
        ok: true,
        value: Number(data.prediction),
        confidence: Number(data.confidence)
      }
    } catch (error) {
      await this.tradeLedger.append({ type: 'ml_failure', error: error.message }).catch(() => {})
      return { ok: false, value: null, confidence: 0 }
    }
  }

  async executeTrade(tradeParams) {
    return await this.executor.executeLiveTrade({
      id: `retirement_${Date.now()}`,
      ...tradeParams,
      symbol: 'R_100',
      duration: 1,
      duration_unit: 't',
      contract_type: 'DIGITMATCH'
    })
  }

  trackTrade(trade) {
    this.dailyStats.totalTrades += 1

    const profit = Number(trade.profit || 0)
    if (profit > 0) {
      this.dailyStats.wins += 1
      this.dailyStats.totalProfit += profit
      this.profitHistory.push(profit)
      this.totalProfits += profit
      this.risk.consecutiveLosses = 0
    } else {
      this.dailyStats.losses += 1
      this.dailyStats.totalLoss += Math.abs(profit)
      this.risk.consecutiveLosses += 1
    }

    this.updateDrawdown(profit)
    this.updateVolatility()

    this.tradeLedger.append({
      type: 'trade_settled',
      orderId: trade.orderId,
      contractId: trade.contractId,
      stake: trade.stake,
      profit,
      status: trade.status,
      isWon: !!trade.isWon,
      pendingTrades: this.positions.size,
      risk: {
        consecutiveLosses: this.risk.consecutiveLosses,
        maxDrawdown: this.risk.maxDrawdown
      }
    }).catch(() => {})
  }

  updateDrawdown(profit) {
    this.risk.currentEquity += Number(profit || 0)
    this.risk.peakEquity = Math.max(this.risk.peakEquity, this.risk.currentEquity)
    const drawdown = this.risk.peakEquity - this.risk.currentEquity
    this.risk.maxDrawdown = Math.max(this.risk.maxDrawdown, drawdown)
  }

  updateVolatility() {
    const recentProfits = this.profitHistory.slice(-5)
    const profitVariance = this.calculateVariance(recentProfits)
    this.currentVolatility = Math.min(0.9, profitVariance / 1000)
  }

  calculateVariance(values) {
    if (values.length === 0) return 0
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length
    const squaredDiffs = values.map((val) => Math.pow(val - mean, 2))
    return squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length
  }

  getRiskConfigSnapshot() {
    return {
      maxStakePerTrade: this.config.maxStakePerTrade,
      maxDailyLoss: this.config.maxDailyLoss,
      confidenceThreshold: this.config.confidenceThreshold,
      maxConcurrentTrades: this.risk.maxConcurrentTrades,
      maxConsecutiveLosses: this.risk.maxConsecutiveLosses,
      maxPendingTradeAgeMs: this.risk.maxPendingTradeAgeMs
    }
  }

  getReadinessSnapshot() {
    const settled = this.dailyStats.totalTrades
    return {
      phase2_real_settlement: settled > 0,
      phase3_data_quality: this.runtime.mlFailures === 0,
      phase4_risk_controls: true,
      phase5_reliability_ops: this.runtime.loopErrors === 0,
      notes: {
        settledTrades: settled,
        mlFailures: this.runtime.mlFailures,
        loopErrors: this.runtime.loopErrors,
        emergencyStop: this.risk.emergencyStop
      }
    }
  }

  getRetirementStats() {
    return {
      isRunning: this.isRunning,
      totalProfits: this.totalProfits,
      dailyStats: this.dailyStats,
      currentStake: this.calculateDynamicStake(),
      profitTarget: this.calculateProfitTarget(this.calculateDynamicStake()),
      volatility: this.currentVolatility,
      pendingTrades: this.positions.size,
      runtime: this.runtime,
      risk: {
        emergencyStop: this.risk.emergencyStop,
        emergencyReason: this.risk.emergencyReason,
        emergencyAt: this.risk.emergencyAt,
        consecutiveLosses: this.risk.consecutiveLosses,
        maxConsecutiveLosses: this.risk.maxConsecutiveLosses,
        maxDrawdown: this.risk.maxDrawdown
      },
      mode: 'ICEFLOWER FLO REALM'
    }
  }
}
