export function getApiBase() {
  const configured = String(import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/$/, '')
  if (!configured) return ''

  const isLocalConfigured =
    configured.includes('localhost') ||
    configured.includes('127.0.0.1') ||
    configured.includes('0.0.0.0')

  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    const isLocalHost = host === 'localhost' || host === '127.0.0.1'
    if (isLocalConfigured && !isLocalHost) return ''
  }

  return configured
}
