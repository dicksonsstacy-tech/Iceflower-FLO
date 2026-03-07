import fs from 'fs/promises'
import path from 'path'

export default class TradeLedger {
  constructor(filePath) {
    this.filePath = filePath
  }

  async append(event) {
    if (!event || typeof event !== 'object') return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`
    await fs.appendFile(this.filePath, line, 'utf8')
  }

  async getRecent(limit = 100) {
    const rows = await this.#readAll()
    return rows.slice(-Math.max(1, limit)).reverse()
  }

  async getSummary(hours = 24) {
    const since = Date.now() - (Math.max(1, Number(hours)) * 60 * 60 * 1000)
    const rows = (await this.#readAll()).filter((r) => Number(r.ts || 0) >= since)
    const settled = rows.filter((r) => r.type === 'trade_settled')
    const wins = settled.filter((r) => Number(r.profit || 0) > 0).length
    const losses = settled.filter((r) => Number(r.profit || 0) < 0).length
    const pnl = settled.reduce((sum, r) => sum + Number(r.profit || 0), 0)
    const volume = settled.reduce((sum, r) => sum + Number(r.stake || 0), 0)
    const uniqueContracts = new Set(
      settled.map((r) => Number(r.contractId || 0)).filter((id) => Number.isFinite(id) && id > 0)
    )

    return {
      hours: Math.max(1, Number(hours)),
      events: rows.length,
      settledTrades: settled.length,
      wins,
      losses,
      winRate: settled.length ? Number(((wins / settled.length) * 100).toFixed(2)) : 0,
      realizedPnl: Number(pnl.toFixed(6)),
      tradedVolume: Number(volume.toFixed(6)),
      uniqueContracts: uniqueContracts.size
    }
  }

  async #readAll() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }
}
