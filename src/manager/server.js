'use strict'

// The setup page's web server. It only listens on this computer (127.0.0.1), refuses requests
// that claim to come from another host name, and only accepts changes from its own page (a
// custom header other websites can't send), so nothing outside your PC can drive your bots.

const http = require('http')
const fs = require('fs')
const path = require('path')
const { Roster } = require('./roster')
const { Processes } = require('./processes')
const { readMind } = require('./mind')
const { randomBot, ARCHETYPES, MORALS, SKILL_IDS } = require('./randomize')
const { SKILLS } = require('../skills/registry')

const PAGE = path.join(__dirname, 'page.html')
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function send (res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(data)
}

function readBody (req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function createManager ({ root = process.cwd(), script, nodePath, rosterDir = 'bots' } = {}) {
  const roster = new Roster({ root, dir: rosterDir })
  roster.load()
  const procs = new Processes({ roster, root, script, nodePath })

  const botView = (b) => ({ ...b, ...procs.info(b) })
  const mustGet = (id) => {
    const b = roster.get(id)
    if (!b) throw Object.assign(new Error('no such bot'), { status: 404 })
    return b
  }

  // Static info the page needs once: skill names and tiers, play styles, providers.
  const catalog = () => ({
    skills: SKILL_IDS.map(id => ({ id, label: SKILLS[id].label, tiers: SKILLS[id].tiers.map(t => t.name), unlock: SKILLS[id].unlock || null })),
    archetypes: Object.entries(ARCHETYPES).map(([id, a]) => ({ id, label: a.label })),
    morals: Object.entries(MORALS).map(([id, m]) => ({ id, label: m.label, line: m.line, social: m.social })),
    socialFeatures: ['feelings', 'ownership', 'stealing', 'theftDetection', 'sabotage']
  })

  const routes = [
    ['GET', /^\/api\/state$/, () => ({ shared: roster.publicShared(), bots: roster.bots().map(botView), catalog: catalog(), dir: roster.dir })],
    ['PUT', /^\/api\/shared$/, async (m, body) => { roster.updateShared(body); return { shared: roster.publicShared() } }],
    ['POST', /^\/api\/bots$/, async (m, body) => ({ bot: botView(roster.add(body.bot || {}, { random: !!body.random })) })],
    ['PUT', /^\/api\/bots\/([\w-]+)$/, async (m, body) => ({ bot: botView(roster.update(m[1], body.bot || {})) })],
    ['DELETE', /^\/api\/bots\/([\w-]+)$/, async (m) => {
      const b = mustGet(m[1])
      if (procs.info(b).running) throw Object.assign(new Error(`stop ${b.name} before deleting it`), { status: 409 })
      roster.remove(b.id)
      return { ok: true }
    }],
    ['POST', /^\/api\/bots\/([\w-]+)\/start$/, async (m) => { const b = mustGet(m[1]); procs.start(b); return { bot: botView(b) } }],
    ['POST', /^\/api\/bots\/([\w-]+)\/stop$/, async (m) => { const b = mustGet(m[1]); await procs.stop(b.id); return { bot: botView(b) } }],
    ['POST', /^\/api\/bots\/([\w-]+)\/restart$/, async (m) => { const b = mustGet(m[1]); await procs.restart(b); return { bot: botView(b) } }],
    ['POST', /^\/api\/bots\/([\w-]+)\/command$/, async (m, body) => { const b = mustGet(m[1]); procs.command(b.id, body.text); return { ok: true } }],
    ['GET', /^\/api\/bots\/([\w-]+)\/log$/, (m, body, url) => procs.logs(mustGet(m[1]).id, Number(url.searchParams.get('since')) || 0)],
    ['GET', /^\/api\/bots\/([\w-]+)\/mind$/, (m) => readMind(roster, mustGet(m[1]))],
    ['GET', /^\/api\/bots\/([\w-]+)\/config$/, (m) => roster.buildConfig(mustGet(m[1]))],
    ['POST', /^\/api\/random$/, async (m, body) => {
      const keep = body.keep || {}
      const taken = roster.bots().filter(b => b.id !== body.id).map(b => b.name)
      return { bot: randomBot({ taken, keep }) }
    }],
    ['POST', /^\/api\/start-all$/, async () => { for (const b of roster.bots()) procs.start(b); return { bots: roster.bots().map(botView) } }],
    ['POST', /^\/api\/stop-all$/, async () => { await procs.stopAll(); return { bots: roster.bots().map(botView) } }]
  ]

  const server = http.createServer(async (req, res) => {
    try {
      if (!LOCAL_HOSTS.test(req.headers.host || '')) return send(res, 403, { error: 'this page only works on this computer' })
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8')
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
      if (req.method !== 'GET' && req.headers['x-mc-manager'] !== '1') return send(res, 403, { error: 'missing page header' })
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re)
        if (!m || method !== req.method) continue
        const body = req.method === 'GET' ? {} : await readBody(req)
        return send(res, 200, await fn(m, body, url))
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      send(res, err.status || 500, { error: err.message || String(err) })
    }
  })

  return { server, roster, procs }
}

module.exports = { createManager }
