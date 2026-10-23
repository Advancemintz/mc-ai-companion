'use strict'

// The bot's social life, as data and rules (no game I/O here, so it's easy to test):
//
//   - Feelings: a lasting score from -100 (deep hatred) to +100 (best friend) for every player.
//     Events move it (gifts, being hit, theft, griefing) and the model can nudge it, within
//     limits. It slowly drifts back toward neutral over real days.
//   - Ownership: whose base a block or chest is in: your own bases, bases you were told about,
//     and bases you worked out by watching who keeps hanging around (and opening chests) where.
//   - Your chests: a ledger of what was in each one the last time you closed it. When a chest
//     comes up short, the theft is logged with a ranked list of suspects (who was seen opening
//     it, who was hanging around).
//   - Your own mischief: what you took from whom, and sabotage, with cooldowns.
//   - Operator controls: every part can be switched off in config.social or with ! commands,
//     and protected players are never stolen from or sabotaged.
//
// Everything is stored in memory.data.social so it survives restarts.

const DEFAULTS = {
  enabled: true,
  feelings: { enabled: true, start: 0, decayPerDay: 2, modelMaxPerHour: 30 },
  ownership: { enabled: true, learn: true, claimRadius: 12 },
  stealing: { enabled: true, feelingAtMost: -20, maxShare: 0.25, maxItemTypes: 3, minChestItems: 4, witnessRadius: 24, patienceSeconds: 20, cooldownMinutes: 20 },
  theftDetection: { enabled: true },
  sabotage: { enabled: true, feelingAtMost: -80, maxBlocks: 6, cooldownMinutes: 60, kinds: ['torches', 'crops', 'doorway'] },
  protected: []
}

const FEATURES = ['feelings', 'ownership', 'stealing', 'theftDetection', 'sabotage']

const LEVELS = [
  [-80, 'deep hatred'], [-50, 'hate'], [-20, 'dislike'], [19, 'neutral'], [49, 'like'], [79, 'friend'], [100, 'best friend']
]

// How much things move feelings.
const EVENT = {
  gift: 4,
  hit: -6,
  killedMe: -25,
  griefed: -10,
  snooped: -2,
  caughtStealing: -30,
  suspected: -12
}

const DAY = 24 * 60 * 60 * 1000
const CLAIM_SCORE = 4

function deepMerge (base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

const lc = (s) => String(s || '').toLowerCase()
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

function levelOf (score) {
  for (const [max, label] of LEVELS) if (score <= max) return label
  return 'best friend'
}

// How useful an item is to steal (bigger = better). Junk scores below 1.
const VALUE = [
  [/^(diamond|netherite_ingot|netherite_scrap|ancient_debris|emerald|enchanted_golden_apple|totem_of_undying|elytra|nether_star)$/, 10],
  [/^(diamond|netherite)_/, 9],
  [/^(golden_apple|ender_pearl|blaze_rod|iron_ingot|gold_ingot|raw_iron|raw_gold|redstone|lapis_lazuli|obsidian|experience_bottle|name_tag|saddle)$/, 7],
  [/^(iron_|bow$|arrow$|shield$|crossbow$|golden_carrot$|cooked_beef$|cooked_porkchop$)/, 6],
  [/^(cooked_|bread$|baked_potato$|pumpkin_pie$|apple$|carrot$|potato$)/, 5],
  [/^(coal|charcoal|torch|copper_ingot|raw_copper|string|leather|book|paper|wheat|bone_meal|gunpowder|slime_ball|feather)$/, 3],
  [/_(log|planks)$|^(glass|stick|wheat_seeds)$/, 1.5],
  [/^(cobblestone|cobbled_deepslate|dirt|gravel|sand|netherrack|andesite|diorite|granite|tuff|rotten_flesh|poisonous_potato|spider_eye)$/, 0.3]
]

function itemValue (name) {
  for (const [re, v] of VALUE) if (re.test(name)) return v
  return 1
}

// Pick a modest share of the most useful things in a chest, never emptying it.
//   counts      { item: count } in the chest
//   maxShare    at most this fraction of each item, and of everything in the chest
//   maxItemTypes  at most this many different items
//   minValue    ignore junk below this usefulness
// Returns { item: count } to take (possibly empty).
function chooseLoot (counts, { maxShare = 0.25, maxItemTypes = 3, minValue = 1.5 } = {}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total < 2) return {}
  let budget = Math.max(1, Math.floor(total * maxShare))
  budget = Math.min(budget, total - 1) // something always stays behind
  const ranked = Object.entries(counts)
    .filter(([name, n]) => n > 0 && itemValue(name) >= minValue)
    .sort((a, b) => itemValue(b[0]) - itemValue(a[0]) || b[1] - a[1])
  const loot = {}
  let types = 0
  for (const [name, n] of ranked) {
    if (budget <= 0 || types >= maxItemTypes) break
    // A modest share of each stack; a lone precious item only if there's plenty else in there.
    let take = Math.floor(n * maxShare)
    if (take < 1) take = n === 1 && itemValue(name) >= 9 && total >= 12 ? 1 : 0
    take = Math.min(take, budget)
    if (take <= 0) continue
    loot[name] = take
    budget -= take
    types++
  }
  return loot
}

