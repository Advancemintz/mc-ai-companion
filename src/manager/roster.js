'use strict'

// The roster: every bot the setup page knows about, plus the settings they share (the world to
// join and the AI to use). Saved as bots/roster.json. For each bot it also writes a complete,
// ordinary config file, bots/<name>.json, so a bot can still be started by hand:
//   node src/index.js bots/Pip.json
//
// The first time, the roster is seeded from config.json, so an existing setup carries over.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { deepMerge } = require('../config')
const { randomBot, SKILL_IDS } = require('./randomize')

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

const clone = (v) => JSON.parse(JSON.stringify(v))
const newId = () => crypto.randomBytes(5).toString('hex')

// Fields a bot card can set. Anything else in a request is ignored.
const BOT_FIELDS = ['name', 'account', 'archetype', 'morals', 'personality', 'greeting', 'talents', 'startTier', 'startTiers',
  'social', 'autonomous', 'idleThinkSeconds', 'respondTo', 'provider', 'model', 'notes']

class Roster {
  constructor ({ root = process.cwd(), dir = 'bots', baseConfigFile = 'config.json' } = {}) {
    this.root = root
    this.dir = path.resolve(root, dir)
    this.file = path.join(this.dir, 'roster.json')
    this.baseFile = path.resolve(root, baseConfigFile)
    this.data = null
  }

  // The full template every bot config starts from (config.json, minus the bot-specific bits).
  base () {
    const b = readJson(this.baseFile, null) || readJson(path.join(__dirname, '..', '..', 'config.json'), {})
    return b
  }

  load () {
    const saved = readJson(this.file, null)
    if (saved && saved.shared && Array.isArray(saved.bots)) {
      this.data = saved
      return this.data
    }
    // First run: carry over config.json.
    const base = this.base()
    const shared = {
      minecraft: clone(base.minecraft || { host: 'localhost', port: 25565, auth: 'offline', version: false }),
      llm: clone(base.llm || { provider: 'ollama', providers: {} }),
      bot: { admins: base.bot?.admins || [], opsFile: base.bot?.opsFile || '', botChatCooldownSeconds: base.bot?.botChatCooldownSeconds ?? 30 },
      social: { protected: base.social?.protected || [] }
    }
    delete shared.minecraft.username
    const first = base.minecraft?.username || 'Companion'
    const bots = []
    if (base.bot?.personality) {
      bots.push(this.normalize({
        id: newId(),
        name: NAME_RE.test(first) ? first : 'Companion',
        memoryName: base.bot.memoryName || `${base.minecraft?.host || 'localhost'}-${first}`,
        archetype: '',
        morals: '',
        personality: base.bot.personality,
        greeting: base.bot.greeting || '',
        talents: { ...(base.bot.skills?.affinity || {}) },
        startTier: base.bot.skills?.startTier ?? 1,
        startTiers: base.bot.skills?.startTiers || {},
        social: {},
        autonomous: base.bot.autonomous !== false,
        idleThinkSeconds: base.bot.idleThinkSeconds ?? 10
      }))
    }
    this.data = { version: 1, shared, bots }
    this.save()
    return this.data
  }

  save () {
    writeJsonAtomic(this.file, this.data)
    this.writeConfigs()
  }

  bots () { return this.data.bots }
  get (id) { return this.data.bots.find(b => b.id === id || b.name.toLowerCase() === String(id).toLowerCase()) || null }

