import localtunnel from 'localtunnel'

const port = Number(process.env.TUNNEL_PORT || 4000)
const subdomain = String(process.env.TUNNEL_SUBDOMAIN || '').trim()

let tunnel = null

async function startTunnel() {
  try {
    const options = subdomain ? { port, subdomain } : { port }
    tunnel = await localtunnel(options)
    console.log(`[tunnel] public url: ${tunnel.url}`)

    tunnel.on('close', () => {
      console.error('[tunnel] closed, exiting so PM2 can restart')
      process.exit(1)
    })
  } catch (error) {
    console.error('[tunnel] failed:', error.message)
    process.exit(1)
  }
}

process.on('SIGINT', async () => {
  try {
    if (tunnel) await tunnel.close()
  } catch {
    // no-op
  } finally {
    process.exit(0)
  }
})

process.on('SIGTERM', async () => {
  try {
    if (tunnel) await tunnel.close()
  } catch {
    // no-op
  } finally {
    process.exit(0)
  }
})

await startTunnel()
setInterval(() => {}, 60_000)