class Social {
  constructor (memory, config = {}, { botName = '' } = {}) {
    this.memory = memory
    this.config = config
    this.botName = botName
    this._local = null
  }

  // Live settings: config.social merged over defaults, with operator overrides from memory.
  cfg () {
    const base = deepMerge(DEFAULTS, (this.config && this.config.social) || {})
    const o = this._store().overrides || {}
    if (o.enabled !== undefined) base.enabled = o.enabled
    for (const f of FEATURES) if (o[f] !== undefined) base[f] = { ...base[f], enabled: o[f] }
    return base
  }

  on (feature) {
    const c = this.cfg()
    return !!c.enabled && (feature ? c[feature]?.enabled !== false : true)
  }

  setFeature (feature, on) {
    const s = this._store()
    s.overrides = s.overrides || {}
    if (feature === 'all') s.overrides.enabled = on
    else if (FEATURES.includes(feature)) s.overrides[feature] = on
    else throw new Error(`unknown feature "${feature}". Options: all, ${FEATURES.join(', ')}`)
    this._save()
  }

  _store () {
    const empty = { feelings: {}, claims: [], ledger: {}, chestOpens: [], sightings: [], thefts: [], myThefts: [], sabotage: [], protected: [], modelChanges: {}, overrides: {} }
    if (!this.memory) { this._local = this._local || empty; return this._local }
    const d = this.memory.data
    d.social = { ...empty, ...(d.social || {}) }
    return d.social
  }

  _save () { this.memory?.save() }

  isMe (name) { return lc(name) === lc(this.botName) }

  // ------------------------------------------------------------ protected players
  isProtected (name) {
    const n = lc(name)
    return (this.cfg().protected || []).some(p => lc(p) === n) || this._store().protected.includes(n)
  }

  protect (name, on = true) {
    const s = this._store()
    const n = lc(name)
    s.protected = s.protected.filter(p => p !== n)
    if (on) s.protected.push(n)
    if (on) { // protected players can't sit at sabotage-level hatred
      const f = this._entry(name)
      if (f.score < -50) f.score = -50
    }
    this._save()
  }

  // ------------------------------------------------------------ feelings
  _key (name) {
    const s = this._store()
    return Object.keys(s.feelings).find(k => lc(k) === lc(name)) || String(name)
  }

