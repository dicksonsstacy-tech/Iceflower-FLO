import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import http from 'http'
import crypto from 'crypto'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Server as SocketIO } from 'socket.io'
import FixedDerivClient from './deriv/FixedDerivClient.js'
import RetirementTrader from './autotrader/RetirementTrader.js'
import AlertManager from './logging/AlertManager.js'
import TradeLedger from './logging/TradeLedger.js'

dotenv.config({ override: true })

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../data')
const RENDER_DATA_DIR = '/data'
const DATA_DIR = process.env.DATA_DIR
  || (existsSync(RENDER_DATA_DIR) ? RENDER_DATA_DIR : DEFAULT_DATA_DIR)
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const ADMIN_SESSIONS_FILE = path.join(DATA_DIR, 'admin-sessions.json')
const TRADE_LEDGER_FILE = process.env.TRADE_LEDGER_PATH || path.join(DATA_DIR, 'trade-ledger.ndjson')
const FRONTEND_DIST_DIR = path.resolve(__dirname, '../public')
const HAS_FRONTEND_DIST = existsSync(path.join(FRONTEND_DIST_DIR, 'index.html'))

const app = express()
app.use(express.json())
if (HAS_FRONTEND_DIST) {
  app.use(express.static(FRONTEND_DIST_DIR))
}

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true'
const DERIV_APP_ID = process.env.DERIV_APP_ID
const DERIV_TOKEN_REAL = process.env.DERIV_TOKEN_REAL || ''
const DERIV_TOKEN_DEMO = process.env.DERIV_TOKEN_DEMO || ''
const DERIV_TOKEN = process.env.DERIV_TOKEN || DERIV_TOKEN_REAL || DERIV_TOKEN_DEMO || ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const AUTO_START_TRADER = String(process.env.AUTO_START_TRADER || '').toLowerCase() === 'true'
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

function numberFromEnv(name, fallback) {
  const raw = process.env[name]
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const traderDefaults = {
  maxStakePerTrade: numberFromEnv('MAX_STAKE_PER_TRADE', 1),
  minProfitTarget: numberFromEnv('MIN_PROFIT_TARGET', 0.02),
  defaultStake: numberFromEnv('DEFAULT_STAKE', 5),
  stakeFloor: numberFromEnv('STAKE_FLOOR', 1),
  stakeCeiling: numberFromEnv('STAKE_CEILING', 5),
  payoutEstimate: numberFromEnv('PAYOUT_ESTIMATE', 0.894),
  maxDailyLoss: numberFromEnv('MAX_DAILY_LOSS', 0.2),
  dailyProfitTarget: numberFromEnv('DAILY_PROFIT_TARGET', 50),
  confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', 0.8),
  maxConcurrentTrades: numberFromEnv('MAX_CONCURRENT_TRADES', 1),
  bulkTradesPerCycle: numberFromEnv('BULK_TRADES_PER_CYCLE', 1),
  stopOnAnyLoss: String(process.env.STOP_ON_ANY_LOSS || 'true').toLowerCase() === 'true',
  maxConsecutiveLosses: numberFromEnv('MAX_CONSECUTIVE_LOSSES', 3),
  maxPendingTradeAgeMs: numberFromEnv('MAX_PENDING_TRADE_AGE_MS', 180000),
  contractType: String(process.env.DERIV_CONTRACT_TYPE || 'DIGITDIFF').trim().toUpperCase()
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (CORS_ORIGINS.length === 0) return callback(null, true)
    if (CORS_ORIGINS.includes(origin)) return callback(null, true)
    return callback(new Error('CORS origin denied'))
  }
}))

const alertManager = new AlertManager({
  dailyLossWarningThreshold: 0.5,
  dailyLossCriticalThreshold: 0.8,
  consecutiveLossesThreshold: 2,
  enableConsoleAlerts: true,
  enableFileAlerts: false,
  enableSocketAlerts: !isVercel
})
const tradeLedger = new TradeLedger(TRADE_LEDGER_FILE)

let retirementTrader = null
let deriv = null
let derivMode = null

function normalizeTradingMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase()
  if (normalized === 'demo' || normalized === 'virtual') return 'demo'
  if (normalized === 'real' || normalized === 'live') return 'real'
  return null
}