  // Fill in defaults and drop anything unknown.
  normalize (b) {
    const out = {
      id: b.id || newId(),
      name: String(b.name || '').trim(),
      account: String(b.account || '').trim(),
      memoryName: b.memoryName || '',
      archetype: b.archetype || '',
      morals: b.morals || '',
      personality: String(b.personality || '').trim(),
      greeting: String(b.greeting ?? ''),
      talents: {},
      startTier: Math.max(1, Math.min(5, Math.round(Number(b.startTier) || 1))),
      startTiers: {},
      social: clone(b.social || {}),
      autonomous: b.autonomous !== false,
      idleThinkSeconds: Math.max(3, Math.min(600, Number(b.idleThinkSeconds) || 10)),
      respondTo: b.respondTo === 'mention' ? 'mention' : 'all',
      provider: b.provider || '',
      model: String(b.model || '').trim(),
      notes: String(b.notes || '').slice(0, 500)
    }
    for (const id of SKILL_IDS) {
      const v = Number(b.talents?.[id])
      out.talents[id] = Number.isFinite(v) && v > 0 ? Math.max(0.2, Math.min(3, Math.round(v * 10) / 10)) : 1
      const t = Number(b.startTiers?.[id])
      if (Number.isFinite(t) && t >= 1) out.startTiers[id] = Math.min(5, Math.round(t))
    }
    if (!out.memoryName) out.memoryName = `${this.data?.shared?.minecraft?.host || 'localhost'}-${out.name}`
    return out
  }

  validate (bot, { exceptId = null } = {}) {
    const problems = []
    if (!NAME_RE.test(bot.name)) problems.push('names are 3-16 letters, numbers or _ (Minecraft rules)')
    if (this.data.bots.some(b => b.id !== exceptId && b.name.toLowerCase() === bot.name.toLowerCase())) problems.push(`there's already a bot called ${bot.name}`)
    if (!bot.personality) problems.push('write a personality (or press Randomize)')
    if (bot.provider && !this.data.shared.llm.providers?.[bot.provider]) problems.push(`AI provider "${bot.provider}" isn't set up under World & AI`)
    if (problems.length) {
      const err = new Error(problems.join('; '))
      err.status = 400
      throw err
    }
  }

