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
    const mine = this.getProject('mine')
    if (mine) {
      const levels = Object.entries(mine.levels || {}).map(([y, l]) => `y=${y} tunnel ${l.progress}`).join(', ')
      lines.push(`Your mine: entrance at ${mine.origin.x} ${mine.origin.y + 1} ${mine.origin.z}, stairs down ${mine.depth} blocks${levels ? `, levels: ${levels}` : ''} (use mine to keep digging)`)
    }
    for (const r of this.railways()) {
      lines.push(`Railway "${r.name}" to ${r.toName}: ${r.status === 'done' ? 'finished' : `${r.built || 0}/${r.cols.length} blocks built${r.needs ? `, needs ${r.needs}` : ''} (build_railway to continue)`}`)
    }
    const zones = this.data.zones || []
    if (zones.length) lines.push('Protected areas: ' + zones.map(z => `${z.name} (${z.x} ${z.y} ${z.z}, r=${z.radius})`).join('; '))
    const journal = this.recentJournal(5)
    if (journal.length) lines.push('Recent memories: ' + journal.map(j => j.text).join(' | '))
    return lines.join('\n')
  }
}

module.exports = { Memory, slug }
