'use strict'

// `npm run setup`: starts the setup page on this computer and opens it in your browser.
// Closing this window stops the page and every bot it started.

const { exec } = require('child_process')
const { createManager } = require('./server')

const PORT = Number(process.env.MC_AI_SETUP_PORT) || 3000

function openBrowser (url) {
  if (process.env.MC_AI_NO_BROWSER) return
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd, () => {})
}

function listen (server, port, triesLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) return listen(server, port + 1, triesLeft - 1)
    console.error(`Could not start the setup page: ${err.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`
    console.log(`Setup page: ${url}`)
    console.log('Leave this window open while your bots play. Close it (or press Ctrl+C) to stop everything.')
    openBrowser(url)
  })
}

const { server, procs } = createManager({ root: process.cwd() })
let closing = false
async function shutdown () {
  if (closing) return
  closing = true
  console.log('Stopping all bots...')
  await procs.stopAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
listen(server, PORT)