  _entry (name) {
    const s = this._store()
    const k = this._key(name)
    if (!s.feelings[k]) s.feelings[k] = { score: this.cfg().feelings.start || 0, updatedAt: Date.now(), history: [] }
    const e = s.feelings[k]
    // Slow drift back toward neutral over real days.
    const rate = this.cfg().feelings.decayPerDay || 0
    const days = (Date.now() - (e.updatedAt || Date.now())) / DAY
    if (rate && days > 0.01 && e.score !== 0) {
      const drift = rate * days
      e.score = e.score > 0 ? Math.max(0, e.score - drift) : Math.min(0, e.score + drift)
      e.score = Math.round(e.score * 10) / 10
    }
    e.updatedAt = Date.now()
    return e
  }

  feeling (name) {
    if (!name || this.isMe(name)) return 0
    const s = this._store()
    if (!s.feelings[this._key(name)]) return this.cfg().feelings.start || 0
    return Math.round(this._entry(name).score)
  }

  level (name) { return levelOf(this.feeling(name)) }

  // Change how the bot feels about someone. source "model" is rate-limited per hour.
  adjust (name, delta, why = '', { source = 'event' } = {}) {
    if (!name || this.isMe(name) || !this.on('feelings')) return null
    let d = Number(delta) || 0
    if (source === 'model') {
      d = clamp(d, -15, 15)
      const s = this._store()
      const k = lc(name)
      const hourAgo = Date.now() - 60 * 60 * 1000
      const recent = (s.modelChanges[k] || []).filter(c => c.at > hourAgo)
      const used = recent.reduce((a, c) => a + Math.abs(c.d), 0)
      const left = Math.max(0, (this.cfg().feelings.modelMaxPerHour ?? 30) - used)
      d = Math.sign(d) * Math.min(Math.abs(d), left)
      s.modelChanges[k] = [...recent, { at: Date.now(), d }]
      if (!d) return { score: this.feeling(name), level: this.level(name), capped: true }
    }
    const e = this._entry(name)
    const before = e.score
    let floor = -100
    if (this.isProtected(name)) floor = -50
    e.score = clamp(Math.round((e.score + d) * 10) / 10, floor, 100)
    e.history = [...(e.history || []), { at: Date.now(), d: Math.round(d * 10) / 10, why: String(why).slice(0, 80) }].slice(-8)
    this._save()
    return { before: Math.round(before), score: Math.round(e.score), level: levelOf(e.score), crossed: levelOf(before) !== levelOf(e.score) }
  }

  setFeeling (name, score) {
    const e = this._entry(name)
    e.score = clamp(Number(score) || 0, this.isProtected(name) ? -50 : -100, 100)
    e.history = [...(e.history || []), { at: Date.now(), d: 0, why: 'set by an operator' }].slice(-8)
    this._save()
    return Math.round(e.score)
  }

  resetFeeling (name) {
    const s = this._store()
    delete s.feelings[this._key(name)]
    this._save()
  }