const modeFromEnv = normalizeTradingMode(process.env.ACTIVE_TRADING_MODE)
let activeTradingMode = modeFromEnv
  || (DERIV_TOKEN_DEMO ? 'demo' : null)
  || (DERIV_TOKEN_REAL || DERIV_TOKEN ? 'real' : null)
  || 'real'

function getTokenForMode(mode = activeTradingMode) {
  const resolvedMode = normalizeTradingMode(mode) || activeTradingMode
  if (resolvedMode === 'demo') return DERIV_TOKEN_DEMO || ''
  return DERIV_TOKEN_REAL || DERIV_TOKEN || ''
}

function getDerivCredentials(mode = activeTradingMode) {
  const resolvedMode = normalizeTradingMode(mode) || activeTradingMode
  return {
    appId: DERIV_APP_ID,
    token: getTokenForMode(resolvedMode),
    mode: resolvedMode
  }
}

function hasDerivCredentials(mode = activeTradingMode) {
  const creds = getDerivCredentials(mode)
  return Boolean(creds.appId && creds.token)
}

async function ensureDerivClient(mode = activeTradingMode, { forceReconnect = false } = {}) {
  const creds = getDerivCredentials(mode)
  if (!creds.appId || !creds.token) {
    return { ok: false, error: `Missing Deriv credentials for mode: ${creds.mode}` }
  }

  if (forceReconnect || !deriv || derivMode !== creds.mode) {
    if (deriv) {
      try { deriv.close() } catch {}
    }
    deriv = new FixedDerivClient({ token: creds.token, appId: creds.appId })
    derivMode = creds.mode
  }

  if (!deriv.connected || !deriv.authorized) {
    try {
      await deriv.connect()
    } catch (err) {
      return { ok: false, error: err.message || 'Failed to connect Deriv client' }
    }
  }

  return { ok: true, client: deriv, mode: derivMode }
}

const adminSessions = new Map()
const loginAttempts = new Map()

async function ensureSessionStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    await fs.access(ADMIN_SESSIONS_FILE)
  } catch {
    await fs.writeFile(ADMIN_SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf8')
  }
}

function pruneExpiredAdminSessions() {
  const now = Date.now()
  let removed = 0
  for (const [token, session] of adminSessions.entries()) {
    if (!session?.expiresAt || now > session.expiresAt) {
      adminSessions.delete(token)
      removed += 1
    }
  }
  return removed
}

async function persistAdminSessions() {
  await ensureSessionStore()
  const data = Object.fromEntries(adminSessions.entries())
  await fs.writeFile(ADMIN_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8')
}

async function loadAdminSessions() {
  try {
    await ensureSessionStore()
    const raw = await fs.readFile(ADMIN_SESSIONS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [token, session] of Object.entries(parsed)) {
        if (!session?.expiresAt || Date.now() > session.expiresAt) continue
        adminSessions.set(token, session)
      }
    }
    pruneExpiredAdminSessions()
    await persistAdminSessions()
  } catch (error) {
    console.error('Failed to load session database:', error.message)
  }
}

const serverlessCalcState = {
  isRunning: false,
  totalProfits: 0,
  dailyStats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0
  },
  currentStake: 0.19,
  profitTarget: 0.01,
  volatility: 0.2,
  mode: 'ICEFLOWER FLO REALM',
  note: 'Calculation mode (serverless). For always-on auto-trading use a persistent backend host.'
}

if (hasDerivCredentials(activeTradingMode)) {
  ensureDerivClient(activeTradingMode)
    .then(() => {
      console.log(`Deriv client connected and ready (${activeTradingMode})`)
    })
    .catch((err) => {
      console.error('Deriv connection failed:', err.message)
    })
}

let server = null
if (!isVercel) {
  server = http.createServer(app)
  const io = new SocketIO(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  })
  alertManager.configureSocket(io)
}

function getRuntimeBaseUrl(req) {
  const explicitBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL
  if (explicitBase) return explicitBase.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (req?.headers?.host) {
    const proto = req.headers['x-forwarded-proto'] || 'http'
    return `${proto}://${req.headers.host}`
  }
  return 'http://localhost:4000'
}

function getTraderConfig(req) {
  const defaultMlUrl = `${getRuntimeBaseUrl(req)}/api/predict`
  return {
    ...traderDefaults,
    mlPredictUrl: process.env.ML_PREDICT_URL || defaultMlUrl,
    alertManager,
    tradeLedger
  }
}

