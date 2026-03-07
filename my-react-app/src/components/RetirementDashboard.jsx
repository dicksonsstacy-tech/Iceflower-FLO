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

  const [health, setHealth] = useState({ ok: false, mode: 'Unknown' })
  const [config, setConfig] = useState({ appId: null })
  const [stats, setStats] = useState(defaultStats)
  const [accounts, setAccounts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [statusNote, setStatusNote] = useState('Initializing link to Iceflower core...')
  const [lastSync, setLastSync] = useState(null)
  const [actionLoading, setActionLoading] = useState(false)

  const netProfit = useMemo(
    () => Number(stats.dailyStats.totalProfit || 0) - Number(stats.dailyStats.totalLoss || 0),
    [stats]
  )

  const winRate = useMemo(() => {
    const total = Number(stats.dailyStats.totalTrades || 0)
    if (!total) return 0
    return ((Number(stats.dailyStats.wins || 0) / total) * 100).toFixed(1)
  }, [stats])

  const syncAll = async () => {
    const [healthRes, configRes, statsRes, accountsRes, alertsRes] = await Promise.allSettled([
      getJson(`${API_BASE}/api/health`, {}, token),
      getJson(`${API_BASE}/api/config`, {}, token),
      getJson(`${API_BASE}/api/retirement/stats`, {}, token),
      getJson(`${API_BASE}/api/deriv/accounts`, {}, token),
      getJson(`${API_BASE}/api/alerts/recent?limit=8`, {}, token)
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

  return (
    <section className="panel-grid">
      <article className="panel rune-panel">
        <h2>Runic Core</h2>
        <div className="metric-lg">${Number(stats.totalProfits || 0).toFixed(4)}</div>
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
          <strong>${netProfit.toFixed(4)}</strong>
        </div>
      </article>

      <article className="panel">
        <h2>Deriv Link</h2>
        <div className="stat-line"><span>App ID</span><strong>{config.appId ?? 'Not set'}</strong></div>
        <div className="stat-line"><span>Linked Accounts</span><strong>{accounts.length}</strong></div>
        {accounts[0] && (
          <>
            <div className="stat-line"><span>Login ID</span><strong>{accounts[0].loginid}</strong></div>
            <div className="stat-line"><span>Balance</span><strong>{accounts[0].currency} {accounts[0].balance}</strong></div>
          </>
        )}
        {!accounts[0] && <small>No authorized account response yet.</small>}
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
    </section>
  )
}