  feelings () {
    const s = this._store()
    return Object.keys(s.feelings).map(k => ({ name: k, score: this.feeling(k), level: this.level(k), why: (s.feelings[k].history || []).slice(-2).map(h => h.why).filter(Boolean) }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
  }

  // An event that changes feelings (a gift, a hit...). Returns the adjust result.
  event (kind, name, why) {
    const d = EVENT[kind]
    if (d === undefined) throw new Error(`unknown feelings event ${kind}`)
    return this.adjust(name, d, why || kind)
  }

  // ------------------------------------------------------------ ownership
  // Who owns the block at pos? Returns { owner, how, name } or null for the wild.
  //   how: 'mine' (one of your bases), 'known' (a base you were told about), 'seen' (worked out by watching)
  ownerAt (pos, dimension = 'overworld', { zones = null } = {}) {
    if (!pos) return null
    const dim = String(dimension || 'overworld').replace('minecraft:', '')
    const mem = this.memory
    // Your own bases (built projects, home, farm).
    if (zones) {
      for (const z of zones) {
        const inside = z.kind === 'radius'
          ? Math.hypot(pos.x - z.center.x, pos.z - z.center.z) <= z.radius && Math.abs(pos.y - z.center.y) <= Math.max(z.radius, 16)
          : pos.x >= z.min.x && pos.x <= z.max.x && pos.y >= z.min.y && pos.y <= z.max.y && pos.z >= z.min.z && pos.z <= z.max.z
        if (!inside) continue
        const place = mem?.data.places?.[z.name]
        if (place?.owner && !this.isMe(place.owner)) return { owner: place.owner, how: 'known', name: z.name }
        if (z.kind === 'base' || z.name === 'home' || z.name === 'farm') return { owner: this.botName, how: 'mine', name: z.name }
      }
    }
    // Bases you know belong to someone (remember_place with an owner).
    const r = this.cfg().ownership.claimRadius || 12
    for (const [name, p] of Object.entries(mem?.data.places || {})) {
      if (!p.owner || this.isMe(p.owner) || p.dimension !== dim) continue
      if (dist2(p, pos) <= r && Math.abs(p.y - pos.y) <= 24) return { owner: p.owner, how: 'known', name }
    }
    if (!this.on('ownership')) return null
    // Bases worked out by watching.
    let best = null
    for (const c of this._store().claims) {
      if (c.dimension !== dim || c.score < CLAIM_SCORE) continue
      const d = dist2(c, pos)
      if (d <= (c.radius || r) && Math.abs(c.y - pos.y) <= 24 && (!best || d < best.d)) best = { d, c }
    }
    if (best) return { owner: best.c.owner, how: 'seen', name: `${lc(best.c.owner)}_base` }
    return null
  }

  ownerLabel (o) {
    if (!o) return 'nobody (the wild)'
    if (o.how === 'mine') return 'you'
    return `${o.owner}${o.how === 'seen' ? ' (you worked it out)' : ''}`
  }

  // Evidence that `player` lives around pos. weight: 1 hanging around, 2 opening a chest, 3 sleeping.
  // Returns the claim when it has just become confident, else null.
  observeHome (player, pos, dimension = 'overworld', weight = 1, why = 'seen there') {
    if (!player || this.isMe(player) || !this.on('ownership') || this.cfg().ownership.learn === false) return null
    const dim = String(dimension).replace('minecraft:', '')
    const s = this._store()
    const r = this.cfg().ownership.claimRadius || 12
    // Already known to be someone's (theirs or another's)? Then there's nothing to learn here.
    const known = this.ownerAt(pos, dim)
    if (known && known.how !== 'seen') return null
    let c = s.claims.find(k => lc(k.owner) === lc(player) && k.dimension === dim && dist2(k, pos) <= r)
    if (!c) {
      c = { owner: player, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dim, radius: r, score: 0, evidence: [], firstAt: Date.now() }
      s.claims.push(c)
      if (s.claims.length > 40) s.claims.splice(0, s.claims.length - 40)
    }
    const was = c.score
    c.score = Math.round((c.score + weight) * 10) / 10
    c.lastAt = Date.now()
    c.evidence = [...c.evidence, `${why} (${new Date().toISOString().slice(11, 16)})`].slice(-5)
    this._save()
    return was < CLAIM_SCORE && c.score >= CLAIM_SCORE ? c : null
  }

  // Someone told you, or you're sure: this is their base.
  learnBase (player, pos, dimension = 'overworld') {
    const dim = String(dimension).replace('minecraft:', '')
    const s = this._store()
    s.claims = s.claims.filter(k => !(lc(k.owner) === lc(player) && dist2(k, pos) <= 16))
    s.claims.push({ owner: player, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dim, radius: this.cfg().ownership.claimRadius || 12, score: CLAIM_SCORE + 4, evidence: ['told or certain'], firstAt: Date.now(), lastAt: Date.now() })
    this._save()
  }

  // Where does a player live, as far as we know? Places with an owner first, then claims.
  baseOf (player) {
    const p = this.memory?.playerBase?.(player)
    if (p) return { x: p.x, y: p.y, z: p.z, dimension: p.dimension, how: 'known', name: p.name }
    const c = this._store().claims.filter(k => lc(k.owner) === lc(player) && k.score >= CLAIM_SCORE).sort((a, b) => b.score - a.score)[0]
    return c ? { x: c.x, y: c.y, z: c.z, dimension: c.dimension, how: 'seen', name: `${lc(player)}_base` } : null
  }

  // ------------------------------------------------------------ sightings and chest opens
  recordSighting (player, pos, at = Date.now()) {
    if (!player || this.isMe(player)) return
    const s = this._store()
    s.sightings.push({ p: player, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at })
    const cutoff = Date.now() - 6 * 60 * 60 * 1000
    if (s.sightings.length > 400 || (s.sightings[0] && s.sightings[0].at < cutoff)) {
      s.sightings = s.sightings.filter(x => x.at >= cutoff).slice(-400)
    }
    this.memory?.save()
  }

  recordChestOpen (key, pos, player, at = Date.now()) {
    if (!player || this.isMe(player)) return
    const s = this._store()
    s.chestOpens.push({ key, p: player, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at })
    if (s.chestOpens.length > 200) s.chestOpens.splice(0, s.chestOpens.length - 200)
    this._save()
  }

  // ------------------------------------------------------------ your chests and theft
  ledgerEntry (key) { return this._store().ledger[key] || null }

  // Remember exactly what is in one of your chests right now (after you used it).
  snapshotChest (key, pos, counts) {
    const s = this._store()
    s.ledger[key] = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), items: { ...counts }, at: Date.now() }
    const keys = Object.keys(s.ledger)
    if (keys.length > 60) delete s.ledger[keys.sort((a, b) => s.ledger[a].at - s.ledger[b].at)[0]]
    this._save()
  }