async function startRetirementSequence(req) {
  if (isVercel) {
    serverlessCalcState.isRunning = true
    serverlessCalcState.note = 'Calculation started on serverless mode.'
    alertManager.alert('calc_started', 'Serverless calculation sequence started', 'info', {
      stake: serverlessCalcState.currentStake
    })
    return {
      ok: true,
      message: 'Calculation sequence started',
      mode: 'serverless-calculation'
    }
  }

  if (retirementTrader && retirementTrader.isRunning) {
    return { ok: false, status: 400, error: 'Retirement trader is already running' }
  }

  if (!hasDerivCredentials(activeTradingMode)) {
    return { ok: false, status: 400, error: `Deriv credentials are missing for mode: ${activeTradingMode}` }
  }

  const clientReady = await ensureDerivClient(activeTradingMode)
  if (!clientReady.ok) {
    return { ok: false, status: 400, error: clientReady.error || 'Failed to initialize Deriv client' }
  }

  const derivReady = await deriv.validateOnce(10000)
  if (!derivReady.ok || !derivReady.authorized) {
    return {
      ok: false,
      status: 400,
      error: derivReady.error || 'Deriv authorization failed while starting live trading'
    }
  }

  const runtimeConfig = getTraderConfig(req)
  retirementTrader = new RetirementTrader(deriv, runtimeConfig)
  retirementTrader.start()

  return {
    ok: true,
    message: 'ICEFLOWER FLO REALM ACTIVATED - automated execution started',
    config: {
      maxStake: runtimeConfig.maxStakePerTrade,
      defaultStake: runtimeConfig.defaultStake,
      stakeFloor: runtimeConfig.stakeFloor,
      stakeCeiling: runtimeConfig.stakeCeiling,
      payoutEstimate: runtimeConfig.payoutEstimate,
      minProfit: runtimeConfig.minProfitTarget,
      maxDailyLoss: runtimeConfig.maxDailyLoss,
      dailyProfitTarget: runtimeConfig.dailyProfitTarget,
      confidenceThreshold: runtimeConfig.confidenceThreshold,
      maxConcurrentTrades: runtimeConfig.maxConcurrentTrades,
      bulkTradesPerCycle: runtimeConfig.bulkTradesPerCycle,
      stopOnAnyLoss: runtimeConfig.stopOnAnyLoss,
      mode: 'ICEFLOWER FLO REALM',
      tradingAccountMode: activeTradingMode
    }
  }
}

async function ensureUserStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    await fs.access(USERS_FILE)
  } catch {
    const bootstrapUsers = [
      {
        id: crypto.randomUUID(),
        username: 'admin',
        role: 'owner',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
    await fs.writeFile(USERS_FILE, JSON.stringify(bootstrapUsers, null, 2), 'utf8')
  }
}

async function readUsers() {
  await ensureUserStore()
  const raw = await fs.readFile(USERS_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8')
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

function extractAdminToken(req) {
  const authHeader = req.headers.authorization || ''
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim()
  const alt = req.headers['x-admin-token']
  if (typeof alt === 'string' && alt.trim()) return alt.trim()
  return ''
}

async function createSession(payload) {
  const token = crypto.randomBytes(24).toString('hex')
  adminSessions.set(token, {
    ...payload,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  })
  await persistAdminSessions()
  return token
}

function requireAdmin(req, res, next) {
  pruneExpiredAdminSessions()
  const token = extractAdminToken(req)
  const ip = getClientIp(req)
  const session = token ? adminSessions.get(token) : null

  if (!session) {
    alertManager.alert('tamper_admin_unauthorized', 'Unauthorized admin endpoint attempt', 'warning', {
      path: req.path,
      method: req.method,
      ip
    })
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token)
    persistAdminSessions().catch(() => {})
    alertManager.alert('tamper_expired_session', 'Expired admin session used', 'warning', {
      path: req.path,
      method: req.method,
      ip,
      username: session.username
    })
    return res.status(401).json({ ok: false, error: 'Session expired' })
  }

  req.adminSession = session
  req.adminToken = token
  return next()
}

function trackLoginFailure(ip) {
  const now = Date.now()
  const attempts = loginAttempts.get(ip) || []
  const recent = attempts.filter((ts) => now - ts < 10 * 60 * 1000)
  recent.push(now)
  loginAttempts.set(ip, recent)
  return recent.length
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip)
}

app.use((req, res, next) => {
  const suspiciousPattern = /(\.\.\/|%2e%2e|<script|%3cscript|union\s+select|wp-admin|\/\.env|etc\/passwd)/i
  if (suspiciousPattern.test(req.originalUrl || '')) {
    alertManager.alert('tamper_probe', 'Suspicious request pattern detected', 'critical', {
      url: req.originalUrl,
      method: req.method,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || 'unknown'
    })
  }
  next()
})

app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'ICEFLOWER FLO REALM' }))

