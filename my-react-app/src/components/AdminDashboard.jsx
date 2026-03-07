import React, { useEffect, useState } from 'react'
import { getApiBase } from '../lib/apiBase.js'

async function jsonRequest(url, options = {}) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

export default function AdminDashboard({ token }) {
  const API_BASE = getApiBase()
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('viewer')
  const [status, setStatus] = useState('')

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }

  const loadUsers = async () => {
    const res = await jsonRequest(`${API_BASE}/api/admin/users`, { headers })
    if (res.ok && res.data?.ok) {
      setUsers(res.data.users || [])
      setStatus('User registry synced')
    } else {
      setStatus(res.data?.error || 'Failed to load users')
    }
  }

  useEffect(() => {
    if (token) loadUsers()
  }, [token])

  const createUser = async (e) => {
    e.preventDefault()
    if (!username.trim()) return
    const res = await jsonRequest(`${API_BASE}/api/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: username.trim(), role })
    })
    if (res.ok && res.data?.ok) {
      setUsername('')
      setRole('viewer')
      await loadUsers()
      setStatus(`Created user: ${res.data.user.username}`)
    } else {
      setStatus(res.data?.error || 'Failed to create user')
    }
  }

  const toggleStatus = async (user) => {
    const nextStatus = user.status === 'active' ? 'suspended' : 'active'
    const res = await jsonRequest(`${API_BASE}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: nextStatus })
    })
    if (res.ok && res.data?.ok) {
      await loadUsers()
      setStatus(`Updated ${user.username} -> ${nextStatus}`)
    } else {
      setStatus(res.data?.error || 'Failed to update user')
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel wide">
        <h2>Create User</h2>
        <form onSubmit={createUser}>
          <div className="controls">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              style={{
                flex: 1,
                minWidth: 220,
                background: 'rgba(8,20,44,0.86)',
                border: '1px solid rgba(140,222,255,0.25)',
                borderRadius: 10,
                color: '#e7f4ff',
                padding: '10px 12px'
              }}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{
                background: 'rgba(8,20,44,0.86)',
                border: '1px solid rgba(140,222,255,0.25)',
                borderRadius: 10,
                color: '#e7f4ff',
                padding: '10px 12px'
              }}
            >
              <option value="viewer">viewer</option>
              <option value="analyst">analyst</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit" className="sigil-btn primary">Create</button>
          </div>
        </form>
        <p className="note">{status}</p>
      </article>

      <article className="panel wide">
        <h2>User Control Matrix</h2>
        {users.length === 0 && <p className="note">No users found.</p>}
        {users.length > 0 && (
          <div className="alert-list">
            {users.map((user) => (
              <div className="alert-item" key={user.id}>
                <span>{user.role}</span>
                <span>{user.username}</span>
                <span>
                  {user.status}
                  <button
                    onClick={() => toggleStatus(user)}
                    className="sigil-btn secondary"
                    style={{ marginLeft: 10, padding: '6px 10px', fontSize: 12 }}
                  >
                    {user.status === 'active' ? 'Suspend' : 'Activate'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  )
}
