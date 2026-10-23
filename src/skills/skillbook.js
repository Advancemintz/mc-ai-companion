'use strict'

// A bot's skill book: XP and tier for every skill, saved with its memory.
//
// - XP comes from results (a finished base, ores mined, fights won), scaled by the bot's
//   affinity for that skill (so different bots specialise) and the global xpRate.
// - A tier unlocks when XP is high enough AND its requirements (other skills) are met.
//   Tiers never go down on their own.
// - Operators can fix a skill at a tier, cap it, lock it, set XP, or reset it.
// - Failed attempts give a little XP too (you learn from mistakes), and the bot can write
//   short lessons that it reads before trying again.

const { EventEmitter } = require('events')
const { SKILLS, ACTION_SKILLS } = require('./registry')

const DEFAULTS = { mode: 'natural', startTier: 1, startTiers: {}, caps: {}, affinity: {}, xpRate: 1 }

class SkillBook extends EventEmitter {
  constructor (memory, config = {}) {
    super()
    this.memory = memory
    this.cfg = { ...DEFAULTS, ...((config.bot || {}).skills || {}) }
    this._local = {}
    this._init()
  }

  _store () {
    if (!this.memory) return this._local
    this.memory.data.skills = this.memory.data.skills || {}
    return this.memory.data.skills
  }

  _save () { this.memory?.save() }

  _init () {
    const store = this._store()
    for (const id of Object.keys(SKILLS)) {
      if (store[id]) continue
      const start = this.cfg.startTiers[id] ?? this.cfg.startTier
      const def = SKILLS[id]
      const tier = Math.max(0, Math.min(def.tiers.length, start))
      const startTier = this._unlockMet(id) || this.cfg.startTiers[id] ? Math.max(1, tier) : 0
      store[id] = {
        xp: startTier > 1 ? def.tiers[startTier - 1].xp : 0,
        tier: startTier,
        cap: this.cfg.caps[id] ?? null,
        fixed: this.cfg.mode === 'fixed' ? startTier : null,
        locked: false,
        attempts: 0,
        successes: 0,
        failures: 0,
        lessons: []
      }
    }
    this._save()
  }

  ids () { return Object.keys(SKILLS) }

  state (id) {
    if (SKILLS[id] && !this._store()[id]) this._init() // e.g. after an operator wiped memory
    const s = this._store()[id]
    if (!s) throw new Error(`unknown skill "${id}". Skills: ${this.ids().join(', ')}`)
    return s
  }

  _unlockMet (id) {
    const req = SKILLS[id].unlock
    if (!req) return true
    const store = this._store()
    return Object.entries(req).every(([other, t]) => (store[other] ? this.tier(other) : 0) >= t)
  }

  _requirementsMet (tierDef) {
    if (!tierDef.requires) return true
    return Object.entries(tierDef.requires).every(([other, t]) => this.tier(other) >= t)
  }

  // Effective tier, after operator settings. 0 = not learned yet.
  tier (id) {
    const s = this.state(id)
    let t = s.fixed ?? s.tier
    if (s.cap !== null && s.cap !== undefined) t = Math.min(t, s.cap)
    return t
  }

  info (id) {
    const def = SKILLS[id]
    const t = this.tier(id)
    const tierDef = t > 0 ? def.tiers[t - 1] : null
    return { id, label: def.label, tier: t, max: def.tiers.length, name: tierDef?.name || 'not learned', params: tierDef?.params || null, def: tierDef }
  }

  params (id) {
    return this.info(id).params
  }

  // Throws a friendly error if the bot hasn't learned enough for something.
  require (id, minTier, what = '') {
    const t = this.tier(id)
    if (t >= minTier) return
    const def = SKILLS[id]
    const need = def.tiers[minTier - 1]
    const cur = t > 0 ? `tier ${t} "${def.tiers[t - 1].name}"` : 'not learned yet'
    const how = t > 0 ? def.tiers[t - 1].next : `first get ${Object.entries(def.unlock || {}).map(([s, n]) => `${s} tier ${n}`).join(' and ')}`
    throw new Error(`I haven't learned ${what || 'that'} yet: it needs ${def.label.toLowerCase()} tier ${minTier} "${need.name}", and I'm ${cur}. To improve: ${how}`)
  }

  // Add XP; returns the list of level-ups that happened.
  award (id, amount, why = '') {
    const s = this.state(id)
    if (s.locked || !(amount > 0)) return []
    const gained = amount * (this.cfg.affinity[id] ?? 1) * (this.cfg.xpRate ?? 1)
    s.xp = Math.round((s.xp + gained) * 10) / 10
    const ups = this._advance()
    this._save()
    if (why) this.emit('xp', { skill: id, amount: gained, why })
    return ups
  }