  add (input = {}, { random = false } = {}) {
    let b = input
    if (random || !input.personality) {
      const r = randomBot({ taken: this.data.bots.map(x => x.name), keep: input.name ? { name: input.name } : {} })
      b = { ...r, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) }
    }
    const bot = this.normalize({ ...b, id: newId(), memoryName: '' })
    this.validate(bot)
    this.data.bots.push(bot)
    this.save()
    return bot
  }

  update (id, input) {
    const cur = this.get(id)
    if (!cur) { const e = new Error('no such bot'); e.status = 404; throw e }
    const patch = Object.fromEntries(Object.entries(input || {}).filter(([k]) => BOT_FIELDS.includes(k)))
    // memoryName never changes, so a renamed bot keeps its memories.
    const next = this.normalize({ ...cur, ...patch, id: cur.id, memoryName: cur.memoryName })
    this.validate(next, { exceptId: cur.id })
    const oldName = cur.name
    Object.assign(cur, next)
    if (oldName !== cur.name) { try { fs.unlinkSync(this.configPath(oldName)) } catch {} }
    this.save()
    return cur
  }

  remove (id) {
    const cur = this.get(id)
    if (!cur) return false
    this.data.bots = this.data.bots.filter(b => b !== cur)
    try { fs.unlinkSync(this.configPath(cur.name)) } catch {}
    this.save()
    return true
  }

  updateShared (input = {}) {
    const s = this.data.shared
    if (input.minecraft) {
      const m = input.minecraft
      s.minecraft = {
        ...s.minecraft,
        host: String(m.host ?? s.minecraft.host).trim() || 'localhost',
        port: Math.max(1, Math.min(65535, Number(m.port ?? s.minecraft.port) || 25565)),
        auth: m.auth === 'microsoft' ? 'microsoft' : 'offline',
        version: m.version ? String(m.version).trim() : false
      }
    }
    if (input.llm) {
      const l = input.llm
      s.llm = { ...s.llm }
      if (l.provider) s.llm.provider = String(l.provider)
      if (l.providers && typeof l.providers === 'object') {
        s.llm.providers = { ...(s.llm.providers || {}) }
        for (const [k, v] of Object.entries(l.providers)) {
          const next = { ...(s.llm.providers[k] || {}) }
          for (const [field, value] of Object.entries(v || {})) {
            if (field === 'apiKeySet') continue
            if (field === 'apiKey' && !value && !v.apiKeyClear) continue // blank = keep the saved key
            if (field === 'apiKeyClear') { if (value) next.apiKey = ''; continue }
            next[field] = value
          }
          s.llm.providers[k] = next
        }
      }
      for (const k of ['temperature', 'maxHistory', 'timeoutSeconds']) if (l[k] !== undefined && Number.isFinite(Number(l[k]))) s.llm[k] = Number(l[k])
      if (!s.llm.providers?.[s.llm.provider]) {
        const e = new Error(`AI provider "${s.llm.provider}" has no settings`); e.status = 400; throw e
      }
    }
    if (input.bot) {
      s.bot = { ...s.bot }
      if (Array.isArray(input.bot.admins)) s.bot.admins = input.bot.admins.map(String).filter(Boolean)
      if (input.bot.botChatCooldownSeconds !== undefined) s.bot.botChatCooldownSeconds = Math.max(5, Number(input.bot.botChatCooldownSeconds) || 30)
    }
    if (input.social && Array.isArray(input.social.protected)) s.social = { ...s.social, protected: input.social.protected.map(String).filter(Boolean) }
    this.save()
    return s
  }

  configPath (name) { return path.join(this.dir, `${name}.json`) }

  // A complete config for one bot: config.json, then the shared settings, then the bot's own.
  buildConfig (bot) {
    const shared = this.data.shared
    const cfg = deepMerge(this.base(), clone(shared))
    delete cfg._path
    cfg.minecraft = { ...cfg.minecraft, username: shared.minecraft.auth === 'microsoft' && bot.account ? bot.account : bot.name }
    const others = this.data.bots.filter(b => b.id !== bot.id).map(b => b.name)
    cfg.bot = {
      ...cfg.bot,
      personality: bot.personality,
      greeting: bot.greeting,
      autonomous: bot.autonomous,
      idleThinkSeconds: bot.idleThinkSeconds,
      respondTo: bot.respondTo,
      memoryName: bot.memoryName,
      otherBots: [...new Set([...(cfg.bot.otherBots || []), ...others])],
      skills: { ...(cfg.bot.skills || {}), mode: 'natural', startTier: bot.startTier, startTiers: bot.startTiers, affinity: bot.talents }
    }
    const protectedList = [...new Set([...(shared.social?.protected || []), ...(bot.social?.protected || [])])]
    cfg.social = deepMerge(deepMerge(cfg.social || {}, shared.social || {}), bot.social || {})
    cfg.social.protected = protectedList
    if (bot.provider) cfg.llm.provider = bot.provider
    if (bot.model) cfg.llm.providers[cfg.llm.provider] = { ...(cfg.llm.providers[cfg.llm.provider] || {}), model: bot.model }
    return cfg
  }

  writeConfigs () {
    for (const b of this.data.bots) {
      if (!NAME_RE.test(b.name)) continue
      writeJsonAtomic(this.configPath(b.name), this.buildConfig(b))
    }
  }

  // Where a bot keeps its memories (same rule as src/brain/memory.js).
  memoryFile (bot) {
    const { slug } = require('../brain/memory')
    const cfg = this.buildConfig(bot)
    return path.resolve(this.root, cfg.bot.memoryDir || 'memory', slug(cfg.bot.memoryName) + '.json')
  }

  // Strip API keys before sending settings to the page (it shows "saved" instead).
  publicShared () {
    const s = clone(this.data.shared)
    for (const p of Object.values(s.llm.providers || {})) {
      if (p.apiKey) { p.apiKeySet = true; p.apiKey = '' }
    }
    return s
  }
}

module.exports = { Roster, NAME_RE }
