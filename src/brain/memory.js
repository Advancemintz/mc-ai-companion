'use strict'

// Long-term memory that survives restarts: named places (home, chests, mines),
// the bot's own goals, a short journal of what happened, and notes about players.
// Stored as plain JSON in memory/<name>.json so you can read or edit it yourself.

const fs = require('fs')
const path = require('path')
const log = require('../util/log')

const MAX_ACTIVE_GOALS = 5
const MAX_JOURNAL = 40
const MAX_NOTES_PER_PLAYER = 6
const MAX_DISCOVERIES = 80
const EXPLORE_CELL = 32

function emptyMemory () {
  return { places: {}, goals: [], journal: [], players: {}, operators: [], projects: {}, nextGoalId: 1, createdAt: new Date().toISOString() }
}

function slug (s) {
  return String(s || 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 60)
}

class Memory {
  constructor (file) {
    this.file = file
    this.data = emptyMemory()
    this._saveTimer = null
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...emptyMemory(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }
      } catch (err) {
        log.warn(`Could not read memory file ${file} (${err.message}); starting fresh.`)
      }
    }
  }

  static forBot (config) {
    const dir = path.resolve(config.bot.memoryDir || 'memory')
    const name = config.bot.memoryName || `${config.minecraft.host}-${config.minecraft.username}`
    return new Memory(path.join(dir, slug(name) + '.json'))
  }

  save () {
    if (!this.file) return
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => this.saveNow(), 500)
    this._saveTimer.unref?.()
  }

  saveNow () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      log.warn(`Could not save memory: ${err.message}`)
    }
  }

  // Erase everything the bot has learned (operators are kept so admins keep control).
  wipe () {
    const operators = this.data.operators || []
    this.data = { ...emptyMemory(), operators }
    this.saveNow()
  }

  forgetPlayer (player) {
    const key = Object.keys(this.data.players).find(k => k.toLowerCase() === String(player).toLowerCase())
    if (!key) return false
    delete this.data.players[key]
    this.save()
    return true
  }

  // ------------------------------------------------------------ places
  setPlace (name, pos, dimension = 'overworld', note = '', owner = '') {
    const key = slug(name)
    this.data.places[key] = {
      x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
      dimension: String(dimension).replace('minecraft:', ''),
      note: String(note || '').slice(0, 120),
      ...(owner ? { owner: String(owner) } : {}),
      savedAt: new Date().toISOString()
    }
    this.save()
    return key
  }

  getPlace (name) {
    return this.data.places[slug(name)] || null
  }

  // A player's base: a place they own, or one called "<player>_base".
  playerBase (player) {
    const p = String(player).toLowerCase()
    const entry = Object.entries(this.data.places).find(([name, pl]) => (pl.owner || '').toLowerCase() === p && /base|home|house/.test(name)) ||
      Object.entries(this.data.places).find(([name, pl]) => (pl.owner || '').toLowerCase() === p) ||
      Object.entries(this.data.places).find(([name]) => name === slug(p + '_base'))
    return entry ? { name: entry[0], ...entry[1] } : null
  }

  // ------------------------------------------------------------ railway offers
  lastRailOffer (player) {
    return (this.data.railOffers || {})[String(player).toLowerCase()] || 0
  }

  recordRailOffer (player) {
    this.data.railOffers = this.data.railOffers || {}
    this.data.railOffers[String(player).toLowerCase()] = Date.now()
    this.save()
  }

  railways () {
    return Object.entries(this.data.projects || {}).filter(([, p]) => p.style === 'rail').map(([name, p]) => ({ name, ...p }))
  }

  removePlace (name) {
    const key = slug(name)
    const had = !!this.data.places[key]
    delete this.data.places[key]
    this.save()
    return had
  }

  placesByDistance (pos, dimension = 'overworld', limit = 8) {
    const dim = String(dimension).replace('minecraft:', '')
    return Object.entries(this.data.places)
      .filter(([, p]) => p.dimension === dim)
      .map(([name, p]) => ({ name, ...p, distance: Math.round(Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z)) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
  }

  // ------------------------------------------------------------ building projects
  getProject (name) {
    return (this.data.projects || {})[slug(name)] || null
  }

  saveProject (name, project) {
    this.data.projects = this.data.projects || {}
    this.data.projects[slug(name)] = { ...project, updatedAt: new Date().toISOString() }
    this.save()
  }

  unfinishedProjects () {
    return Object.entries(this.data.projects || {}).filter(([, p]) => p.status !== 'done' && (p.style === 'surface' || p.style === 'underground')).map(([name, p]) => ({ name, ...p }))
  }

  // ------------------------------------------------------------ protected areas
  addZone (name, pos, radius) {
    this.data.zones = (this.data.zones || []).filter(z => z.name !== slug(name))
    this.data.zones.push({ name: slug(name), x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), radius })
    this.save()
  }

  removeZone (name) {
    const before = (this.data.zones || []).length
    this.data.zones = (this.data.zones || []).filter(z => z.name !== slug(name))
    this.save()
    return this.data.zones.length < before
  }

  // ------------------------------------------------------------ exploration
  // The explored map is kept as 32x32-block cells per dimension: "cx,cz" -> when first seen.
  _cells (dimension) {
    const dim = String(dimension || 'overworld').replace('minecraft:', '')
    this.data.explored = this.data.explored || {}
    this.data.explored[dim] = this.data.explored[dim] || {}
    return this.data.explored[dim]
  }

  // Mark the cells around pos (radius in cells) as seen. Returns how many were new.
  markExplored (pos, dimension, radiusCells = 1) {
    const cells = this._cells(dimension)
    const cx = Math.floor(pos.x / EXPLORE_CELL); const cz = Math.floor(pos.z / EXPLORE_CELL)
    let fresh = 0
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        const k = `${cx + dx},${cz + dz}`
        if (!cells[k]) { cells[k] = Date.now(); fresh++ }
      }
    }
    if (fresh) this.save()
    return fresh
  }

  isExplored (pos, dimension) {
    return !!this._cells(dimension)[`${Math.floor(pos.x / EXPLORE_CELL)},${Math.floor(pos.z / EXPLORE_CELL)}`]
  }

  // Share of the cells within radius of center that have been seen (0..1).
  exploredShare (center, radius, dimension) {
    const cells = this._cells(dimension)
    const r = Math.ceil(radius / EXPLORE_CELL)
    const ccx = Math.floor(center.x / EXPLORE_CELL); const ccz = Math.floor(center.z / EXPLORE_CELL)
    let total = 0; let seen = 0
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.hypot(dx, dz) > r) continue
        total++
        if (cells[`${ccx + dx},${ccz + dz}`]) seen++
      }
    }
    return total ? seen / total : 0
  }

  // Things found while exploring (villages, caves, lava, structures, other people's bases).
  // Returns { entry, isNew }. The same kind of find within `merge` blocks counts as the same one.
  addDiscovery (kind, label, pos, dimension = 'overworld', note = '', merge = 48) {
    this.data.discoveries = this.data.discoveries || []
    const dim = String(dimension).replace('minecraft:', '')
    const near = this.data.discoveries.find(d => d.kind === kind && d.label === label && d.dimension === dim &&
      Math.hypot(d.x - pos.x, d.z - pos.z) <= merge)
    if (near) return { entry: near, isNew: false }
    const entry = { kind, label: String(label).slice(0, 40), x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dim, note: String(note || '').slice(0, 120), at: new Date().toISOString() }
    this.data.discoveries.push(entry)
    if (this.data.discoveries.length > MAX_DISCOVERIES) this.data.discoveries.splice(0, this.data.discoveries.length - MAX_DISCOVERIES)
    this.save()
    return { entry, isNew: true }
  }

  discoveriesNear (pos, dimension = 'overworld', limit = 6) {
    const dim = String(dimension).replace('minecraft:', '')
    return (this.data.discoveries || []).filter(d => d.dimension === dim)
      .map(d => ({ ...d, distance: Math.round(Math.hypot(d.x - pos.x, d.z - pos.z)) }))
      .sort((a, b) => a.distance - b.distance).slice(0, limit)
  }

  // A biome seen for the first time? Returns true when new.
  noteBiome (name, pos) {
    if (!name) return false
    this.data.biomes = this.data.biomes || {}
    if (this.data.biomes[name]) return false
    this.data.biomes[name] = { x: Math.floor(pos.x), z: Math.floor(pos.z), at: new Date().toISOString() }
    this.save()
    return true
  }

  // A free place name: "village", then "village_2", "village_3"...
  freePlaceName (base) {
    const b = slug(base)
    if (!this.data.places[b]) return b
    for (let i = 2; ; i++) if (!this.data.places[`${b}_${i}`]) return `${b}_${i}`
  }

  // ------------------------------------------------------------ goals
  activeGoals () {
    return this.data.goals.filter(g => g.status === 'active')
  }

  addGoal (text, why = '') {
    text = String(text || '').trim().slice(0, 140)
    if (!text) throw new Error('goal text is empty')
    const dupe = this.activeGoals().find(g => g.text.toLowerCase() === text.toLowerCase())
    if (dupe) return dupe
    if (this.activeGoals().length >= MAX_ACTIVE_GOALS) {
      throw new Error(`you already have ${MAX_ACTIVE_GOALS} active goals; complete or abandon one first`)
    }
    const goal = { id: this.data.nextGoalId++, text, why: String(why || '').slice(0, 140), status: 'active', createdAt: new Date().toISOString() }
    this.data.goals.push(goal)
    this.addJournal(`New goal #${goal.id}: ${text}`)
    return goal
  }

  findGoal (ref) {
    const active = this.activeGoals()
    const n = Number(String(ref).replace('#', ''))
    if (Number.isInteger(n)) return active.find(g => g.id === n) || null
    const q = String(ref || '').toLowerCase()
    return active.find(g => g.text.toLowerCase() === q) || active.find(g => g.text.toLowerCase().includes(q) || q.includes(g.text.toLowerCase())) || null
  }

  finishGoal (ref, outcome = 'done', note = '') {
    const goal = this.findGoal(ref)
    if (!goal) return null
    goal.status = outcome === 'abandoned' ? 'abandoned' : 'done'
    goal.finishedAt = new Date().toISOString()
    if (note) goal.note = String(note).slice(0, 140)
    this.addJournal(`${goal.status === 'done' ? 'Completed' : 'Gave up on'} goal #${goal.id}: ${goal.text}${note ? ` (${note})` : ''}`)
    // Keep the file small: only the last 20 finished goals.
    const finished = this.data.goals.filter(g => g.status !== 'active')
    if (finished.length > 20) {
      const drop = new Set(finished.slice(0, finished.length - 20))
      this.data.goals = this.data.goals.filter(g => !drop.has(g))
    }
    this.save()
    return goal
  }

  // ------------------------------------------------------------ journal
  addJournal (text) {
    this.data.journal.push({ at: new Date().toISOString(), text: String(text).slice(0, 200) })
    if (this.data.journal.length > MAX_JOURNAL) this.data.journal.splice(0, this.data.journal.length - MAX_JOURNAL)
    this.save()
  }

  recentJournal (n = 5) {
    return this.data.journal.slice(-n)
  }

  // ------------------------------------------------------------ players
  notePlayer (player, note) {
    const key = String(player || '').trim()
    if (!key || !note) throw new Error('need a player name and a note')
    const notes = this.data.players[key] = this.data.players[key] || []
    notes.push(String(note).slice(0, 140))
    if (notes.length > MAX_NOTES_PER_PLAYER) notes.splice(0, notes.length - MAX_NOTES_PER_PLAYER)
    this.save()
  }

  playerNotes (player) {
    const key = Object.keys(this.data.players).find(k => k.toLowerCase() === String(player).toLowerCase())
    return key ? this.data.players[key] : []
  }

  // ------------------------------------------------------------ prompt text
  summary ({ pos, dimension, playersNearby = [] }) {
    const lines = []
    const home = this.getPlace('home')
    if (home) {
      const d = Math.round(Math.hypot(home.x - pos.x, home.y - pos.y, home.z - pos.z))
      lines.push(`Home: ${home.x} ${home.y} ${home.z}${home.dimension !== String(dimension).replace('minecraft:', '') ? ` (in the ${home.dimension})` : ` (${d} blocks away)`}`)
    } else {
      lines.push('Home: none yet')
    }
    const places = this.placesByDistance(pos, dimension).filter(p => p.name !== 'home')
    if (places.length) {
      lines.push('Known places: ' + places.map(p => `${p.name} ${p.x} ${p.y} ${p.z} (${p.distance}m${p.owner ? `, ${p.owner}'s` : ''}${p.note ? `, ${p.note}` : ''})`).join('; '))
    }
    const goals = this.activeGoals()
    lines.push('Your goals: ' + (goals.length ? goals.map(g => `#${g.id} ${g.text}${g.why ? ` (because ${g.why})` : ''}`).join('; ') : 'none - consider setting one'))
    for (const name of playersNearby) {
      const notes = this.playerNotes(name)
      if (notes.length) lines.push(`About ${name}: ${notes.join('; ')}`)
    }
    for (const p of this.unfinishedProjects()) {
      lines.push(`Unfinished project "${p.name}": ${p.size} ${p.style} base at ${p.origin.x} ${p.origin.y} ${p.origin.z}, ${p.progress ?? 0}% done${p.needs ? `, needs ${p.needs}` : ''} (call build_base with name "${p.name}" to continue)`)
    }
    for (const [name, p] of Object.entries(this.data.projects || {})) {
      if (p.status !== 'done' || !(p.style === 'surface' || p.style === 'underground')) continue
      const ups = (p.upgrades || []).map(u => u.replace(/_/g, ' '))
      lines.push(`Your base "${name}": ${(p.storeys || 1) > 1 || ups.includes('second storey') ? 'two-storey ' : ''}${p.size} ${p.style} ${p.variant || (p.style === 'surface' ? 'cottage' : 'cellar')} at ${p.origin.x} ${p.origin.y} ${p.origin.z}; ${ups.length ? `upgrades: ${ups.join(', ')}` : 'no upgrades yet'} (improve it with upgrade_base rather than building a new one)`)
    }
    const farm = this.getProject('farm')
    if (farm) {
      const ago = farm.lastRound ? Math.round((Date.now() - Date.parse(farm.lastRound)) / 60000) : null
      lines.push(`Your farm: ${farm.radius * 2 + 1}x${farm.radius * 2 + 1} at ${farm.center.x} ${farm.center.y} ${farm.center.z}${ago !== null ? `, last tended ${ago < 60 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago` : ''} (farm to harvest and replant; crops ripen in roughly 20-40 minutes)`)
    }
    const mine = this.getProject('mine')
    if (mine) {
      const levels = Object.entries(mine.levels || {}).map(([y, l]) => `y=${y} tunnel ${l.progress}`).join(', ')
      lines.push(`Your mine: entrance at ${mine.origin.x} ${mine.origin.y + 1} ${mine.origin.z}, stairs down ${mine.depth} blocks${levels ? `, levels: ${levels}` : ''} (use mine to keep digging)`)
    }
    for (const r of this.railways()) {
      lines.push(`Railway "${r.name}" to ${r.toName}: ${r.status === 'done' ? 'finished' : `${r.built || 0}/${r.cols.length} blocks built${r.needs ? `, needs ${r.needs}` : ''} (build_railway to continue)`}`)
    }
    if (this.data.explored) {
      const center = home && home.dimension === String(dimension).replace('minecraft:', '') ? home : pos
      const parts = []
      for (const r of [96, 192, 384]) parts.push(`${Math.round(this.exploredShare(center, r, dimension) * 100)}% within ${r}`)
      lines.push(`Map: explored ${parts.join(', ')} blocks of ${home ? 'home' : 'here'}${this.data.biomes ? `; biomes seen: ${Object.keys(this.data.biomes).slice(0, 12).join(', ')}` : ''}`)
    }
    const finds = this.discoveriesNear(pos, dimension, 6)
    if (finds.length) lines.push('Finds: ' + finds.map(d => `${d.label} at ${d.x} ${d.y} ${d.z} (${d.distance}m${d.note ? `, ${d.note}` : ''})`).join('; '))
    const book = Object.values(this.data.tradeBook || {})
    if (book.length) {
      const offers = []
      for (const v of book) for (const t of v.trades) if (!t.disabled && !/ emerald$/.test(t.get)) offers.push(`${t.get} for ${t.give} (${v.x} ${v.z})`)
      lines.push(`Villager offers you know (${book.length} villagers): ${offers.slice(0, 6).join('; ') || 'nothing but buying emeralds'}`)
    }
    const zones = this.data.zones || []
    if (zones.length) lines.push('Protected areas: ' + zones.map(z => `${z.name} (${z.x} ${z.y} ${z.z}, r=${z.radius})`).join('; '))
    const journal = this.recentJournal(5)
    if (journal.length) lines.push('Recent memories: ' + journal.map(j => j.text).join(' | '))
    return lines.join('\n')
  }
}

module.exports = { Memory, slug, EXPLORE_CELL }