app.get('/', (req, res) => {
  if (HAS_FRONTEND_DIST) {
    return res.sendFile(path.join(FRONTEND_DIST_DIR, 'index.html'))
  }
  return res.status(200).send('Iceflower FLO backend is running. Use /api/health for status.')
})

app.get('/api/config', (req, res) => {
  return res.json({
    appId: DERIV_APP_ID ? Number(DERIV_APP_ID) : null,
    tradingMode: activeTradingMode,
    availableModes: {
      demo: Boolean(DERIV_TOKEN_DEMO),
      real: Boolean(DERIV_TOKEN_REAL || DERIV_TOKEN)
    },
    riskDefaults: {
      maxDailyLoss: traderDefaults.maxDailyLoss,
      dailyProfitTarget: traderDefaults.dailyProfitTarget,
      stopOnAnyLoss: traderDefaults.stopOnAnyLoss
    }
  })
})

app.get('/api/deriv/mode', (req, res) => {
  return res.json({
    ok: true,
    mode: activeTradingMode,
    availableModes: {
      demo: Boolean(DERIV_TOKEN_DEMO),
      real: Boolean(DERIV_TOKEN_REAL || DERIV_TOKEN)
    }
  })
})

app.post('/api/deriv/mode', requireAdmin, async (req, res) => {
  const requestedMode = normalizeTradingMode(req.body?.mode)
  if (!requestedMode) {
    return res.status(400).json({ ok: false, error: 'mode must be either demo or real' })
  }
  if (!hasDerivCredentials(requestedMode)) {
    return res.status(400).json({ ok: false, error: `No credentials configured for mode: ${requestedMode}` })
  }
  if (retirementTrader?.isRunning && requestedMode !== activeTradingMode) {
    return res.status(409).json({ ok: false, error: 'Stop the trader before switching account mode' })
  }

  activeTradingMode = requestedMode
  const ready = await ensureDerivClient(activeTradingMode, { forceReconnect: true })
  if (!ready.ok) {
    return res.status(400).json({ ok: false, error: ready.error || 'Failed to switch Deriv mode' })
  }

  const validation = await deriv.validateOnce(8000)
  if (!validation.ok || !validation.authorized) {
    return res.status(400).json({ ok: false, error: validation.error || 'Deriv authorization failed for requested mode' })
  }

  return res.json({
    ok: true,
    mode: activeTradingMode,
    account: validation.accountInfo || null
  })
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const password = String(req.body?.password || '').trim()
    const configuredPassword = String(ADMIN_PASSWORD || '').trim()
    const ip = getClientIp(req)

    if (!configuredPassword) {
      return res.status(503).json({ ok: false, err: 'ADMIN_PASSWORD is not configured' })
    }

    if (!password || password !== configuredPassword) {
      const failCount = trackLoginFailure(ip)
      alertManager.alert('auth_failed', 'Failed admin login attempt', failCount >= 4 ? 'critical' : 'warning', {
        ip,
        attemptsInWindow: failCount
      })
      return res.status(401).json({ ok: false, err: 'Invalid credentials' })
    }

    clearLoginFailures(ip)
    const users = await readUsers()
    const primaryUser = users.find((u) => u.status === 'active') || users[0] || {
      id: 'unknown',
      username: 'admin',
      role: 'owner',
      status: 'active'
    }
    const token = await createSession({
      userId: primaryUser.id,
      username: primaryUser.username,
      role: primaryUser.role
    })

    alertManager.alert('auth_success', 'Admin login successful', 'info', {
      ip,
      username: primaryUser.username
    })

    return res.json({
      ok: true,
      token,
      user: {
        id: primaryUser.id,
        username: primaryUser.username,
        role: primaryUser.role
      }
    })
  } catch (error) {
    return res.status(500).json({ ok: false, err: error.message })
  }
})

app.get('/api/auth/me', requireAdmin, (req, res) => {
  return res.json({
    ok: true,
    user: {
      id: req.adminSession.userId,
      username: req.adminSession.username,
      role: req.adminSession.role
    }
  })
})