  // Who could have taken things from the chest at pos since `since`? Ranked, best guess first.
  suspectsFor (pos, since, key = null) {
    const s = this._store()
    const score = {}
    const add = (p, w, reason) => {
      if (this.isMe(p)) return
      const k = score[lc(p)] = score[lc(p)] || { name: p, weight: 0, reasons: new Set() }
      k.weight += w
      k.reasons.add(reason)
    }
    for (const o of s.chestOpens) {
      if (o.at < since) continue
      if ((key && o.key === key) || Math.hypot(o.x - pos.x, o.y - pos.y, o.z - pos.z) <= 1.5) add(o.p, 5, `seen opening it ${ago(o.at)}`)
    }
    const windows = new Set()
    for (const v of s.sightings) {
      if (v.at < since || Math.hypot(v.x - pos.x, v.z - pos.z) > 12 || Math.abs(v.y - pos.y) > 8) continue
      const w = `${lc(v.p)}:${Math.floor(v.at / 30000)}`
      if (windows.has(w)) continue
      windows.add(w)
      add(v.p, 1, 'was hanging around nearby')
    }
    return Object.values(score).map(x => ({ name: x.name, weight: x.weight, reasons: [...x.reasons] }))
      .sort((a, b) => b.weight - a.weight).slice(0, 4)
  }

