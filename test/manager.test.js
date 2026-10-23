'use strict'

// The setup page's back end: the roster and config files, the randomizer, and the web API that
// starts, stops and talks to bots (with a stand-in bot process).

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Roster } = require('../src/manager/roster')
const { randomBot, ARCHETYPES, MORALS } = require('../src/manager/randomize')
const { createManager } = require('../src/manager/server')

function tempRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-setup-'))
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
  base.llm.providers.anthropic.apiKey = 'sk-secret'
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(base))
  return dir
}

function seeded (seed = 1) {
  let s = seed
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
}

test('randomizer: a full character, talents that fit the style, locks respected, unique names', () => {
  const b = randomBot({ rng: seeded(7) })
  assert.ok(ARCHETYPES[b.archetype] && MORALS[b.morals])
  assert.match(b.personality, new RegExp(`^You are ${b.name}, a `))
  const a = ARCHETYPES[b.archetype]
  const best = Object.entries(b.talents).sort((x, y) => y[1] - x[1])[0][0]
  assert.ok(a.talents[best] >= 1.3, `${b.archetype} should be best at one of its own skills, got ${best}`)
  assert.ok(b.talents[a.weak] <= 0.75)
  assert.deepStrictEqual(b.social, MORALS[b.morals].social)
  const kept = randomBot({ rng: seeded(99), keep: { name: 'Pip', archetype: 'farmer', personality: 'Mine.', talents: { building: 2 } } })
  assert.strictEqual(kept.name, 'Pip')
  assert.strictEqual(kept.archetype, 'farmer')
  assert.strictEqual(kept.personality, 'Mine.')
  assert.deepStrictEqual(kept.talents, { building: 2 })
  const names = new Set()
  const taken = []
  for (let i = 0; i < 60; i++) { const n = randomBot({ rng: seeded(i + 3), taken }).name; taken.push(n); names.add(n.toLowerCase()) }
  assert.strictEqual(names.size, 60)
})

test('roster: seeded from config.json; each bot gets a complete config of its own', () => {
  const root = tempRoot()
  const r = new Roster({ root })
  r.load()
  assert.strictEqual(r.bots().length, 1)
  assert.strictEqual(r.bots()[0].name, 'Companion')
  const pip = r.add({ name: 'Pip' }, { random: true })
  assert.strictEqual(pip.name, 'Pip')
  assert.ok(fs.existsSync(path.join(root, 'bots', 'Pip.json')))
  r.update(pip.id, { talents: { building: 1.6, combat: 0.6 }, provider: 'anthropic', model: 'claude-haiku-5-5', social: { stealing: { feelingAtMost: -40 }, protected: ['Steve'] }, startTiers: { mining: 2 } })
  r.updateShared({ social: { protected: ['Alex'] } })
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bots', 'Pip.json'), 'utf8'))
  assert.strictEqual(cfg.minecraft.username, 'Pip')
  assert.deepStrictEqual(cfg.bot.otherBots, ['Companion'])
  assert.strictEqual(cfg.bot.skills.affinity.building, 1.6)
  assert.strictEqual(cfg.bot.skills.startTiers.mining, 2)
  assert.strictEqual(cfg.llm.provider, 'anthropic')
  assert.strictEqual(cfg.llm.providers.anthropic.model, 'claude-haiku-5-5')
  assert.strictEqual(cfg.social.stealing.feelingAtMost, -40)
  assert.strictEqual(cfg.social.stealing.maxShare, 0.25) // defaults still there
  assert.deepStrictEqual(cfg.social.protected.sort(), ['Alex', 'Steve'])
  assert.ok(cfg.bot.personality.length > 20)
  // The other bot knows about Pip too.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'bots', 'Companion.json'), 'utf8')).bot.otherBots, ['Pip'])
})