app.post('/api/auth/logout', requireAdmin, async (req, res) => {
  adminSessions.delete(req.adminToken)
  await persistAdminSessions()
  return res.json({ ok: true })
})

app.post('/api/auth/logout-all', requireAdmin, async (req, res) => {
  const actor = req.adminSession?.username || 'admin'
  const activeCount = adminSessions.size
  adminSessions.clear()
  await persistAdminSessions()
  alertManager.alert('auth_logout_all', 'All admin sessions were terminated', 'warning', {
    actor,
    activeSessionsBeforeClear: activeCount
  })
  return res.json({ ok: true, message: 'All sessions logged out', cleared: activeCount })
})

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await readUsers()
    return res.json({ ok: true, users })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim()
    const role = String(req.body?.role || 'viewer').trim()
    if (!username) return res.status(400).json({ ok: false, error: 'username is required' })

    const users = await readUsers()
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ ok: false, error: 'username already exists' })
    }

    const user = {
      id: crypto.randomUUID(),
      username,
      role,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    users.push(user)
    await writeUsers(users)

    alertManager.alert('admin_user_created', 'Admin created user', 'info', {
      actor: req.adminSession.username,
      username: user.username,
      role: user.role
    })

    return res.json({ ok: true, user })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const users = await readUsers()
    const idx = users.findIndex((u) => u.id === id)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'user not found' })

    const role = req.body?.role ? String(req.body.role).trim() : users[idx].role
    const status = req.body?.status ? String(req.body.status).trim() : users[idx].status
    users[idx] = {
      ...users[idx],
      role,
      status,
      updatedAt: Date.now()
    }
    await writeUsers(users)

    alertManager.alert('admin_user_updated', 'Admin updated user', 'warning', {
      actor: req.adminSession.username,
      username: users[idx].username,
      role: users[idx].role,
      status: users[idx].status
    })

    return res.json({ ok: true, user: users[idx] })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const users = await readUsers()
    const target = users.find((u) => u.id === id)
    if (!target) return res.status(404).json({ ok: false, error: 'user not found' })

    const nextUsers = users.filter((u) => u.id !== id)
    await writeUsers(nextUsers)

    alertManager.alert('admin_user_deleted', 'Admin deleted user', 'critical', {
      actor: req.adminSession.username,
      username: target.username
    })

    return res.json({ ok: true })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/predict', async (req, res) => {
  const fallbackFromTick = async (reason = 'ml_unavailable') => {
    try {
      const ensured = await ensureDerivClient(activeTradingMode)
      if (!ensured.ok) throw new Error(ensured.error || 'deriv_client_unavailable')
      const ready = await deriv.validateOnce(5000)
      if (!ready.ok || !ready.authorized) {
        throw new Error(ready.error || 'deriv_not_authorized')
      }

      const tick = await deriv.getLatestTick('R_100', 8000)
      const quote = Number(tick?.quote)
      if (!Number.isFinite(quote)) throw new Error('invalid_tick_quote')

      const prediction = Math.floor(Math.abs(quote)) % 10
      const confidence = 0.82
      return res.json({
        ok: true,
        prediction,
        confidence,
        source: 'deriv_tick_fallback',
        reason,
        quote
      })
    } catch (fallbackError) {
      const now = Date.now()
      const prediction = Math.floor((now / 1000) % 10)
      return res.json({
        ok: true,
        prediction,
        confidence: 0.8,
        source: 'time_fallback',
        reason: `${reason};deriv_fallback_error_${fallbackError.message}`
      })
    }
  }

  try {
    const mlPredictUrl = process.env.ML_PREDICT_URL || 'http://127.0.0.1:8000/predict'
    if (mlPredictUrl.includes('/api/predict')) {
      return await fallbackFromTick('ml_url_self_reference')
    }
    const response = await fetch(mlPredictUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload) {
      return await fallbackFromTick(`ml_http_${response.status}`)
    }

    return res.json(payload)
  } catch (error) {
    return await fallbackFromTick(`ml_fetch_error_${error.message}`)
  }
})