  // Compare one of your chests with how you left it. Returns a theft record when things are
  // missing (feelings toward the suspects drop), otherwise null. Always updates the snapshot.
  auditChest (key, pos, counts) {
    const before = this.ledgerEntry(key)
    this.snapshotChest(key, pos, counts)
    if (!before || !this.on('theftDetection')) return null
    const missing = {}
    for (const [name, n] of Object.entries(before.items)) {
      const gone = n - (counts[name] || 0)
      if (gone > 0) missing[name] = gone
    }
    if (!Object.keys(missing).length) return null
    const suspects = this.suspectsFor(pos, before.at, key)
    const theft = { key, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), missing, since: before.at, at: Date.now(), suspects }
    const s = this._store()
    s.thefts.push(theft)
    if (s.thefts.length > 20) s.thefts.splice(0, s.thefts.length - 20)
    // Feelings: someone seen opening it is as good as caught; otherwise everyone around shares the blame.
    const what = Object.entries(missing).map(([n, c]) => `${c} ${n}`).join(', ')
    const caught = suspects.filter(x => x.reasons.some(r => r.startsWith('seen opening')))
    if (caught.length) for (const c of caught) this.event('caughtStealing', c.name, `stole ${what} from my chest`)
    else for (const c of suspects) this.adjust(c.name, Math.min(-4, Math.round(EVENT.suspected / suspects.length)), `maybe stole ${what} from my chest`)
    this._save()
    return theft
  }

  thefts (withinMs = 3 * DAY) {
    return this._store().thefts.filter(t => Date.now() - t.at <= withinMs)
  }

  describeTheft (t) {
    const what = Object.entries(t.missing).map(([n, c]) => `${c} ${n}`).join(', ')
    const who = t.suspects.length ? t.suspects.map(x => `${x.name} (${x.reasons.join(', ')})`).join('; ') : 'nobody was seen near it'
    return `your chest at ${t.x} ${t.y} ${t.z} is missing ${what} (noticed ${ago(t.at)}). Suspects: ${who}`
  }

  // ------------------------------------------------------------ your own mischief
  canSteal (victim) {
    const c = this.cfg()
    if (!this.on('stealing')) return { ok: false, why: 'stealing is switched off by the server operators' }
    if (!victim) return { ok: false, why: 'say whose stuff you mean' }
    if (this.isMe(victim)) return { ok: false, why: "that's your own stuff" }
    if (this.isProtected(victim)) return { ok: false, why: `${victim} is protected by the operators: you never take their things` }
    const f = this.feeling(victim)
    if (f > c.stealing.feelingAtMost) return { ok: false, why: `you don't dislike ${victim} enough to steal from them (you feel ${f}, ${levelOf(f)}; stealing needs ${c.stealing.feelingAtMost} or worse)` }
    const last = this._store().myThefts.filter(t => lc(t.victim) === lc(victim)).slice(-1)[0]
    const cool = (c.stealing.cooldownMinutes || 0) * 60000
    if (last && Date.now() - last.at < cool) return { ok: false, why: `you took from ${victim} ${ago(last.at)}; lie low for a while (${Math.ceil((cool - (Date.now() - last.at)) / 60000)} more min)` }
    return { ok: true }
  }

  canSabotage (victim) {
    const c = this.cfg()
    if (!this.on('sabotage')) return { ok: false, why: 'sabotage is switched off by the server operators' }
    if (!victim || this.isMe(victim)) return { ok: false, why: 'sabotage whom?' }
    if (this.isProtected(victim)) return { ok: false, why: `${victim} is protected by the operators` }
    const f = this.feeling(victim)
    if (f > c.sabotage.feelingAtMost) return { ok: false, why: `sabotage is only for deep hatred (${c.sabotage.feelingAtMost} or worse); you feel ${f} (${levelOf(f)}) about ${victim}` }
    const last = this._store().sabotage.filter(t => lc(t.victim) === lc(victim)).slice(-1)[0]
    const cool = (c.sabotage.cooldownMinutes || 0) * 60000
    if (last && Date.now() - last.at < cool) return { ok: false, why: `you already got back at ${victim} ${ago(last.at)}; wait a while` }
    return { ok: true }
  }

  recordMyTheft (victim, items, pos, seenBy = []) {
    const s = this._store()
    s.myThefts.push({ victim, items, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now(), seenBy })
    if (s.myThefts.length > 30) s.myThefts.splice(0, s.myThefts.length - 30)
    this._save()
  }

  recordSabotage (victim, kind, count, pos) {
    const s = this._store()
    s.sabotage.push({ victim, kind, count, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now() })
    if (s.sabotage.length > 30) s.sabotage.splice(0, s.sabotage.length - 30)
    this._save()
  }

  myThefts () { return this._store().myThefts }
  mySabotage () { return this._store().sabotage }

  // ------------------------------------------------------------ text for the model
  describe ({ nearby = [], pos = null, dimension = 'overworld', zones = null } = {}) {
    if (!this.on()) return ''
    const lines = []
    if (this.on('feelings')) {
      const all = this.feelings()
      const near = new Set(nearby.map(lc))
      const shown = [...all.filter(f => near.has(lc(f.name))), ...all.filter(f => !near.has(lc(f.name)))].slice(0, 8)
      const fmt = (f) => `${f.name} ${f.score > 0 ? '+' : ''}${f.score} (${f.level}${this.isProtected(f.name) ? ', protected' : ''})${f.why.length ? ` [${f.why.join('; ')}]` : ''}`
      if (shown.length) lines.push('How you feel about people: ' + shown.map(fmt).join(', '))
      const unknown = nearby.filter(n => !all.some(f => lc(f.name) === lc(n)) && !this.isMe(n))
      if (unknown.length) lines.push(`No strong feelings yet about: ${unknown.join(', ')}`)
    }
    if (pos) {
      const o = this.ownerAt(pos, dimension, { zones })
      if (o && o.how !== 'mine') lines.push(`You are inside ${o.owner}'s base${o.how === 'seen' ? ' (you worked that out by watching them)' : ''}.`)
    }
    const theirs = this._store().claims.filter(c => c.score >= CLAIM_SCORE && !this.memory?.playerBase?.(c.owner))
    if (theirs.length) lines.push('Bases you worked out: ' + theirs.slice(-5).map(c => `${c.owner}'s around ${c.x} ${c.y} ${c.z}`).join('; '))
    for (const t of this.thefts().slice(-2)) lines.push(`THEFT: ${this.describeTheft(t)}`)
    const mine = this.myThefts().filter(t => Date.now() - t.at < DAY).slice(-2)
    for (const t of mine) {
      const what = Object.entries(t.items).map(([n, c]) => `${c} ${n}`).join(', ')
      lines.push(`Your secret: you took ${what} from ${t.victim}'s chest ${ago(t.at)}${t.seenBy?.length ? ` (${t.seenBy.join(', ')} may have seen you)` : ' (nobody saw)'}.`)
    }
    const sab = this.mySabotage().filter(t => Date.now() - t.at < DAY).slice(-1)
    for (const t of sab) lines.push(`Your secret: you sabotaged ${t.victim}'s base (${t.kind}) ${ago(t.at)}.`)
    const c = this.cfg()
    const rules = []
    rules.push(this.on('stealing') ? `stealing allowed from people at ${c.stealing.feelingAtMost} or worse` : 'stealing is OFF')
    rules.push(this.on('sabotage') ? `sabotage only at deep hatred (${c.sabotage.feelingAtMost} or worse)` : 'sabotage is OFF')
    const prot = [...new Set([...(c.protected || []), ...this._store().protected])]
    if (prot.length) rules.push(`never steal from or sabotage: ${prot.join(', ')}`)
    lines.push(`Social rules: ${rules.join('; ')}.`)
    return lines.join('\n')
  }

  // Short status for operators (!social).
  status () {
    const c = this.cfg()
    const flag = (f) => `${f} ${this.on(f) ? 'on' : 'off'}`
    return `Social ${c.enabled ? 'on' : 'off'}: ${FEATURES.map(flag).join(', ')}. Steal at <= ${c.stealing.feelingAtMost}, sabotage at <= ${c.sabotage.feelingAtMost}. Protected: ${[...new Set([...(c.protected || []), ...this._store().protected])].join(', ') || 'nobody'}.`
  }

  wipe () {
    if (this.memory) delete this.memory.data.social
    else this._local = null
    this._save()
  }
}

module.exports = { Social, DEFAULTS, FEATURES, EVENT, levelOf, itemValue, chooseLoot, CLAIM_SCORE }