test('roster: renaming keeps the memory file, names are checked, keys stay hidden', () => {
  const root = tempRoot()
  const r = new Roster({ root })
  r.load()
  const b = r.add({ name: 'Moss' }, { random: true })
  const mem = r.memoryFile(b)
  r.update(b.id, { name: 'Mossy' })
  assert.strictEqual(r.memoryFile(r.get(b.id)), mem)
  assert.ok(!fs.existsSync(path.join(root, 'bots', 'Moss.json')))
  assert.ok(fs.existsSync(path.join(root, 'bots', 'Mossy.json')))
  assert.throws(() => r.update(b.id, { name: 'no spaces!' }), /names are 3-16 letters/)
  assert.throws(() => r.update(b.id, { name: 'companion' }), /already a bot called companion/)
  assert.throws(() => r.add({ name: 'X', personality: 'hi' }), /names are 3-16/)
  assert.strictEqual(r.publicShared().llm.providers.anthropic.apiKey, '')
  assert.strictEqual(r.publicShared().llm.providers.anthropic.apiKeySet, true)
  r.updateShared({ llm: { provider: 'anthropic', providers: { anthropic: { apiKey: '', model: 'm2' } } } })
  assert.strictEqual(r.data.shared.llm.providers.anthropic.apiKey, 'sk-secret') // blank keeps the key
  assert.strictEqual(r.data.shared.llm.providers.anthropic.model, 'm2')
  r.updateShared({ llm: { providers: { anthropic: { apiKey: 'sk-new' } } } })
  assert.strictEqual(r.data.shared.llm.providers.anthropic.apiKey, 'sk-new')
})

async function withServer (fn) {
  const root = tempRoot()
  const { server, procs } = createManager({ root, script: path.join(__dirname, '..', 'sim', 'fakebot.js') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://localhost:${server.address().port}`
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-mc-manager': '1', ...headers }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, data: await res.json().catch(() => null), text: res.headers.get('content-type') }
  }
  try { await fn({ call, base, procs, root }) } finally { await procs.stopAll(); server.close() }
}

const until = async (fn, ms = 4000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('timed out')
}

test('api: the page loads, bots are added, started, talked to and stopped', async () => {
  await withServer(async ({ call, base }) => {
    const page = await fetch(base + '/')
    assert.match(await page.text(), /Your bots/)
    let r = await call('GET', '/api/state')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.data.bots.length, 1)
    assert.ok(r.data.catalog.skills.some(s => s.id === 'exploration'))
    assert.strictEqual(r.data.shared.llm.providers.anthropic.apiKey, '')
    r = await call('POST', '/api/bots', { random: true })
    const id = r.data.bot.id
    r = await call('POST', `/api/bots/${id}/start`)
    assert.strictEqual(r.data.bot.running, true)
    await until(async () => (await call('GET', '/api/state')).data.bots.find(b => b.id === id).status?.connected)
    r = await call('POST', `/api/bots/${id}/command`, { text: '!pause' })
    assert.strictEqual(r.status, 200)
    const log = await until(async () => { const l = (await call('GET', `/api/bots/${id}/log`)).data; return l.lines.some(x => /got command: !pause/.test(x.text)) && l })
    assert.ok(log.lines.some(x => /fake bot .* started/.test(x.text)))
    // Editing a running bot flags that a restart is needed.
    r = await call('PUT', `/api/bots/${id}`, { bot: { greeting: 'new hello' } })
    assert.strictEqual(r.data.bot.needsRestart, true)
    r = await call('POST', `/api/bots/${id}/restart`)
    assert.strictEqual(r.data.bot.needsRestart, false)
    r = await call('DELETE', `/api/bots/${id}`)
    assert.strictEqual(r.status, 409)
    r = await call('POST', `/api/bots/${id}/stop`)
    assert.strictEqual(r.data.bot.running, false)
    r = await call('DELETE', `/api/bots/${id}`)
    assert.strictEqual(r.status, 200)
    r = await call('POST', '/api/random', { keep: { name: 'Pip' } })
    assert.strictEqual(r.data.bot.name, 'Pip')
  })
})

test('api: only this computer, and only the page itself, can make changes', async () => {
  await withServer(async ({ call, base }) => {
    let r = await call('POST', '/api/start-all', null, { 'x-mc-manager': '' })
    assert.strictEqual(r.status, 403)
    // A web page on another site reaching this port through DNS tricks shows up with its own host name.
    const status = await new Promise((resolve, reject) => {
      const req = require('http').request(base + '/api/state', { headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end()
    })
    assert.strictEqual(status, 403)
    r = await call('PUT', '/api/bots/nope', { bot: {} })
    assert.strictEqual(r.status, 404)
    r = await call('POST', '/api/bots', { bot: { name: 'ok_name', personality: '' } })
    assert.strictEqual(r.status, 200) // an empty personality gets a random one
    assert.ok(r.data.bot.personality.length > 20)
  })
})