  // Climb every skill as far as XP and requirements allow; unlock skills whose prerequisites are met.
  _advance () {
    const ups = []
    let changed = true
    while (changed) {
      changed = false
      for (const id of this.ids()) {
        const s = this.state(id)
        const def = SKILLS[id]
        if (s.locked) continue
        if (s.tier === 0) {
          if (this._unlockMet(id)) {
            s.tier = 1
            changed = true
            ups.push({ skill: id, tier: 1, name: def.tiers[0].name, can: def.tiers[0].can, unlocked: true })
          }
          continue
        }
        const next = def.tiers[s.tier]
        if (next && s.xp >= next.xp && this._requirementsMet(next)) {
          s.tier++
          changed = true
          ups.push({ skill: id, tier: s.tier, name: next.name, can: next.can })
        }
      }
    }
    for (const u of ups) this.emit('levelUp', u)
    return ups
  }

  recordAttempt (id, ok) {
    const s = this.state(id)
    s.attempts++
    if (ok) s.successes++
    else {
      s.failures++
      this.award(id, 2) // a failed attempt still teaches something
    }
    this._save()
  }

  addLesson (id, text) {
    const s = this.state(id)
    const t = String(text || '').trim().slice(0, 140)
    if (!t) throw new Error('a lesson needs some text')
    s.lessons = [...(s.lessons || []).filter(l => l !== t), t].slice(-3)
    this._save()
  }

  // ---------------------------------------------------------------- operator controls
  setFixed (id, tier) {
    const s = this.state(id)
    if (tier === null) { s.fixed = null; this._advance(); this._save(); return }
    const max = SKILLS[id].tiers.length
    s.fixed = Math.max(0, Math.min(max, Math.round(tier)))
    this._save()
  }

  setCap (id, cap) {
    const s = this.state(id)
    s.cap = cap === null ? null : Math.max(0, Math.round(cap))
    this._save()
  }

  setXp (id, xp) {
    const s = this.state(id)
    s.xp = Math.max(0, Number(xp) || 0)
    // Setting XP down can't take tiers away; setting it up levels up.
    this._advance()
    this._save()
  }

  setLocked (id, locked) {
    this.state(id).locked = !!locked
    this._save()
  }

  reset (id) {
    const ids = id ? [id] : this.ids()
    const store = this._store()
    for (const k of ids) delete store[k]
    this._init()
  }

  // ---------------------------------------------------------------- hooks
  // Count attempts/successes for skill actions, and give a little XP for failures.
  attach (executor) {
    const mapFor = (name, args) => {
      const m = ACTION_SKILLS[name]
      if (!m) return null
      if (m.onlyFor && !m.onlyFor.test(String(args?.block || ''))) return null
      return m
    }
    executor.on('actionDone', ({ name, args }) => {
      const m = mapFor(name, args)
      if (m) this.recordAttempt(m.skill, true)
    })
    executor.on('actionFailed', ({ name, args, error }) => {
      const m = mapFor(name, args)
      if (!m || /haven't learned/.test(error)) return
      this.recordAttempt(m.skill, false)
      this.lastFailure = { skill: m.skill, name, error, at: Date.now() }
    })
    executor.skills = this
  }

  // Gate an action before it runs (used by the executor).
  gate (name, args) {
    const m = ACTION_SKILLS[name]
    if (!m) return
    if (m.onlyFor && !m.onlyFor.test(String(args?.block || ''))) return
    this.require(m.skill, m.minTier, name.replace(/_/g, ' '))
  }

  // ---------------------------------------------------------------- text
  describe ({ lessons = true } = {}) {
    const lines = []
    for (const id of this.ids()) {
      const def = SKILLS[id]
      const s = this.state(id)
      const t = this.tier(id)
      const aff = this.cfg.affinity[id]
      const talent = aff > 1.2 ? ' (a natural talent)' : aff && aff < 0.8 ? ' (not your strength)' : ''
      if (t === 0) {
        const req = Object.entries(def.unlock || {}).map(([k, n]) => `${k} tier ${n}`).join(' + ')
        lines.push(`- ${def.label}: not learned yet${req ? ` (unlocks at ${req})` : ''}${talent}`)
        continue
      }
      const cur = def.tiers[t - 1]
      const next = def.tiers[t]
      const progress = next ? ` ${Math.floor(s.xp)}/${next.xp} XP to "${next.name}"${next.requires ? ` (also needs ${Object.entries(next.requires).map(([k, n]) => `${k} tier ${n}`).join(', ')})` : ''}` : ' (top tier)'
      const flags = [s.fixed !== null ? 'set by an operator' : '', s.cap !== null ? `capped at ${s.cap}` : '', s.locked ? 'locked' : ''].filter(Boolean).join(', ')
      lines.push(`- ${def.label} tier ${t}/${def.tiers.length} "${cur.name}"${talent}: ${cur.can}.${progress}${flags ? ` [${flags}]` : ''}`)
      if (lessons && s.lessons?.length) lines.push(`  lessons: ${s.lessons.join(' | ')}`)
    }
    return 'Your skills:\n' + lines.join('\n')
  }

  summaryShort () {
    return this.ids().map(id => {
      const t = this.tier(id)
      return t ? `${SKILLS[id].label} ${t} (${SKILLS[id].tiers[t - 1].name})` : `${SKILLS[id].label} -`
    }).join(', ')
  }
}

module.exports = { SkillBook, SKILLS, ACTION_SKILLS }
