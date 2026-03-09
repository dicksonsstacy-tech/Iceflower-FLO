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
      skippedByConfidence: 0,
      skippedByDigitGate: 0
    }

    this.risk = {
      emergencyStop: false,
      emergencyReason: '',
      emergencyAt: null,
      defaultStake: Number(options.defaultStake || process.env.DEFAULT_STAKE || 5),
      stakeFloor: Number(options.stakeFloor || process.env.STAKE_FLOOR || 1),
      stakeCeiling: Number(options.stakeCeiling || process.env.STAKE_CEILING || 5),
      payoutEstimate: Number(options.payoutEstimate || process.env.PAYOUT_ESTIMATE || 0.894),
      dailyProfitTarget: Number(options.dailyProfitTarget || process.env.DAILY_PROFIT_TARGET || 50),
      stopOnAnyLoss: String(options.stopOnAnyLoss ?? process.env.STOP_ON_ANY_LOSS ?? 'true').toLowerCase() === 'true',
      bulkTradesPerCycle: Number(options.bulkTradesPerCycle || process.env.BULK_TRADES_PER_CYCLE || 1),
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
    this.recentTrades = []
    this.lastSignal = {
      predictedDigit: null,
      actualDigit: null,
      matched: null,
      conditionMet: null,
      marketDigitAtEntry: null,
      contractType: String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF'),
      stake: 0,
      expectedProfit: 0,
      realizedProfit: 0,
      updatedAt: null
    }

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

      const stake = this.calculateDynamicStake({
        confidence: prediction.confidence,
        volatility: this.currentVolatility
      })
      const profitTarget = this.calculateProfitTarget(stake)
      this.lastSignal = {
        ...this.lastSignal,
        predictedDigit: Number(prediction.value),
        stake,
        expectedProfit: profitTarget,
        contractType: String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF'),
        updatedAt: Date.now()
      }

      const digitGate = await this.checkDigitEntryGate(Number(prediction.value))
      this.lastSignal = {
        ...this.lastSignal,
        marketDigitAtEntry: digitGate.marketDigit,
        conditionMet: digitGate.pass,
        updatedAt: Date.now()
      }
      if (!digitGate.pass) {
        this.runtime.skippedByDigitGate += 1
        await this.tradeLedger.append({
          type: 'trade_skipped_digit_gate',
          reason: digitGate.reason,
          predictedDigit: Number(prediction.value),
          marketDigit: digitGate.marketDigit
        })
        return
      }

      const openSlots = Math.max(0, this.risk.maxConcurrentTrades - this.positions.size)
      const tradesToRun = Math.max(1, Math.min(this.risk.bulkTradesPerCycle, openSlots || 1))

      for (let i = 0; i < tradesToRun; i++) {
        const trade = await this.executeTrade({
          stake,
          profitTarget,
          prediction: prediction.value,
          confidence: prediction.confidence,
          volatility: this.currentVolatility,
          bulkIndex: i + 1,
          bulkSize: tradesToRun
        })

        if (!trade.ok) {
          await this.tradeLedger.append({ type: 'trade_execution_error', error: trade.error || 'unknown', bulkIndex: i + 1 })
          continue
        }

        this.runtime.lastTradeAt = Date.now()
        await this.tradeLedger.append({
          type: 'trade_placed',
          orderId: trade.orderId,
          contractId: trade.contractId,
          stake: trade.stake,
          symbol: 'R_100',
          prediction: prediction.value,
          confidence: prediction.confidence,
          bulkIndex: i + 1,
          bulkSize: tradesToRun
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

    if (this.dailyStats.totalProfit >= this.risk.dailyProfitTarget) {
      return { ok: false, reason: 'daily_profit_target_reached', hardStop: true }
    }

    if (this.dailyStats.totalLoss >= Number(this.config.maxDailyLoss || 0)) {
      this.alertManager.alertDailyLoss?.(
        this.dailyStats.totalLoss,
        Number(this.config.maxDailyLoss || 0),
        Number(this.config.maxDailyLoss || 0) > 0 ? this.dailyStats.totalLoss / Number(this.config.maxDailyLoss) : 1
      )
      return { ok: false, reason: 'daily_loss_limit_reached', hardStop: true }
    }

    if (this.risk.stopOnAnyLoss && this.dailyStats.losses > 0) {
      return { ok: false, reason: 'stop_on_loss_triggered', hardStop: true }
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

  calculateDynamicStake(signal = {}) {
    const maxStake = Number(this.config.maxStakePerTrade || 5)
    const floor = Math.max(0.35, Number(this.risk.stakeFloor || 1))
    const ceiling = Math.min(maxStake, Number(this.risk.stakeCeiling || maxStake))
    const baseStake = Math.min(Math.max(Number(this.risk.defaultStake || 5), floor), ceiling)
    const confidence = Number(signal.confidence ?? this.config.confidenceThreshold ?? 0.8)
    const volatility = Number(signal.volatility ?? this.currentVolatility ?? 0.5)

    // Increase stake with confidence, reduce stake under high volatility.
    const confidenceFactor = confidence >= 0.95 ? 1.1 : confidence >= 0.9 ? 1.0 : confidence >= 0.85 ? 0.9 : 0.8
    const volatilityFactor = volatility >= 0.8 ? 0.7 : volatility >= 0.6 ? 0.85 : 1.0

    let stake = baseStake * confidenceFactor * volatilityFactor

    // After losses, bias to capital protection for next entries.
    if (this.risk.consecutiveLosses > 0) {
      stake *= 0.8
    }

    return Number(Math.min(ceiling, Math.max(floor, stake)).toFixed(2))
  }

  calculateProfitTarget(stake) {
    const payoutEstimate = Number(this.risk.payoutEstimate || 0.894)
    const estimatedWin = Number(stake || 0) * payoutEstimate
    const minTarget = Number(this.config.minProfitTarget || 0)
    return Number(Math.max(minTarget, estimatedWin).toFixed(2))
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

      const normalizedPrediction = Math.max(0, Math.min(9, Math.round(Number(data.prediction))))

      return {
        ok: true,
        value: normalizedPrediction,
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
      contract_type: String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF')
    })
  }

  trackTrade(trade) {
    this.dailyStats.totalTrades += 1

    const profit = Number(trade.profit || 0)
    const stake = Number(trade.stake || 0)
    const entrySpot = Number(trade?.contract?.entry_tick)
    const exitSpot = Number(trade?.contract?.exit_tick)
    const actualDigit = this.extractLastDigit(trade?.contract?.exit_tick ?? trade?.contract?.entry_tick)
    const predictedDigit = Number.isFinite(Number(this.lastSignal.predictedDigit))
      ? Number(this.lastSignal.predictedDigit)
      : null
    const contractType = String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF').toUpperCase()
    const matched = (predictedDigit !== null && actualDigit !== null) ? predictedDigit === actualDigit : null
    const conditionMet = contractType === 'DIGITMATCH'
      ? matched
      : contractType === 'DIGITDIFF'
        ? (matched === null ? null : !matched)
        : null

    this.lastSignal = {
      ...this.lastSignal,
      actualDigit,
      matched,
      conditionMet,
      realizedProfit: Number(profit.toFixed(2)),
      contractType,
      updatedAt: Date.now()
    }

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
      if (this.risk.stopOnAnyLoss) {
        this.emergencyStop('loss_detected', { orderId: trade.orderId, contractId: trade.contractId, profit })
      }
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

    const tradeRecord = {
      timestamp: Date.now(),
      contractType,
      prediction: predictedDigit,
      marketDigitAtEntry: this.lastSignal.marketDigitAtEntry,
      actualDigit,
      matched,
      conditionMet,
      entrySpot: Number.isFinite(entrySpot) ? entrySpot : null,
      exitSpot: Number.isFinite(exitSpot) ? exitSpot : null,
      stake: Number.isFinite(stake) ? Number(stake.toFixed(2)) : 0,
      profit: Number(profit.toFixed(2)),
      won: profit > 0,
      orderId: trade.orderId || null,
      contractId: trade.contractId || null
    }
    this.recentTrades.unshift(tradeRecord)
    if (this.recentTrades.length > 30) this.recentTrades.length = 30
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

  async checkDigitEntryGate(predictedDigit) {
    const contractType = String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF').toUpperCase()
    if (!this.deriv?.getLatestTick) {
      return { pass: true, marketDigit: null, reason: 'no_tick_client' }
    }

    try {
      const tick = await this.deriv.getLatestTick('R_100', 4000)
      const marketDigit = this.extractLastDigit(tick?.quote)
      if (marketDigit === null) {
        return { pass: false, marketDigit: null, reason: 'invalid_market_digit' }
      }

      if (contractType === 'DIGITMATCH') {
        return {
          pass: marketDigit === predictedDigit,
          marketDigit,
          reason: marketDigit === predictedDigit ? 'digit_match_ok' : 'digit_match_not_ready'
        }
      }

      if (contractType === 'DIGITDIFF') {
        return {
          pass: marketDigit !== predictedDigit,
          marketDigit,
          reason: marketDigit !== predictedDigit ? 'digit_diff_ok' : 'digit_diff_not_ready'
        }
      }

      return { pass: true, marketDigit, reason: 'contract_type_not_gated' }
    } catch (error) {
      return { pass: false, marketDigit: null, reason: `tick_error_${error.message}` }
    }
  }

  extractLastDigit(value) {
    if (value === null || value === undefined) return null
    const normalized = String(value).replace(/[^0-9]/g, '')
    if (!normalized) return null
    const lastChar = normalized[normalized.length - 1]
    const parsed = Number(lastChar)
    return Number.isFinite(parsed) ? parsed : null
  }

  getRiskConfigSnapshot() {
    return {
      maxStakePerTrade: this.config.maxStakePerTrade,
      defaultStake: this.risk.defaultStake,
      stakeFloor: this.risk.stakeFloor,
      stakeCeiling: this.risk.stakeCeiling,
      payoutEstimate: this.risk.payoutEstimate,
      maxDailyLoss: this.config.maxDailyLoss,
      dailyProfitTarget: this.risk.dailyProfitTarget,
      stopOnAnyLoss: this.risk.stopOnAnyLoss,
      confidenceThreshold: this.config.confidenceThreshold,
      maxConcurrentTrades: this.risk.maxConcurrentTrades,
      bulkTradesPerCycle: this.risk.bulkTradesPerCycle,
      maxConsecutiveLosses: this.risk.maxConsecutiveLosses,
      maxPendingTradeAgeMs: this.risk.maxPendingTradeAgeMs,
      contractType: String(this.config.contractType || process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF').toUpperCase()
    }
  }

  updateRiskConfig(next = {}, actor = 'admin') {
    const parsePositive = (value, fallback) => {
      const n = Number(value)
      return Number.isFinite(n) && n > 0 ? n : fallback
    }
    const parseNonNegative = (value, fallback) => {
      const n = Number(value)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }

    this.config.maxStakePerTrade = parsePositive(next.maxStakePerTrade, this.config.maxStakePerTrade)
    this.config.minProfitTarget = parseNonNegative(next.minProfitTarget, this.config.minProfitTarget)
    this.config.maxDailyLoss = parseNonNegative(next.maxDailyLoss, this.config.maxDailyLoss)
    if (typeof next.contractType === 'string' && next.contractType.trim()) {
      this.config.contractType = next.contractType.trim().toUpperCase()
    }
    this.config.confidenceThreshold = Number.isFinite(Number(next.confidenceThreshold))
      ? Math.max(0, Math.min(1, Number(next.confidenceThreshold)))
      : this.config.confidenceThreshold

    this.risk.defaultStake = parsePositive(next.defaultStake, this.risk.defaultStake)
    this.risk.stakeFloor = parsePositive(next.stakeFloor, this.risk.stakeFloor)
    this.risk.stakeCeiling = parsePositive(next.stakeCeiling, this.risk.stakeCeiling)
    this.risk.payoutEstimate = parseNonNegative(next.payoutEstimate, this.risk.payoutEstimate)
    this.risk.dailyProfitTarget = parseNonNegative(next.dailyProfitTarget, this.risk.dailyProfitTarget)
    this.risk.stopOnAnyLoss = typeof next.stopOnAnyLoss === 'boolean' ? next.stopOnAnyLoss : this.risk.stopOnAnyLoss
    this.risk.maxConsecutiveLosses = parsePositive(next.maxConsecutiveLosses, this.risk.maxConsecutiveLosses)
    this.risk.maxPendingTradeAgeMs = parsePositive(next.maxPendingTradeAgeMs, this.risk.maxPendingTradeAgeMs)
    this.risk.maxConcurrentTrades = parsePositive(next.maxConcurrentTrades, this.risk.maxConcurrentTrades)
    this.risk.bulkTradesPerCycle = parsePositive(next.bulkTradesPerCycle, this.risk.bulkTradesPerCycle)

    if (this.risk.stakeFloor > this.risk.stakeCeiling) {
      this.risk.stakeFloor = this.risk.stakeCeiling
    }
    if (this.risk.defaultStake < this.risk.stakeFloor) {
      this.risk.defaultStake = this.risk.stakeFloor
    }
    if (this.risk.defaultStake > this.risk.stakeCeiling) {
      this.risk.defaultStake = this.risk.stakeCeiling
    }

    if (this.executor?.config) {
      this.executor.config.maxStake = this.config.maxStakePerTrade
      this.executor.config.maxDailyLoss = this.config.maxDailyLoss
      this.executor.config.minProbability = this.config.confidenceThreshold
    }

    this.tradeLedger.append({
      type: 'risk_config_updated',
      actor,
      config: this.getRiskConfigSnapshot()
    }).catch(() => {})

    return this.getRiskConfigSnapshot()
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
    const currentStake = this.calculateDynamicStake()
    return {
      isRunning: this.isRunning,
      totalProfits: this.totalProfits,
      dailyStats: this.dailyStats,
      currentStake,
      profitTarget: this.calculateProfitTarget(currentStake),
      expectedProfitPerWin: Number((currentStake * Number(this.risk.payoutEstimate || 0.894)).toFixed(2)),
      volatility: this.currentVolatility,
      pendingTrades: this.positions.size,
      runtime: this.runtime,
      risk: {
        emergencyStop: this.risk.emergencyStop,
        emergencyReason: this.risk.emergencyReason,
        emergencyAt: this.risk.emergencyAt,
        maxDailyLoss: this.config.maxDailyLoss,
        dailyProfitTarget: this.risk.dailyProfitTarget,
        stopOnAnyLoss: this.risk.stopOnAnyLoss,
        bulkTradesPerCycle: this.risk.bulkTradesPerCycle,
        consecutiveLosses: this.risk.consecutiveLosses,
        maxConsecutiveLosses: this.risk.maxConsecutiveLosses,
        maxDrawdown: this.risk.maxDrawdown
      },
      recentTrades: this.recentTrades,
      lastSignal: this.lastSignal,
      mode: 'ICEFLOWER FLO REALM'
    }
  }
}