app.get('/api/alerts/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50
    const alerts = alertManager.getRecentAlerts(limit)
    return res.json({ ok: true, alerts })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/alerts/stats', (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24
    const stats = alertManager.getAlertStats(hours)
    return res.json({ ok: true, stats })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/alerts/test', (req, res) => {
  try {
    const sent = alertManager.testAlert()
    return res.json({ ok: true, sent })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/trading/audit', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100
    const events = await tradeLedger.getRecent(limit)
    return res.json({ ok: true, events })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/trading/summary', requireAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24
    const summary = await tradeLedger.getSummary(hours)
    return res.json({ ok: true, summary })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/trading/risk-config', requireAdmin, (req, res) => {
  const current = retirementTrader?.getRiskConfigSnapshot?.() || {
    maxStakePerTrade: traderDefaults.maxStakePerTrade,
    defaultStake: traderDefaults.defaultStake,
    stakeFloor: traderDefaults.stakeFloor,
    stakeCeiling: traderDefaults.stakeCeiling,
    payoutEstimate: traderDefaults.payoutEstimate,
    maxDailyLoss: traderDefaults.maxDailyLoss,
    dailyProfitTarget: traderDefaults.dailyProfitTarget,
    stopOnAnyLoss: traderDefaults.stopOnAnyLoss,
    confidenceThreshold: traderDefaults.confidenceThreshold,
    maxConcurrentTrades: traderDefaults.maxConcurrentTrades,
    bulkTradesPerCycle: traderDefaults.bulkTradesPerCycle,
    maxConsecutiveLosses: traderDefaults.maxConsecutiveLosses,
    maxPendingTradeAgeMs: traderDefaults.maxPendingTradeAgeMs
  }
  return res.json({ ok: true, config: current, tradingAccountMode: activeTradingMode })
})

app.patch('/api/admin/trading/risk-config', requireAdmin, (req, res) => {
  if (!retirementTrader) {
    return res.status(400).json({ ok: false, error: 'Retirement trader not initialized. Start trader first.' })
  }

  const updated = retirementTrader.updateRiskConfig(req.body || {}, req.adminSession.username)
  return res.json({
    ok: true,
    message: 'Risk configuration updated',
    config: updated
  })
})

