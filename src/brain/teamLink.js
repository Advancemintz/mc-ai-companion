'use strict'

// How team messages get from one bot to another.
//
// 1. Behind the scenes: bots started from the setup page are child processes of it, and the page
//    passes team messages between them (it also tells each bot which names it can reach this way).
// 2. Otherwise: an in-game whisper. "/msg Bob want to team up? ... #T{...}": a readable line for
//    anyone watching, and a compact tagged payload at the end that the other bot reads. Whispers
//    are queued (one every ~1.5 s) so the server doesn't kick anyone for spam.

const lc = (s) => String(s || '').toLowerCase()
const TAG = '#T'
const MAX_CHAT = 250

// Whisper lines for an envelope. One line when it fits ("<say> #T{json}"); otherwise the JSON is
// cut into numbered parts ("<say> #Pab12 1/3|<part>") that the other side puts back together.
function encodeWhisper (env, maxLen = MAX_CHAT) {
  const prefix = `/msg ${env.to} `
  const say = String(env.say || '').replace(/#/g, '').slice(0, 120)
  const json = JSON.stringify({ k: env.kind, i: env.id, d: env.data || {} })
  for (const s of [say, say.slice(0, 40), '']) {
    const line = `${prefix}${s ? s + ' ' : ''}${TAG}${json}`
    if (line.length <= maxLen) return [line]
  }
  const sid = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  const head = say.slice(0, 40)
  const room = maxLen - prefix.length - `#P${sid}99/99|`.length - 1
  const firstRoom = room - (head ? head.length + 1 : 0)
  const parts = [json.slice(0, firstRoom)]
  for (let i = firstRoom; i < json.length; i += room) parts.push(json.slice(i, i + room))
  if (parts.length > 99) return []
  return parts.map((part, n) => `${prefix}${n === 0 && head ? head + ' ' : ''}#P${sid}${n + 1}/${parts.length}|${part}`)
}

function parsePayload (from, json, say = '') {
  try {
    const p = JSON.parse(json)
    if (!p || typeof p.k !== 'string') return null
    return { id: p.i, from, kind: p.k, data: p.d || {}, say: say.trim(), via: 'whisper' }
  } catch { return null }
}

const PART = /#P([a-z0-9]{4})(\d+)\/(\d+)\|/

// Single-line team whisper -> envelope (or null). Multi-part ones go through a Reassembler.
function decodeWhisper (from, message) {
  const at = String(message || '').lastIndexOf(TAG + '{')
  if (at < 0) return null
  return parsePayload(from, message.slice(at + TAG.length), message.slice(0, at))
}

class Reassembler {
  constructor () { this.buf = new Map() }
  feed (from, message) {
    const m = String(message || '')
    if (m.includes(TAG + '{')) return decodeWhisper(from, m)
    const hit = m.match(PART)
    if (!hit) return null
    const [, sid, nS, tS] = hit
    const n = Number(nS); const t = Number(tS)
    const key = `${String(from).toLowerCase()}:${sid}`
    const entry = this.buf.get(key) || { parts: [], say: '', at: Date.now(), total: t }
    entry.parts[n - 1] = m.slice(hit.index + hit[0].length)
    if (n === 1) entry.say = m.slice(0, hit.index)
    this.buf.set(key, entry)
    for (const [k, e] of this.buf) if (Date.now() - e.at > 60000) this.buf.delete(k)
    if (entry.parts.filter(x => x !== undefined).length < entry.total) return null
    this.buf.delete(key)
    return parsePayload(from, entry.parts.join(''), entry.say)
  }
}

const isTeamWhisper = (message) => String(message || '').includes(TAG + '{') || PART.test(String(message || ''))

function createLink ({ bot, team, config = {}, send = null, log = null } = {}) {
  const ipcNames = new Set() // bots reachable through the setup page
  const parts = new Reassembler()
  const queue = []
  let timer = null
  const ipc = send || (typeof process.send === 'function' ? (m) => process.send(m) : null)
  const knownBots = () => [...new Set([...(config.bot?.otherBots || []), ...Object.values(team._store().peers || {}).map(p => p.name)])].filter(n => n && lc(n) !== lc(bot.username))
  const onlineNow = () => knownBots().filter(n => ipcNames.has(lc(n)) || bot.players?.[n] || Object.keys(bot.players || {}).some(p => lc(p) === lc(n)))

  const pump = () => {
    if (!queue.length) { timer = null; return }
    const line = queue.shift()
    try { bot.chat(line) } catch {}
    timer = setTimeout(pump, 1500)
    timer.unref?.()
  }
  const whisper = (env) => {
    if (team.cfg().whispers === false) return false
    const lines = encodeWhisper(env)
    if (!lines.length) { log?.debug?.(`team message ${env.kind} too long to whisper`); return false }
    queue.push(...lines)
    if (queue.length > 40) queue.splice(0, queue.length - 40)
    if (!timer) pump()
    return true
  }

  team.online = onlineNow
  team.send = (env) => {
    const targets = env.to === '*' ? onlineNow() : [env.to]
    for (const to of targets) {
      const one = { ...env, to }
      if (ipc && ipcNames.has(lc(to))) { try { ipc({ type: 'team', msg: one }); continue } catch {} }
      whisper(one)
    }
  }

  const distanceTo = (pos) => {
    const me = bot.entity?.position
    if (!me || !Array.isArray(pos)) return null
    return Math.hypot(me.x - pos[0], me.z - pos[2])
  }

  return {
    // From the setup page: { type: 'team', msg } or { type: 'team-roster', names }.
    onIpc (m) {
      if (!m) return false
      if (m.type === 'team-roster') { ipcNames.clear(); for (const n of m.names || []) if (lc(n) !== lc(bot.username)) ipcNames.add(lc(n)); return true }
      if (m.type === 'team' && m.msg) { team.receive({ ...m.msg, via: 'ipc' }, { distanceTo }); return true }
      return false
    },
    // A whisper; returns true if it was a team message (so it isn't treated as chat).
    onWhisper (from, message) {
      if (!isTeamWhisper(message)) return false
      const env = parts.feed(from, message)
      if (env) team.receive(env, { distanceTo })
      return true
    },
    ipcNames,
    onlineNow,
    hello () { if (ipc) try { ipc({ type: 'team-hello', name: bot.username }) } catch {} }
  }
}

module.exports = { createLink, encodeWhisper, decodeWhisper, isTeamWhisper, Reassembler, MAX_CHAT }
