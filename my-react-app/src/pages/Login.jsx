import React, { useState } from 'react'
import { getApiBase } from '../lib/apiBase.js'

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const BACKEND = getApiBase()

  async function submit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${BACKEND}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const payload = await res.json()
      if (!res.ok || !payload.ok || !payload.token) {
        throw new Error(payload?.err || payload?.error || 'Login failed')
      }
      localStorage.setItem('admin_token', payload.token)
      onLogin(payload.token, payload.user || null)
    } catch (err) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="iceflower-shell">
      <div className="aurora-layer" />
      <div className="arcane-grid" />
      <main className="iceflower-app">
        <header className="iceflower-header">
          <p className="kicker">Iceflower Protocol</p>
          <h1>Icelower FLO Realm</h1>
          <p className="subtitle">Admin access required to enter the control glyphs.</p>
        </header>
        <section className="panel-grid">
          <article className="panel wide" style={{ gridColumn: 'span 12', maxWidth: 520, margin: '0 auto' }}>
            <h2>Admin Sign In</h2>
            <form onSubmit={submit}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter admin password"
                style={{
                  width: '100%',
                  marginBottom: 12,
                  background: 'rgba(8,20,44,0.86)',
                  border: '1px solid rgba(140,222,255,0.25)',
                  borderRadius: 10,
                  color: '#e7f4ff',
                  padding: '12px 14px'
                }}
              />
              <button type="submit" className="sigil-btn primary" disabled={loading} style={{ width: '100%' }}>
                {loading ? 'Opening Gate...' : 'Enter Realm'}
              </button>
            </form>
            {error && <p className="note" style={{ color: '#ff9ca4', marginTop: 12 }}>{error}</p>}
          </article>
        </section>
      </main>
    </div>
  )
}