app.get('/api/admin/trading/readiness', requireAdmin, async (req, res) => {
  try {
    const summary = await tradeLedger.getSummary(24)
    const snapshot = retirementTrader?.getReadinessSnapshot?.() || {
      phase2_real_settlement: false,
      phase3_data_quality: false,
      phase4_risk_controls: true,
      phase5_reliability_ops: false,
      notes: { reason: 'trader_not_started' }
    }

    return res.json({
      ok: true,
      generatedAt: Date.now(),
      phases: {
        phase2: {
          name: 'Real execution settlement and realized PnL',
          status: snapshot.phase2_real_settlement ? 'ready' : 'in_progress'
        },
        phase3: {
          name: 'Data quality, model confidence, and measurable edge',
          status: snapshot.phase3_data_quality ? 'ready' : 'in_progress'
        },
        phase4: {
          name: 'Risk governance and emergency controls',
          status: snapshot.phase4_risk_controls ? 'ready' : 'in_progress'
        },
        phase5: {
          name: 'Reliability, monitoring, and operational resilience',
          status: snapshot.phase5_reliability_ops ? 'ready' : 'in_progress'
        }
      },
      evidence: {
        summary24h: summary,
        runtime: retirementTrader?.getRetirementStats?.()?.runtime || null,
        risk: retirementTrader?.getRetirementStats?.()?.risk || null,
        notes: snapshot.notes
      }
    })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/trading/offer-pack', requireAdmin, async (req, res) => {
  try {
    const summary24h = await tradeLedger.getSummary(24)
    const summary168h = await tradeLedger.getSummary(168)
    const stats = retirementTrader?.getRetirementStats?.() || null
    return res.json({
      ok: true,
      generatedAt: Date.now(),
      offer: {
        title: 'Iceflower FLO - Controlled Autonomy Trading Engine',
        proposition: 'A risk-governed Deriv-native automation layer with auditable lifecycle tracking and operational controls.',
        uniqueness: [
          'Realized PnL only from settled contracts (no synthetic profit assumptions).',
          'Persistent tamper-evident NDJSON audit trail for every trade lifecycle event.',
          'Built-in emergency stop, consecutive-loss breaker, and pending-trade watchdog.',
          'Admin-gated operational control plane with runtime and readiness reporting.'
        ]
      },
      metrics: {
        summary24h,
        summary168h,
        live: stats
      },
      architecture: {
        execution: 'Deriv WebSocket proposal/buy/open-contract lifecycle',
        controlPlane: 'Express admin API with token-based authorization',
        persistence: 'Local trade ledger at backend/data/trade-ledger.ndjson',
        deployment: 'Persistent backend host required for 24/7 loops'
      }
    })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/admin/trading/emergency-stop', requireAdmin, async (req, res) => {
  try {
    if (!retirementTrader) return res.status(400).json({ ok: false, error: 'Retirement trader not initialized' })
    const reason = String(req.body?.reason || 'manual_emergency_stop')
    retirementTrader.emergencyStop(reason, { actor: req.adminSession.username })
    return res.json({ ok: true, message: `Emergency stop activated: ${reason}` })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/admin/trading/resume', requireAdmin, async (req, res) => {
  try {
    if (!retirementTrader) return res.status(400).json({ ok: false, error: 'Retirement trader not initialized' })
    retirementTrader.clearEmergencyStop(req.adminSession.username)
    if (!retirementTrader.isRunning) retirementTrader.start()
    return res.json({ ok: true, message: 'Emergency stop cleared and trader resumed' })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/deriv/accounts', async (req, res) => {
  try {
    if (!hasDerivCredentials(activeTradingMode)) {
      return res.status(400).json({ ok: false, error: `Deriv credentials are missing for mode: ${activeTradingMode}` })
    }

    const { appId, token } = getDerivCredentials(activeTradingMode)
    const client = new FixedDerivClient({ token, appId })
    const validation = await client.validateOnce(10000)

    if (!validation.ok || !validation.authorized) {
      client.close()
      alertManager.alert('deriv_auth_failed', 'Deriv authorization failed', 'critical', {
        reason: validation.error || 'not_authorized'
      })
      return res.status(400).json({ ok: false, error: validation.error || 'Deriv client not authorized' })
    }

    const accountInfo = validation.accountInfo || client.getAccountInfo?.() || null
    client.close()

    return res.json({
      ok: true,
      mode: activeTradingMode,
      accounts: accountInfo ? [{
        loginid: accountInfo.loginid,
        account_type: accountInfo.account_type,
        currency: accountInfo.currency,
        balance: accountInfo.balance,
        is_virtual: accountInfo.is_virtual,
        landing_company_name: accountInfo.landing_company_name
      }] : [],
      currentAccount: accountInfo?.loginid || null,
      accountInfo
    })
  } catch (error) {
    console.error('Error in /api/deriv/accounts:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/retirement/start', requireAdmin, async (req, res) => {
  try {
    const result = await startRetirementSequence(req)
    if (!result.ok) {
      return res.status(result.status || 400).json({ ok: false, error: result.error || 'Unable to start sequence' })
    }
    return res.json(result)
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/retirement/stop', requireAdmin, (req, res) => {
  try {
    if (isVercel) {
      serverlessCalcState.isRunning = false
      serverlessCalcState.note = 'Calculation stopped.'
      alertManager.alert('calc_stopped', 'Serverless calculation sequence stopped', 'info')
      return res.json({
        ok: true,
        message: 'Calculation sequence stopped',
        mode: 'serverless-calculation'
      })
    }

    if (!retirementTrader) {
      return res.status(400).json({ ok: false, error: 'Retirement trader not initialized' })
    }

    retirementTrader.stop()

    return res.json({
      ok: true,
      message: 'Iceflower FLO Realm stopped'
    })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/retirement/stats', (req, res) => {
  try {
    if (isVercel) {
      if (serverlessCalcState.isRunning) {
        const win = Math.random() >= 0.45
        const move = Number((Math.random() * 0.02).toFixed(4))
        serverlessCalcState.dailyStats.totalTrades += 1
        if (win) {
          serverlessCalcState.dailyStats.wins += 1
          serverlessCalcState.dailyStats.totalProfit += move
          serverlessCalcState.totalProfits += move
        } else {
          serverlessCalcState.dailyStats.losses += 1
          serverlessCalcState.dailyStats.totalLoss += move
          serverlessCalcState.totalProfits -= move
        }
        serverlessCalcState.volatility = Math.min(0.95, 0.2 + Math.random() * 0.7)
      }
      return res.json({ ok: true, ...serverlessCalcState })
    }

    if (!retirementTrader) {
      return res.json({
        ok: true,
        isRunning: false,
        totalProfits: 0,
        dailyStats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          totalProfit: 0,
          totalLoss: 0
        },
        currentStake: 100,
        profitTarget: 100,
        volatility: 0.5,
        mode: 'ICEFLOWER FLO REALM',
        tradingAccountMode: activeTradingMode,
        risk: {
          maxDailyLoss: traderDefaults.maxDailyLoss,
          dailyProfitTarget: traderDefaults.dailyProfitTarget,
          stopOnAnyLoss: traderDefaults.stopOnAnyLoss
        }
      })
    }

    return res.json({
      ...retirementTrader.getRetirementStats(),
      tradingAccountMode: activeTradingMode
    })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/validate-token', async (req, res) => {
  if (!hasDerivCredentials(activeTradingMode)) {
    return res.status(400).json({ ok: false, error: `Deriv credentials are missing for mode: ${activeTradingMode}` })
  }
  const { appId, token } = getDerivCredentials(activeTradingMode)
  const client = new FixedDerivClient({ token, appId })
  const result = await client.validateOnce(4000)
  client.close()
  return res.json({ ...result, mode: activeTradingMode })
})

app.post('/api/log-signal', (req, res) => {
  try {
    const payload = req.body
    payload.receivedAt = Date.now()
    console.log('Signal logged:', payload.type || 'unknown')
    return res.json({ ok: true })
  } catch (err) {
    console.error('log-signal error', err)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/prepare-trade', (req, res) => {
  try {
    const { prediction, strength, stake, payout, submissionTs } = req.body || {}
    const maxStake = process.env.DERIV_MAX_STAKE ? Number(process.env.DERIV_MAX_STAKE) : 6000
    const parsedStake = Number(stake)
    const parsedPrediction = Number(prediction)
    const parsedStrength = Number(strength)
    const parsedPayout = Number(payout)

    if (!Number.isFinite(parsedStake) || parsedStake <= 0) {
      return res.status(400).json({ ok: false, error: 'stake must be a positive number' })
    }
    if (!Number.isFinite(parsedPrediction) || parsedPrediction < 0 || parsedPrediction > 9) {
      return res.status(400).json({ ok: false, error: 'prediction must be a number between 0 and 9' })
    }
    if (!Number.isFinite(parsedStrength) || parsedStrength < 0) {
      return res.status(400).json({ ok: false, error: 'strength must be a non-negative number' })
    }
    if (!Number.isFinite(parsedPayout) || parsedPayout < 0) {
      return res.status(400).json({ ok: false, error: 'payout must be a non-negative number' })
    }

    const prepared = {
      ok: true,
      trade: {
        prediction: parsedPrediction,
        strength: parsedStrength,
        stake: Math.min(parsedStake, maxStake),
        payout: parsedPayout,
        submissionTs: Number(submissionTs) || Date.now()
      }
    }

    console.log('Trade prepared:', prepared.trade)
    return res.json(prepared)
  } catch (err) {
    console.error('prepare-trade error', err)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

app.use('/api', (req, res) => {
  alertManager.alert('api_unknown_route', 'Unknown API route hit', 'warning', {
    method: req.method,
    url: req.originalUrl,
    ip: getClientIp(req)
  })
  return res.status(404).json({ ok: false, error: 'API route not found' })
})

if (HAS_FRONTEND_DIST) {
  app.get('*', (req, res) => {
    return res.sendFile(path.join(FRONTEND_DIST_DIR, 'index.html'))
  })
}

if (!isVercel) {
  await loadAdminSessions()
  setInterval(() => {
    const removed = pruneExpiredAdminSessions()
    if (removed > 0) {
      persistAdminSessions().catch(() => {})
    }
  }, 5 * 60 * 1000)

  const port = process.env.PORT || 4000
  server.listen(port, () => {
    console.log(`Iceflower FLO Realm Backend running on port ${port}`)
    if (AUTO_START_TRADER) {
      startRetirementSequence({ headers: { host: `localhost:${port}` } })
        .then((result) => {
          if (!result.ok) {
            console.error('AUTO_START_TRADER failed:', result.error || 'unknown error')
          } else {
            console.log('AUTO_START_TRADER enabled: retirement sequence started')
          }
        })
        .catch((error) => {
          console.error('AUTO_START_TRADER failed:', error.message)
        })
    }
  })

  process.on('SIGINT', () => {
    console.log('Shutting down gracefully...')
    if (retirementTrader) retirementTrader.stop()
    if (deriv) deriv.close()
    server.close()
    process.exit(0)
  })
}

export default app
