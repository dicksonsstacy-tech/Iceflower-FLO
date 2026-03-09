import React, { useEffect, useMemo, useState } from 'react'
import { getApiBase } from '../lib/apiBase.js'

const defaultStats = {
  isRunning: false,
  totalProfits: 0,
  dailyStats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0
  },
  currentStake: 0,
  profitTarget: 0,
  volatility: 0,
  mode: 'ICEFLOWER FLO REALM'
}

async function getJson(url, options = {}, token = '') {
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { ...options, headers })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { ok: response.ok, status: response.status, data: payload }
}

export default function RetirementDashboard({ token = '' }) {
  const API_BASE = getApiBase()
  const usd = useMemo(
    () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
    []
  )
  const usdCompact = useMemo(
    () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    []
  )

  const [health, setHealth] = useState({ ok: false, mode: 'Unknown' })
  const [config, setConfig] = useState({ appId: null, tradingMode: 'real', availableModes: { demo: false, real: false } })
  const [stats, setStats] = useState(defaultStats)
  const [accounts, setAccounts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [statusNote, setStatusNote] = useState('Initializing link to Iceflower core...')
  const [lastSync, setLastSync] = useState(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [modeLoading, setModeLoading] = useState(false)
  const [riskSaving, setRiskSaving] = useState(false)
  const [stakeSwitching, setStakeSwitching] = useState(false)
  const [riskConfig, setRiskConfig] = useState({
    maxDailyLoss: 0,
    dailyProfitTarget: 0,
    stopOnAnyLoss: true,
    defaultStake: 5,
    payoutEstimate: 0.894,
    contractType: 'DIGITDIFF'
  })

  const netProfit = useMemo(
    () => Number(stats.dailyStats.totalProfit || 0) - Number(stats.dailyStats.totalLoss || 0),
    [stats]
  )

  const winRate = useMemo(() => {
    const total = Number(stats.dailyStats.totalTrades || 0)
    if (!total) return 0
    return ((Number(stats.dailyStats.wins || 0) / total) * 100).toFixed(1)
  }, [stats])

  const recentTrades = useMemo(() => Array.isArray(stats.recentTrades) ? stats.recentTrades : [], [stats.recentTrades])
  const tradeSummary = useMemo(() => {
    const totalStake = recentTrades.reduce((sum, t) => sum + Number(t.stake || 0), 0)
    const totalProfit = recentTrades.reduce((sum, t) => sum + Number(t.profit || 0), 0)
    const contractsWon = recentTrades.filter((t) => Number(t.profit || 0) > 0).length
    const contractsLost = recentTrades.filter((t) => Number(t.profit || 0) <= 0).length
    return {
      totalStake,
      totalProfit,
      totalPayout: totalStake + totalProfit,
      contractsWon,
      contractsLost,
      runs: recentTrades.length
    }
  }, [recentTrades])

  const syncAll = async () => {
    const [healthRes, configRes, statsRes, accountsRes, alertsRes, riskRes] = await Promise.allSettled([
      getJson(`${API_BASE}/api/health`, {}, token),
      getJson(`${API_BASE}/api/config`, {}, token),
      getJson(`${API_BASE}/api/retirement/stats`, {}, token),
      getJson(`${API_BASE}/api/deriv/accounts`, {}, token),
      getJson(`${API_BASE}/api/alerts/recent?limit=8`, {}, token),
      getJson(`${API_BASE}/api/admin/trading/risk-config`, {}, token)
    ])

    if (healthRes.status === 'fulfilled' && healthRes.value.ok && healthRes.value.data) setHealth(healthRes.value.data)
    if (configRes.status === 'fulfilled' && configRes.value.ok && configRes.value.data) setConfig(configRes.value.data)

    if (statsRes.status === 'fulfilled' && statsRes.value.ok && statsRes.value.data) {
      setStats((prev) => ({ ...prev, ...statsRes.value.data }))
      if (statsRes.value.data.note) {
        setStatusNote(statsRes.value.data.note)
      } else if (statsRes.value.data.isRunning) {
        setStatusNote('Start sequence is active.')
      } else {
        setStatusNote('Start sequence is idle.')
      }
    }

    if (accountsRes.status === 'fulfilled' && accountsRes.value.ok && accountsRes.value.data?.ok) {
      setAccounts(accountsRes.value.data.accounts || [])
    } else {
      setAccounts([])
    }

    if (alertsRes.status === 'fulfilled' && alertsRes.value.ok && alertsRes.value.data?.ok) {
      setAlerts(alertsRes.value.data.alerts || [])
    }
    if (riskRes.status === 'fulfilled' && riskRes.value.ok && riskRes.value.data?.ok) {
      const incoming = riskRes.value.data.config || {}
      setRiskConfig((prev) => ({
        ...prev,
        maxDailyLoss: Number(incoming.maxDailyLoss ?? prev.maxDailyLoss ?? 0),
        dailyProfitTarget: Number(incoming.dailyProfitTarget ?? prev.dailyProfitTarget ?? 0),
        stopOnAnyLoss: Boolean(incoming.stopOnAnyLoss),
        defaultStake: Number(incoming.defaultStake ?? prev.defaultStake ?? 5),
        payoutEstimate: Number(incoming.payoutEstimate ?? prev.payoutEstimate ?? 0.894),
        contractType: String(incoming.contractType ?? prev.contractType ?? 'DIGITDIFF').toUpperCase()
      }))
    } else if (configRes.status === 'fulfilled' && configRes.value.ok && configRes.value.data?.riskDefaults) {
      const incoming = configRes.value.data.riskDefaults
      setRiskConfig((prev) => ({
        ...prev,
        maxDailyLoss: Number(incoming.maxDailyLoss ?? prev.maxDailyLoss ?? 0),
        dailyProfitTarget: Number(incoming.dailyProfitTarget ?? prev.dailyProfitTarget ?? 0),
        stopOnAnyLoss: Boolean(incoming.stopOnAnyLoss)
      }))
    }
    setLastSync(new Date())
  }

  useEffect(() => {
    syncAll().catch(() => setStatusNote('Unable to load runtime data from API.'))
    const timer = setInterval(() => {
      syncAll().catch(() => setStatusNote('Sync failed. Retrying automatically.'))
    }, 4000)
    return () => clearInterval(timer)
  }, [token])

  const startTrader = async () => {
    setActionLoading(true)
    try {
      const res = await getJson(`${API_BASE}/api/retirement/start`, { method: 'POST' }, token)
      setStatusNote(res.data?.message || res.data?.error || 'Start request completed')
      await syncAll()
    } finally {
      setActionLoading(false)
    }
  }

  const stopTrader = async () => {
    setActionLoading(true)
    try {
      const res = await getJson(`${API_BASE}/api/retirement/stop`, { method: 'POST' }, token)
      setStatusNote(res.data?.message || res.data?.error || 'Stop request completed')
      await syncAll()
    } finally {
      setActionLoading(false)
    }
  }

  const switchMode = async (mode) => {
    setModeLoading(true)
    try {
      const res = await getJson(`${API_BASE}/api/deriv/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      }, token)
      setStatusNote(res.data?.message || res.data?.error || `Mode switched to ${mode}`)
      await syncAll()
    } finally {
      setModeLoading(false)
    }
  }

  const saveRiskConfig = async () => {
    setRiskSaving(true)
    try {
      const payload = {
        maxDailyLoss: Number(riskConfig.maxDailyLoss || 0),
        dailyProfitTarget: Number(riskConfig.dailyProfitTarget || 0),
        stopOnAnyLoss: Boolean(riskConfig.stopOnAnyLoss),
        defaultStake: Number(riskConfig.defaultStake || 0),
        payoutEstimate: Number(riskConfig.payoutEstimate || 0),
        contractType: String(riskConfig.contractType || 'DIGITDIFF').toUpperCase()
      }
      const res = await getJson(`${API_BASE}/api/admin/trading/risk-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, token)
      setStatusNote(res.data?.message || res.data?.error || 'Risk settings updated')
      await syncAll()
    } finally {
      setRiskSaving(false)
    }
  }

  const applyStakeSelection = async (stakeValue) => {
    const selected = Number(stakeValue)
    if (!Number.isFinite(selected) || selected <= 0) return
    setStakeSwitching(true)
    try {
      setRiskConfig((prev) => ({ ...prev, defaultStake: selected }))
      const payload = {
        defaultStake: selected,
        maxStakePerTrade: selected,
        stakeCeiling: selected
      }
      const res = await getJson(`${API_BASE}/api/admin/trading/risk-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, token)
      setStatusNote(res.data?.message || res.data?.error || `Stake switched to $${selected}`)
      await syncAll()
    } finally {
      setStakeSwitching(false)
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel rune-panel">
        <h2>Runic Core</h2>
        <div className="metric-lg">{usd.format(Number(stats.totalProfits || 0))}</div>
        <p>Total Profits</p>
        <div className="meter-wrap">
          <div
            className="meter-fill"
            style={{ width: `${Math.min(100, Math.max(0, Number(stats.volatility || 0) * 100))}%` }}
          />
        </div>
        <small>Volatility {(Number(stats.volatility || 0) * 100).toFixed(0)}%</small>
      </article>

      <article className="panel">
        <h2>Execution Stats</h2>
        <div className="stat-line"><span>Trades</span><strong>{stats.dailyStats.totalTrades || 0}</strong></div>
        <div className="stat-line"><span>Wins</span><strong>{stats.dailyStats.wins || 0}</strong></div>
        <div className="stat-line"><span>Losses</span><strong>{stats.dailyStats.losses || 0}</strong></div>
        <div className="stat-line"><span>Win Rate</span><strong>{winRate}%</strong></div>
        <div className={`stat-line ${netProfit >= 0 ? 'up' : 'down'}`}>
          <span>Net Profit</span>
          <strong>{usd.format(netProfit)}</strong>
        </div>
      </article>

      <article className="panel">
        <h2>Match Showcase</h2>
        <div className="stat-line"><span>Contract</span><strong>{String(stats.lastSignal?.contractType || riskConfig.contractType || 'DIGITDIFF')}</strong></div>
        <div className="stat-line"><span>Predicted Digit</span><strong>{stats.lastSignal?.predictedDigit ?? '-'}</strong></div>
        <div className="stat-line"><span>Market Digit (Entry)</span><strong>{stats.lastSignal?.marketDigitAtEntry ?? '-'}</strong></div>
        <div className="stat-line"><span>Actual Last Digit</span><strong>{stats.lastSignal?.actualDigit ?? '-'}</strong></div>
        <div className="stat-line"><span>Digit Matched</span><strong>{stats.lastSignal?.matched === null ? '-' : (stats.lastSignal?.matched ? 'YES' : 'NO')}</strong></div>
        <div className="stat-line"><span>Condition Met</span><strong>{stats.lastSignal?.conditionMet === null ? '-' : (stats.lastSignal?.conditionMet ? 'YES' : 'NO')}</strong></div>
        <div className="stat-line"><span>Stake</span><strong>{usdCompact.format(Number(stats.lastSignal?.stake || 0))}</strong></div>
        <div className="stat-line"><span>Expected Profit</span><strong>{usdCompact.format(Number(stats.lastSignal?.expectedProfit || 0))}</strong></div>
        <div className="stat-line"><span>Realized Profit</span><strong>{usdCompact.format(Number(stats.lastSignal?.realizedProfit || 0))}</strong></div>
      </article>

      <article className="panel">
        <h2>Deriv Link</h2>
        <div className="stat-line"><span>App ID</span><strong>{config.appId ?? 'Not set'}</strong></div>
        <div className="stat-line"><span>Mode</span><strong>{String(config.tradingMode || stats.tradingAccountMode || 'real').toUpperCase()}</strong></div>
        <div className="stat-line"><span>Linked Accounts</span><strong>{accounts.length}</strong></div>
        {accounts[0] && (
          <>
            <div className="stat-line"><span>Login ID</span><strong>{accounts[0].loginid}</strong></div>
            <div className="stat-line"><span>Balance</span><strong>{accounts[0].currency} {usdCompact.format(Number(accounts[0].balance || 0))}</strong></div>
          </>
        )}
        {!accounts[0] && <small>No authorized account response yet.</small>}
        <div className="controls" style={{ marginTop: 12 }}>
          <button
            className={`sigil-btn ${String(config.tradingMode || 'real') === 'demo' ? 'secondary' : 'primary'}`}
            disabled={modeLoading || actionLoading || !config.availableModes?.demo}
            onClick={() => switchMode('demo')}
          >
            Use Demo
          </button>
          <button
            className={`sigil-btn ${String(config.tradingMode || 'real') === 'real' ? 'secondary' : 'primary'}`}
            disabled={modeLoading || actionLoading || !config.availableModes?.real}
            onClick={() => switchMode('real')}
          >
            Use Real
          </button>
        </div>
      </article>

      <article className="panel wide">
        <h2>Risk Guard</h2>
        <div className="controls">
          <label>
            <small>Max Daily Loss (USD)</small>
            <input
              type="number"
              min="0"
              step="1"
              value={riskConfig.maxDailyLoss}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, maxDailyLoss: e.target.value }))}
            />
          </label>
          <label>
            <small>Daily Profit Target (USD)</small>
            <input
              type="number"
              min="0"
              step="1"
              value={riskConfig.dailyProfitTarget}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, dailyProfitTarget: e.target.value }))}
            />
          </label>
          <label>
            <small>Stop On Any Loss</small>
            <select
              value={riskConfig.stopOnAnyLoss ? 'true' : 'false'}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, stopOnAnyLoss: e.target.value === 'true' }))}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <label>
            <small>Contract Type</small>
            <select
              value={riskConfig.contractType}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, contractType: e.target.value }))}
            >
              <option value="DIGITMATCH">DIGITMATCH</option>
              <option value="DIGITDIFF">DIGITDIFF</option>
            </select>
          </label>
          <label>
            <small>Default Stake (USD)</small>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={riskConfig.defaultStake}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, defaultStake: e.target.value }))}
            />
          </label>
          <label>
            <small>Quick Stake Select</small>
            <select
              value={String(Number(riskConfig.defaultStake || 5))}
              disabled={stakeSwitching || actionLoading}
              onChange={(e) => applyStakeSelection(e.target.value)}
            >
              <option value="5">$5</option>
              <option value="10">$10</option>
              <option value="20">$20</option>
              <option value="50">$50</option>
            </select>
          </label>
          <label>
            <small>Payout Estimate Multiplier</small>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={riskConfig.payoutEstimate}
              onChange={(e) => setRiskConfig((prev) => ({ ...prev, payoutEstimate: e.target.value }))}
            />
          </label>
          <button className="sigil-btn primary" disabled={riskSaving || actionLoading} onClick={saveRiskConfig}>
            {riskSaving ? 'Saving...' : 'Save Risk Settings'}
          </button>
        </div>
        <p className="note">For match mode: set Contract Type to DIGITMATCH, stake to 10, and payout estimate to 7.9 for a 79 preview on a 10 stake.</p>
      </article>

      <article className="panel wide">
        <h2>Control Sigils</h2>
        <div className="controls">
          <button
            className={`sigil-btn ${stats.isRunning ? 'secondary' : 'primary'}`}
            disabled={actionLoading}
            onClick={stats.isRunning ? stopTrader : startTrader}
          >
            {stats.isRunning ? 'Halt Auto Trader' : 'Start Auto Trader 24/7'}
          </button>
        </div>
        <p className="note">{statusNote}</p>
        <p className="note">{lastSync ? `Last Sync: ${lastSync.toLocaleTimeString()}` : 'Sync pending...'}</p>
        <p className="note">{health.ok ? 'API ONLINE' : 'API OFFLINE'}</p>
      </article>

      <article className="panel wide">
        <h2>Security + Runtime Alerts</h2>
        {alerts.length === 0 && <p className="note">No alert records yet.</p>}
        {alerts.length > 0 && (
          <div className="alert-list">
            {alerts.map((alert, idx) => (
              <div key={`${alert.timestamp || idx}-${idx}`} className="alert-item">
                <span>{alert.severity || alert.level || 'info'}</span>
                <span>{alert.message || alert.type || 'Alert event'}</span>
                <span>{alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString() : '-'}</span>
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="panel wide">
        <h2>Transactions (1 Tick)</h2>
        {recentTrades.length === 0 && <p className="note">No settled trades yet.</p>}
        {recentTrades.length > 0 && (
          <>
            <div className="trade-table">
              <div className="trade-head">
                <span>Type</span>
                <span>Entry/Exit Spot</span>
                <span>Buy Price and P/L</span>
              </div>
              {recentTrades.slice(0, 10).map((trade, idx) => (
                <div className="trade-row" key={`${trade.contractId || idx}-${trade.timestamp || idx}`}>
                  <span>{trade.contractType} ({trade.prediction ?? '-'})</span>
                  <span>
                    {trade.entrySpot ?? '-'} / {trade.exitSpot ?? '-'}
                  </span>
                  <span className={Number(trade.profit || 0) >= 0 ? 'up' : 'down'}>
                    {usdCompact.format(Number(trade.stake || 0))} / {usdCompact.format(Number(trade.profit || 0))}
                  </span>
                </div>
              ))}
            </div>
            <div className="summary-grid">
              <div className="stat-line"><span>Total stake</span><strong>{usdCompact.format(tradeSummary.totalStake)}</strong></div>
              <div className="stat-line"><span>Total payout</span><strong>{usdCompact.format(tradeSummary.totalPayout)}</strong></div>
              <div className="stat-line"><span>No. of runs</span><strong>{tradeSummary.runs}</strong></div>
              <div className="stat-line"><span>Contracts lost</span><strong>{tradeSummary.contractsLost}</strong></div>
              <div className="stat-line"><span>Contracts won</span><strong>{tradeSummary.contractsWon}</strong></div>
              <div className={`stat-line ${tradeSummary.totalProfit >= 0 ? 'up' : 'down'}`}>
                <span>Total profit/loss</span>
                <strong>{usdCompact.format(tradeSummary.totalProfit)}</strong>
              </div>
            </div>
          </>
        )}
      </article>
    </section>
  )
}
