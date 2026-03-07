import React, { useEffect, useState } from 'react'
import Login from './pages/Login.jsx'
import RetirementDashboard from './components/RetirementDashboard.jsx'
import AdminDashboard from './components/AdminDashboard.jsx'
import { getApiBase } from './lib/apiBase.js'

export default function App() {
  const API_BASE = getApiBase()
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '')
  const [activeTab, setActiveTab] = useState('realm')
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)

  useEffect(() => {
    const verify = async () => {
      if (!token) {
        setReady(true)
        return
      }
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const payload = await res.json().catch(() => ({}))
        if (res.ok && payload?.ok) {
          setUser(payload.user || null)
        } else {
          localStorage.removeItem('admin_token')
          setToken('')
        }
      } catch {
        localStorage.removeItem('admin_token')
        setToken('')
      } finally {
        setReady(true)
      }
    }
    verify()
  }, [token])

  const onLogin = (nextToken, nextUser) => {
    setToken(nextToken)
    setUser(nextUser)
    setActiveTab('realm')
  }

  const logout = async () => {
    try {
      if (token) {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        })
      }
    } catch {
      // no-op
    } finally {
      localStorage.removeItem('admin_token')
      setToken('')
      setUser(null)
    }
  }

  if (!ready) return null

  if (!token) return <Login onLogin={onLogin} />

  return (
    <div className="iceflower-shell">
      <div className="aurora-layer" />
      <div className="arcane-grid" />
      <main className="iceflower-app">
        <header className="iceflower-header">
          <p className="kicker">Authorized Console</p>
          <h1>Icelower FLO Realm</h1>
          <p className="subtitle">Signed in as {user?.username || 'admin'}</p>
          <div className="controls">
            <button
              className={`sigil-btn ${activeTab === 'realm' ? 'primary' : 'secondary'}`}
              onClick={() => setActiveTab('realm')}
            >
              Realm Dashboard
            </button>
            <button
              className={`sigil-btn ${activeTab === 'admin' ? 'primary' : 'secondary'}`}
              onClick={() => setActiveTab('admin')}
            >
              Admin Dashboard
            </button>
            <button className="sigil-btn secondary" onClick={logout}>Logout</button>
          </div>
        </header>

        {activeTab === 'realm' ? <RetirementDashboard token={token} /> : <AdminDashboard token={token} />}
      </main>
    </div>
  )
}
