'use strict'

// Starts, stops and talks to bot processes for the setup page.
//
// Each bot runs as its own `node src/index.js bots/<name>.json` child process, exactly as if you'd
// started it in a terminal. The page talks to it over Node's built-in IPC channel:
//   page -> bot:  { type: 'command', text }  (counts as the console, so ! commands work)
//                 { type: 'quit' }
//   bot -> page:  { type: 'status', connected, health, food, position, activity, ... } every 2 s
// Everything the bot prints is kept as a rolling log the page can show.

const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')

const MAX_LOG = 600
const ANSI = /\x1b\[[0-9;]*m/g // eslint-disable-line no-control-regex

const hashOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex')

class Processes extends EventEmitter {
  constructor ({ roster, root = process.cwd(), script = path.join(__dirname, '..', 'index.js'), nodePath = process.execPath } = {}) {
    super()
    this.roster = roster
    this.root = root
    this.script = script
    this.nodePath = nodePath
    this.procs = new Map() // bot id -> entry
  }

  entry (id) {
    if (!this.procs.has(id)) this.procs.set(id, { id, running: false, log: [], seq: 0, status: null, startedAt: null, exitCode: null, configHash: null })
    return this.procs.get(id)
  }

  _log (e, line, kind = 'out') {
    e.seq++
    e.log.push({ seq: e.seq, at: Date.now(), kind, text: String(line).replace(ANSI, '').slice(0, 1000) })
    if (e.log.length > MAX_LOG) e.log.splice(0, e.log.length - MAX_LOG)
    this.emit('log', e.id)
  }

  start (bot) {
    const e = this.entry(bot.id)
    if (e.running) return e
    this.roster.writeConfigs()
    const cfgPath = this.roster.configPath(bot.name)
    e.configHash = hashOf(this.roster.buildConfig(bot))
    e.name = bot.name
    e.status = null
    e.exitCode = null
    e.startedAt = Date.now()
    e.running = true
    this._log(e, `starting ${bot.name}...`, 'manager')
    const child = spawn(this.nodePath, [this.script, cfgPath], {
      cwd: this.root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NO_COLOR: '1', MC_AI_MANAGED: '1' },
      windowsHide: true
    })
    e.child = child
    readline.createInterface({ input: child.stdout }).on('line', (l) => this._log(e, l))
    readline.createInterface({ input: child.stderr }).on('line', (l) => this._log(e, l, 'err'))
    child.on('message', (m) => {
      if (m && m.type === 'status') { e.status = { ...m, at: Date.now() }; this.emit('status', e.id) }
      if (m && m.type === 'team-hello') { e.gameName = String(m.name || ''); this._roster() }
      if (m && m.type === 'team' && m.msg) this._relay(e, m.msg)
    })
    child.on('error', (err) => this._log(e, `could not start: ${err.message}`, 'err'))
    child.on('exit', (code, signal) => {
      e.running = false
      e.child = null
      e.exitCode = code
      e.status = null
      e.gameName = null
      this._roster()
      this._log(e, `${bot.name} stopped${code ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}`, 'manager')
      this.emit('exit', e.id)
    })
    return e
  }

  // Teamwork: pass a team message on to the bot(s) it is for, behind the scenes.
  _relay (from, msg) {
    const name = (x) => String(x.gameName || x.name || '').toLowerCase()
    const to = String(msg.to || '').toLowerCase()
    for (const e of this.procs.values()) {
      if (!e.running || !e.child || e === from) continue
      if (to !== '*' && name(e) !== to) continue
      try { e.child.send({ type: 'team', msg }) } catch {}
    }
    this.emit('team', { from: from.gameName || from.name, msg })
  }

  // Tell every running bot which others it can reach this way.
  _roster () {
    const names = [...this.procs.values()].filter(e => e.running && e.child).map(e => e.gameName || e.name).filter(Boolean)
    for (const e of this.procs.values()) {
      if (!e.running || !e.child) continue
      try { e.child.send({ type: 'team-roster', names }) } catch {}
    }
  }

  // Ask the bot to log off cleanly; force it after a few seconds.
  stop (id, { timeoutMs = 5000 } = {}) {
    const e = this.procs.get(id)
    if (!e || !e.running || !e.child) return Promise.resolve(false)
    const child = e.child
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(true) }
      child.once('exit', done)
      try { child.send({ type: 'quit' }) } catch { try { child.kill() } catch {} }
      const t = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    })
  }

  async restart (bot) {
    await this.stop(bot.id)
    return this.start(bot)
  }

  command (id, text) {
    const e = this.procs.get(id)
    if (!e || !e.running || !e.child) { const err = new Error('that bot is not running'); err.status = 409; throw err }
    const t = String(text || '').trim().slice(0, 400)
    if (!t) { const err = new Error('nothing to send'); err.status = 400; throw err }
    e.child.send({ type: 'command', text: t })
    this._log(e, `> ${t}`, 'manager')
  }

  info (bot) {
    const e = this.procs.get(bot.id)
    if (!e) return { running: false, status: null, needsRestart: false, exitCode: null, startedAt: null }
    const needsRestart = e.running && e.configHash !== hashOf(this.roster.buildConfig(bot))
    return { running: e.running, status: e.status, needsRestart, exitCode: e.exitCode, startedAt: e.startedAt }
  }

  logs (id, since = 0) {
    const e = this.procs.get(id)
    if (!e) return { lines: [], seq: 0 }
    return { lines: e.log.filter(l => l.seq > since), seq: e.seq }
  }

  async stopAll () {
    await Promise.all([...this.procs.keys()].map(id => this.stop(id)))
  }
}

module.exports = { Processes }
