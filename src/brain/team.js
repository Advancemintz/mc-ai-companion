'use strict'

// Teamwork between bots.
//
// Every bot tells the others what it is working on (its active goals). When two bots want the
// same kind of thing (both building, or one building while the other mines), each is told about
// the overlap and can propose a PACT. Whether they team up is up to them, and feelings decide what
// is even on the table: a bot never teams up with someone it really dislikes, and it only offers
// to share a base with a good friend.
//
// Pacts (plans):
//   build_together  both build the proposer's base (the builder engine compares the blueprint with
//                   the world, so two bots can work on the same one without getting in each
//                   other's way)
//   you_gather      the proposer builds; the other brings materials to a depot chest at the site
//   i_gather        the proposer gathers for the other's base
//   hunt            fight side by side (stay near the leader, kill what comes)
//   together        any shared goal; they coordinate by talking
// When the builder's base pauses for materials it posts what it needs; the gatherer drops them in
// the depot and says so; the builder picks them up when it goes back to building.
//
// In a fight that is going badly a bot calls for help; teammates and friends nearby are told.
// A shared base is co-owned: both use its chests and beds, nobody counts it as theft or snooping,
// and withdrawals are announced to the other owner.
//
// Messages travel through a link (teamLink.js): behind the scenes via the setup page when both
// bots were started there, or as /msg whispers otherwise. Everything here is plain data.

const lc = (s) => String(s || '').toLowerCase()
const slug = (s) => lc(s).replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '')
const now = () => Date.now()
const MIN = 60000

const DEFAULTS = { enabled: true, minFeeling: -10, shareBaseMinFeeling: 40, helpMinFeeling: 0, helpRadius: 96, goalShareMinutes: 5, whispers: true }

// What kind of goal is this? (rough keyword match; first hit wins)
const GOAL_TYPES = [
  ['nether', /\b(nether|netherite|portal|fortress|bastion|quartz|blaze)\b/],
  ['enchant', /\b(enchant\w*|bookshel\w*|lapis|mending)\b/],
  ['rail', /\b(rail|railway|railroad|tracks?|minecart)\b/],
  ['build', /\b(build\w*|house|base|home|castle|tower|farmhouse|manor|cottage|shelter|hut|bridge|walls?|storage|upgrade)\b/],
  ['mine', /\b(mine|mining|diamonds?|iron|ore|caves?|caving|dig|tunnel|coal|copper|gold|redstone|stone|cobblestone)\b/],
  ['wood', /\b(wood|logs?|trees?|planks|lumber)\b/],
  ['farm', /\b(farm\w*|crops?|wheat|animals?|pens?|breed\w*|cows?|sheep|pigs?|chickens?|food|ranch)\b/],
  ['fight', /\b(fight\w*|kill\w*|hunt\w*|monsters?|zombies?|skeletons?|creepers?|raid\w*|defend\w*|dragon|wither|mobs?)\b/],
  ['explore', /\b(explor\w*|discover\w*|villages?|biomes?|travel\w*|map)\b/],
  ['trade', /\b(trad\w*|villagers?|emeralds?)\b/]
]
function goalType (text) {
  const t = lc(text)
  let best = 'other'; let most = 0
  for (const [type, re] of GOAL_TYPES) {
    const n = (t.match(new RegExp(re.source, 'g')) || []).length
    if (n > most) { best = type; most = n } // most keyword hits wins; ties go to the earlier type
  }
  return best
}

// How two goal types fit together: 'same' (do it together), 'feeds' (a's work supplies b), or null.
const FEEDS = { mine: ['build', 'enchant', 'rail'], wood: ['build'], farm: ['fight', 'explore', 'nether'] }
function fit (a, b) {
  if (!a || !b || a === 'other' || b === 'other') return null
  if (a === b) return 'same'
  if ((FEEDS[a] || []).includes(b)) return 'feeds'
  if ((FEEDS[b] || []).includes(a)) return 'fed'
  return null
}

const PLANS = {
  build_together: { needsProject: 'proposer', roles: ['builder', 'builder'], say: 'build it together' },
  you_gather: { needsProject: 'proposer', roles: ['builder', 'gatherer'], say: 'I build, you bring materials' },
  i_gather: { needsProject: 'receiver', roles: ['gatherer', 'builder'], say: 'you build, I bring materials' },
  hunt: { needsProject: null, roles: ['leader', 'fighter'], say: 'fight side by side' },
  together: { needsProject: null, roles: ['partner', 'partner'], say: 'work on it together' }
}

// Building needs, as a builder reports them (keys shared by both sides).
const NEEDS = {
  blocks: { label: 'cobblestone or planks', re: /^(cobblestone|cobbled_deepslate|stone|stone_bricks|bricks|.*_planks|sandstone|andesite|diorite|granite|tuff|deepslate_bricks|mud_bricks)$/ },
  logs: { label: 'logs', re: /^(?!stripped_).*_log$|^stripped_.*_log$/ },
  filler: { label: 'dirt or cobblestone', re: /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/ },
  glass: { label: 'glass', re: /glass/ },
  doors: { label: 'doors', re: /_door$/ },
  torches: { label: 'torches', re: /^(torch|lantern)$/ },
  ladders: { label: 'ladders', re: /^ladder$/ }
}
function needsFromMissing (missing) {
  const out = {}
  for (const [group, n] of Object.entries(missing || {})) {
    const key = /^walls/.test(group) ? 'blocks' : /^frame/.test(group) ? 'logs' : /^filler/.test(group) ? 'filler' : /^glass/.test(group) ? 'glass' : /^doors/.test(group) ? 'doors' : /^torches/.test(group) ? 'torches' : /^ladders/.test(group) ? 'ladders' : null
    if (key) out[key] = (out[key] || 0) + n
  }
  return out
}
const describeNeeds = (needs) => Object.entries(needs || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${NEEDS[k]?.label || k}`).join(', ')

class Team {
  constructor ({ memory = null, social = null, config = {}, botName = '' } = {}) {
    this.memory = memory
    this.social = social
    this.config = config
    this.botName = botName
    this.send = () => {} // set by the link: send(envelope)
    this.notify = () => {} // set by the wiring: notify(text, wake)
    this.online = () => [] // names of other bots that can be reached now
    this._seen = new Set()
    this._nextId = 1
    this._lastGoals = ''
    this._lastGoalShare = 0
    this._lastHelp = 0
    this._ideaAt = new Map()
  }

  cfg () { return { ...DEFAULTS, ...(this.config?.team || {}) } }
  on () { return this.cfg().enabled !== false }
  isMe (n) { return lc(n) === lc(this.botName) }

  _store () {
    const empty = { peers: {}, pacts: [], help: [], nextPact: 1 }
    if (!this.memory) { this._local = this._local || empty; return this._local }
    const d = this.memory.data
    d.team = d.team || {}
    for (const [k, v] of Object.entries(empty)) if (d.team[k] === undefined) d.team[k] = v
    return d.team
  }

  _save () { this.memory?.save?.() }

  feeling (name) {
    try { return this.social?.on?.('feelings') ? this.social.feeling(name) : 0 } catch { return 0 }
  }

  _adjust (name, delta, why) { try { this.social?.adjust?.(name, delta, why) } catch {} }

  _out (to, kind, data = {}, say = '') {
    const env = { id: `${slug(this.botName)}-${now().toString(36)}-${this._nextId++}`, from: this.botName, to, kind, data, say, at: now() }
    this._seen.add(env.id)
    try { this.send(env) } catch {}
    return env
  }

  // ------------------------------------------------------------------ goals

  myGoals () {
    return (this.memory?.activeGoals?.() || []).map(g => ({ text: g.text, type: goalType(g.text) }))
  }

  // Tell the others what we're working on, when it changed or every few minutes.
  shareGoals ({ force = false, pos = null, home = null } = {}) {
    if (!this.on()) return false
    const goals = this.myGoals()
    const key = JSON.stringify(goals)
    const due = now() - this._lastGoalShare > this.cfg().goalShareMinutes * MIN
    if (!force && key === this._lastGoals && !due) return false
    if (!this.online().length) return false
    this._lastGoals = key
    this._lastGoalShare = now()
    this._out('*', 'goals', { goals: goals.slice(0, 4).map(g => g.text.slice(0, 60)), pos: pos ? [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)] : undefined, home: home ? [home.x, home.y, home.z] : undefined },
      goals.length ? `my plans: ${goals.slice(0, 2).map(g => g.text.slice(0, 40)).join('; ')}` : 'no big plans right now')
    return true
  }

  // Overlaps between my goals and another bot's.
  overlaps (name) {
    const peer = this._store().peers[lc(name)]
    if (!peer) return []
    const out = []
    for (const mine of this.myGoals()) {
      for (const text of peer.goals || []) {
        const theirs = goalType(text)
        const f = fit(mine.type, theirs)
        if (f) out.push({ mine: mine.text, theirs: text, type: mine.type, theirType: theirs, fit: f })
      }
    }
    return out
  }

  _suggest (name) {
    const ov = this.overlaps(name)
    if (!ov.length || this.activePacts().some(p => p.members.some(m => lc(m) === lc(name)))) return
    if (this.feeling(name) < this.cfg().minFeeling) return
    const o = ov[0]
    const k = `${lc(name)}:${o.type}:${o.theirType}`
    if (now() - (this._ideaAt.get(k) || 0) < 30 * MIN) return
    this._ideaAt.set(k, now())
    const plan = o.fit === 'same' ? (o.type === 'build' ? 'build_together' : o.type === 'fight' ? 'hunt' : 'together')
      : o.fit === 'feeds' ? 'i_gather' : 'you_gather'
    this.notify(`[team idea] ${name} is working on "${o.theirs}", which fits your goal "${o.mine}". You could team up: team mode propose, with ${name}, plan ${plan}${PLANS[plan].needsProject ? ' (name the base project)' : ''}. Only if you want to; you decide.`, false)
  }

  // ------------------------------------------------------------------ pacts

  pacts () { return this._store().pacts }
  activePacts () { return this.pacts().filter(p => p.status === 'active') }
  offers () { return this.pacts().filter(p => p.status === 'offered') }
  pact (id) { return this.pacts().find(p => String(p.id) === String(id).replace('#', '')) || null }
  pactForProject (name) { return this.activePacts().find(p => p.project && (lc(p.project.local) === lc(name) || (this.isMe(p.project.owner) && lc(p.project.name) === lc(name)))) || null }
  partners () { return [...new Set(this.activePacts().flatMap(p => p.members).filter(m => !this.isMe(m)))] }
  roleOf (p, name = this.botName) { return p.roles?.[lc(name)] || null }

  _sharedProjectRecord (projName) {
    const p = this.memory?.getProject?.(projName)
    if (!p || !(p.style === 'surface' || p.style === 'underground') || !p.origin) return null
    // Just what's needed to rebuild the blueprint (it has to fit in a few whispers).
    const out = { style: p.style, size: p.size, variant: p.variant, origin: p.origin, f: p.f, status: p.status === 'done' ? 'done' : 'in progress' }
    if (p.depth && p.style === 'underground') out.depth = p.depth
    if ((p.storeys || 1) > 1) out.storeys = p.storeys
    if (p.upgrades?.length) out.upgrades = p.upgrades
    return out
  }

  // Save someone else's base in my memory, so I can build on it (and it counts as ours).
  _adoptProject (owner, name, record, { home = false } = {}) {
    if (!this.memory || !record) return null
    const local = slug(`${owner}_${name}`)
    const existing = this.memory.getProject(local)
    const rec = { ...record, ...(existing || {}), sharedOwner: owner, sharedName: name, sharedWith: [...new Set([...(existing?.sharedWith || []), owner])] }
    if (!existing) rec.status = record.status === 'done' ? 'done' : 'in progress'
    this.memory.saveProject(local, rec)
    if (home) {
      const H = require('../body/homes'); const B = require('../body/builder'); const { Vec3 } = require('vec3')
      try {
        const o = new Vec3(rec.origin.x, rec.origin.y, rec.origin.z); const f = new Vec3(rec.f.x, 0, rec.f.z)
        const plan = B.toWorld(H.baseLayout(rec), o, f, B.rightOf(f))
        this.memory.setPlace(`shared_base_${slug(owner)}`, plan.inside, 'overworld', `the base I share with ${owner}`)
        if (!this.memory.getPlace('home')) this.memory.setPlace('home', plan.inside, 'overworld', `shared base with ${owner}`)
      } catch {}
    }
    try { require('../body/zones').invalidate() } catch {}
    return local
  }

  propose (to, { plan = 'together', goal = '', project = '' } = {}) {
    if (!this.on()) throw new Error('teamwork is switched off')
    if (!to || this.isMe(to)) throw new Error('say who to team up with')
    const def = PLANS[plan]
    if (!def) throw new Error(`plan must be one of: ${Object.keys(PLANS).join(', ')}`)
    const f = this.feeling(to)
    if (f < this.cfg().minFeeling) throw new Error(`you don't like ${to} enough to team up (feeling ${f})`)
    const s = this._store()
    const pact = { id: `${slug(this.botName)}${s.nextPact++}`, plan, goal: String(goal || '').slice(0, 80), leader: this.botName, members: [this.botName, to], roles: { [lc(this.botName)]: def.roles[0], [lc(to)]: def.roles[1] }, status: 'proposed', createdAt: now() }
    let record = null
    if (def.needsProject === 'proposer') {
      const name = project || (this.memory?.unfinishedProjects?.()[0]?.name) || 'base'
      record = this._sharedProjectRecord(name)
      if (!record) throw new Error(`there is no base project called "${name}" to share; start it with build_base first`)
      pact.project = { owner: this.botName, name, local: name }
    } else if (def.needsProject === 'receiver') pact.project = { owner: to, name: project || '' }
    s.pacts.push(pact)
    this._save()
    this._out(to, 'propose', { pact: this._wirePact(pact), record }, `want to team up? ${pact.goal || plan.replace('_', ' ')}: ${def.say}`)
    return pact
  }

  // Teammates working on my base: their digging and chest use there is fine.
  _setHelper (projName, name, on = true) {
    const proj = this.memory?.getProject?.(projName)
    if (!proj) return
    const h = new Set(proj.helpers || [])
    if (on) h.add(name); else h.delete(name)
    proj.helpers = [...h]
    this.memory.saveProject(projName, proj)
    try { require('../body/zones').invalidate() } catch {}
  }

  _wirePact (p) {
    return { id: p.id, plan: p.plan, goal: p.goal, leader: p.leader, members: p.members, roles: p.roles, project: p.project ? { owner: p.project.owner, name: p.project.name } : undefined, depot: p.depot }
  }

  accept (id) {
    const p = this.pact(id)
    if (!p || p.status !== 'offered') throw new Error(`no team offer #${id} waiting`)
    if (p.plan === 'share_base') {
      p.project.local = this._adoptProject(p.leader, p.project.name, p._record, { home: true })
      delete p._record
      p.status = 'active'
      p.since = now()
      this._save()
      this._out(p.leader, 'accept', { id: p.id }, "I'd love to! see you at home")
      this.memory?.addJournal?.(`Moved into ${p.leader}'s base "${p.project.name}"; we share it now.`)
      return p
    }
    const def = PLANS[p.plan]
    let record = null
    if (def.needsProject === 'receiver') {
      const name = p.project?.name || this.memory?.unfinishedProjects?.()[0]?.name || 'base'
      record = this._sharedProjectRecord(name)
      if (!record) throw new Error(`this plan needs a base project of yours to gather for, and you have none called "${name}" (start one with build_base)`)
      p.project = { owner: this.botName, name, local: name }
      this._setHelper(name, p.leader)
    }
    if (def.needsProject === 'proposer' && p._record) p.project.local = this._adoptProject(p.leader, p.project.name, p._record)
    delete p._record
    p.status = 'active'
    p.since = now()
    this._save()
    this._out(p.leader, 'accept', { id: p.id, project: p.project ? { owner: p.project.owner, name: p.project.name } : undefined, record }, `deal! let's ${def.say}`)
    this.memory?.addJournal?.(`Teamed up with ${p.leader}: ${p.goal || p.plan}.`)
    return p
  }

  decline (id, why = '') {
    const p = this.pact(id)
    if (!p || p.status !== 'offered') throw new Error(`no team offer #${id} waiting`)
    p.status = 'declined'
    this._save()
    this._out(p.leader, 'decline', { id: p.id, why: String(why).slice(0, 80) }, `no thanks${why ? `: ${why}` : ''}`)
    return p
  }

  leave (id, why = '') {
    const p = this.pact(id)
    if (!p || p.status !== 'active') throw new Error(`no active pact #${id}`)
    p.status = 'left'
    this._save()
    for (const m of p.members) if (!this.isMe(m)) this._out(m, 'leave', { id: p.id, why: String(why).slice(0, 80) }, `I'm out of our plan${why ? `: ${why}` : ''}`)
    return p
  }

  // The builder's base paused for materials (missing: builder survey groups).
  projectNeeds (projName, missing, depot = null) {
    const p = this.pactForProject(projName)
    if (!p) return null
    const needs = needsFromMissing(missing)
    if (!Object.keys(needs).length) return null
    p.needs = needs
    p.needsAt = now()
    if (depot) p.depot = depot
    this._save()
    for (const m of p.members) if (!this.isMe(m) && ['gatherer', 'builder'].includes(this.roleOf(p, m))) this._out(m, 'need', { id: p.id, needs, depot: p.depot }, `for our build I still need ${describeNeeds(needs)}`)
    return needs
  }

  projectFinished (projName) {
    const p = this.pactForProject(projName)
    if (!p) return null
    this._finish(p)
    for (const m of p.members) if (!this.isMe(m)) this._out(m, 'done', { id: p.id }, 'our build is finished! thanks for the help')
    return p
  }

  _finish (p) {
    p.status = 'done'
    p.doneAt = now()
    for (const m of p.members) if (!this.isMe(m)) this._adjust(m, 8, `we finished "${p.goal || p.plan}" together`)
    this.memory?.addJournal?.(`Finished "${p.goal || p.plan}" together with ${p.members.filter(m => !this.isMe(m)).join(', ')}.`)
    this._save()
  }

  // The gatherer dropped things in the depot.
  delivered (id, items, depot) {
    const p = this.pact(id)
    if (!p) return null
    p.depot = depot || p.depot
    for (const [name, n] of Object.entries(items)) {
      for (const [k, def] of Object.entries(NEEDS)) if (def.re.test(name) && p.needs?.[k]) { p.needs[k] = Math.max(0, p.needs[k] - n); break }
    }
    this._save()
    const what = Object.entries(items).map(([n, c]) => `${c} ${n}`).join(', ')
    for (const m of p.members) if (!this.isMe(m)) this._out(m, 'delivered', { id: p.id, items, depot: p.depot }, `dropped off ${what} in the depot chest`)
    return p
  }

  // Ask for help in a fight that is going badly.
  askHelp (pos, threats = [], { force = false } = {}) {
    if (!this.on() || (!force && now() - this._lastHelp < 45000)) return 0
    const friends = this.online().filter(n => this.partners().some(p => lc(p) === lc(n)) || this.feeling(n) >= this.cfg().helpMinFeeling)
    if (!friends.length) return 0
    this._lastHelp = now()
    const where = [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)]
    for (const n of friends) this._out(n, 'help', { pos: where, threats: threats.slice(0, 4) }, `help! ${threats.length ? threats.join(', ') : 'monsters'} at ${where.join(' ')}`)
    return friends.length
  }

  coming (to) { this._out(to, 'coming', {}, 'hang on, coming to help!') }
  helped (to, kills) { this._out(to, 'helped', { kills }, kills ? `got ${kills} of them!` : 'all clear') }

  latestHelp (maxAgeMs = 2 * MIN) {
    return this._store().help.filter(h => now() - h.at <= maxAgeMs).sort((a, b) => b.at - a.at)[0] || null
  }

  // ------------------------------------------------------------------ shared bases

  offerBase (to, projName) {
    if (!this.on()) throw new Error('teamwork is switched off')
    const f = this.feeling(to)
    const need = this.cfg().shareBaseMinFeeling
    if (f < need) throw new Error(`you'd only share your base with a good friend (you feel ${f} about ${to}; it takes ${need})`)
    const record = this._sharedProjectRecord(projName)
    if (!record) throw new Error(`you have no base called "${projName}"`)
    const s = this._store()
    const pact = { id: `${slug(this.botName)}${s.nextPact++}`, plan: 'share_base', goal: `share base "${projName}"`, leader: this.botName, members: [this.botName, to], roles: { [lc(this.botName)]: 'owner', [lc(to)]: 'co-owner' }, project: { owner: this.botName, name: projName, local: projName }, status: 'proposed', createdAt: now() }
    s.pacts.push(pact)
    this._save()
    this._out(to, 'propose', { pact: this._wirePact(pact), record }, `want to move in? my base "${projName}" is yours too if you like`)
    return pact
  }

  // Names of the bots who share the base at this position (from your memory).
  coOwnersAt (pos) {
    try { return require('../body/zones').coOwnersAt(this.memory, pos) } catch { return [] }
  }

  tellTook (pos, items) {
    const owners = this.coOwnersAt(pos)
    const what = Object.entries(items).map(([n, c]) => `${c} ${n}`).join(', ')
    for (const o of owners) if (!this.isMe(o)) this._out(o, 'took', { items, pos: [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)] }, `took ${what} from our chest`)
  }

  // ------------------------------------------------------------------ receiving

  receive (env, { distanceTo = null } = {}) {
    if (!env || !env.kind || !env.from || this.isMe(env.from) || !this.on()) return null
    if (env.id && this._seen.has(env.id)) return null
    if (env.id) { this._seen.add(env.id); if (this._seen.size > 500) this._seen = new Set([...this._seen].slice(-250)) }
    const s = this._store()
    const from = env.from
    const d = env.data || {}
    switch (env.kind) {
      case 'goals': {
        s.peers[lc(from)] = { name: from, goals: (d.goals || []).map(String).slice(0, 4), pos: d.pos, home: d.home, at: now() }
        this._save()
        this._suggest(from)
        return 'goals'
      }
      case 'propose': {
        const p = d.pact
        if (!p?.id || !PLANS[p.plan] && p.plan !== 'share_base') return null
        const f = this.feeling(from)
        const need = p.plan === 'share_base' ? this.cfg().shareBaseMinFeeling : this.cfg().minFeeling
        if (f < need) {
          this._out(from, 'decline', { id: p.id, why: 'not with you' }, p.plan === 'share_base' ? "thanks, but I'd rather keep my own place" : "no, I'd rather not work with you")
          return 'declined'
        }
        if (s.pacts.some(x => x.id === p.id)) return null
        s.pacts.push({ ...p, status: 'offered', offeredAt: now(), _record: d.record || null })
        this._save()
        const what = p.plan === 'share_base' ? `to share their base "${p.project?.name}" with you (you'd both own it: its chests, beds and safety)` : `"${p.goal || p.plan}": ${PLANS[p.plan].say}${p.project?.name ? ` (their base "${p.project.name}")` : ''}`
        this.notify(`[team] ${from} proposes ${what}. Accept with team mode accept, id ${p.id}, or decline (team mode decline). You feel ${f} about them.`, true)
        return 'offered'
      }
      case 'accept': {
        const p = this.pact(d.id)
        if (!p || p.status !== 'proposed') return null
        p.status = 'active'
        p.since = now()
        if (p.plan === 'share_base') {
          const proj = this.memory?.getProject?.(p.project.name)
          if (proj) { proj.sharedWith = [...new Set([...(proj.sharedWith || []), from])]; this.memory.saveProject(p.project.name, proj); try { require('../body/zones').invalidate() } catch {} }
          this._adjust(from, 5, 'moved into my base')
          this.notify(`[team] ${from} accepted: your base "${p.project.name}" is now shared with them. Their use of its chests and beds is fine.`, true)
        } else {
          if (PLANS[p.plan].needsProject === 'receiver' && d.record) {
            p.project = { owner: from, name: d.project?.name, local: this._adoptProject(from, d.project?.name, d.record) }
          }
          if (PLANS[p.plan].needsProject === 'proposer' && p.project?.local) this._setHelper(p.project.local, from)
          this.notify(`[team] ${from} agreed to "${p.goal || p.plan}" (${PLANS[p.plan].say}). ${this._roleHint(p)}`, true)
        }
        this._save()
        return 'active'
      }
      case 'decline': {
        const p = this.pact(d.id)
        if (!p || p.status !== 'proposed') return null
        p.status = 'declined'
        this._save()
        this.notify(`[team] ${from} turned down "${p.goal || p.plan}"${d.why ? `: ${d.why}` : ''}.`, false)
        return 'declined'
      }
      case 'leave': {
        const p = this.pact(d.id)
        if (!p || p.status !== 'active') return null
        p.status = 'left'
        if (p.project?.local && this.isMe(p.project.owner)) this._setHelper(p.project.local, from, false)
        this._save()
        this._adjust(from, -3, `walked out on our plan "${p.goal || p.plan}"`)
        this.notify(`[team] ${from} left your plan "${p.goal || p.plan}"${d.why ? `: ${d.why}` : ''}.`, true)
        return 'left'
      }
      case 'need': {
        const p = this.pact(d.id)
        if (!p || p.status !== 'active') return null
        p.needs = d.needs || {}
        p.needsAt = now()
        if (d.depot) p.depot = d.depot
        this._save()
        if (this.roleOf(p) === 'gatherer') this.notify(`[team] ${from} needs ${describeNeeds(p.needs)} for your shared build. Gather them, then team mode deliver to drop them in the depot.`, true)
        else this.notify(`[team] ${from} says the build still needs ${describeNeeds(p.needs)}.`, false)
        return 'need'
      }
      case 'delivered': {
        const p = this.pact(d.id)
        if (!p) return null
        p.depot = d.depot || p.depot
        p.deliveries = [...(p.deliveries || []), { from, items: d.items || {}, at: now() }].slice(-10)
        p.uncollected = true
        this._save()
        const what = Object.entries(d.items || {}).map(([n, c]) => `${c} ${n}`).join(', ')
        this._adjust(from, 3, 'brought materials for our build')
        this.notify(`[team] ${from} dropped off ${what} in the depot chest${p.depot ? ` at ${p.depot.join(' ')}` : ''}. Continue the build (build_base picks them up).`, true)
        return 'delivered'
      }
      case 'done': {
        const p = this.pact(d.id)
        if (!p || p.status !== 'active') return null
        this._finish(p)
        this.notify(`[team] ${from}: the shared build "${p.goal || p.project?.name || p.plan}" is finished!`, true)
        return 'done'
      }
      case 'help': {
        const pos = d.pos
        const dist = typeof distanceTo === 'function' && pos ? distanceTo(pos) : null
        const partner = this.partners().some(p => lc(p) === lc(from))
        if (!partner && this.feeling(from) < this.cfg().helpMinFeeling) return null
        if (dist !== null && dist > this.cfg().helpRadius) return null
        s.help = [...s.help.filter(h => lc(h.from) !== lc(from)), { from, pos, threats: d.threats || [], at: now() }].slice(-5)
        this._save()
        this.notify(`[team] ${from} is in trouble${pos ? ` at ${pos.join(' ')}` : ''}${d.threats?.length ? ` (${d.threats.join(', ')})` : ''}${dist !== null ? `, ${Math.round(dist)} blocks away` : ''}${partner ? '; they are your teammate' : ''}. Help with help_fight (player ${from}) if you want to.`, true)
        return 'help'
      }
      case 'coming': { this.notify(`[team] ${from} is coming to help you.`, false); return 'coming' }
      case 'helped': {
        s.help = s.help.filter(h => lc(h.from) !== lc(from))
        this._adjust(from, 5, 'came to help me in a fight')
        this.notify(`[team] ${from} came to your rescue${d.kills ? ` and killed ${d.kills}` : ''}.`, false)
        this._save()
        return 'helped'
      }
      case 'took': {
        const what = Object.entries(d.items || {}).map(([n, c]) => `${c} ${n}`).join(', ')
        this.notify(`[team] ${from} took ${what} from your shared chest${d.pos ? ` at ${d.pos.join(' ')}` : ''} (that's fine, you share it).`, false)
        return 'took'
      }
    }
    return null
  }

  _roleHint (p) {
    const role = this.roleOf(p)
    const proj = p.project?.local ? ` "${p.project.local}"` : ''
    if (role === 'builder') return `You build${proj}: run build_base${proj ? ` with name${proj}` : ''}; when it pauses your partner is told what to bring.`
    if (role === 'gatherer') return `You gather: wait for the list of materials (or ask), collect them, then team mode deliver.`
    if (role === 'leader') return 'You lead the hunt: go where the monsters are; your partner stays close.'
    if (role === 'fighter') return `Stay close to ${p.leader} and fight with them (guard with player ${p.leader}).`
    return 'Coordinate by talking.'
  }

  // ------------------------------------------------------------------ for the brain

  stateLines () {
    if (!this.on()) return []
    const lines = []
    for (const p of this.activePacts()) {
      const others = p.members.filter(m => !this.isMe(m)).join(', ')
      const role = this.roleOf(p)
      const needs = describeNeeds(p.needs)
      lines.push(`Team pact #${p.id} with ${others}: "${p.goal || p.plan}" (${PLANS[p.plan]?.say || 'shared base'}); your role: ${role}.${needs ? ` Still needed: ${needs}.` : ''}${p.uncollected ? ' Materials are waiting in the depot chest.' : ''} ${this._roleHint(p)}`)
    }
    for (const p of this.offers()) lines.push(`Team offer #${p.id} from ${p.leader}: "${p.goal || p.plan}" (team mode accept / decline, id ${p.id}).`)
    const h = this.latestHelp()
    if (h) lines.push(`HELP WANTED: ${h.from} is under attack at ${(h.pos || []).join(' ')} (${Math.round((now() - h.at) / 1000)}s ago): help_fight player ${h.from}.`)
    const peers = Object.values(this._store().peers).filter(p => now() - p.at < 30 * MIN && p.goals?.length).slice(0, 4)
    if (peers.length) lines.push(`Other bots' plans: ${peers.map(p => `${p.name}: ${p.goals.slice(0, 2).join('; ')}`).join(' | ')}`)
    return lines
  }

  status () {
    const lines = this.stateLines()
    const done = this.pacts().filter(p => p.status === 'done').slice(-3)
    if (done.length) lines.push(`Done together: ${done.map(p => `"${p.goal || p.plan}" with ${p.members.filter(m => !this.isMe(m)).join(', ')}`).join('; ')}`)
    return lines.length ? lines.join('\n') : 'No team plans. Other bots will tell you their plans when they are online.'
  }
}

// Background senses: share goals now and then, and call for help when a fight goes badly.
function startTeam (bot, team, { brainNotify = () => {}, memory = null } = {}) {
  if (!team) return { stop () {} }
  team.notify = brainNotify
  const W = require('../body/world')
  const iv1 = setInterval(() => {
    try {
      if (!bot.entity) return
      const home = memory?.getPlace?.('home')
      team.shareGoals({ pos: bot.entity.position, home })
    } catch {}
  }, 10000)
  const iv2 = setInterval(() => {
    try {
      if (!bot.entity || bot.health > 10) return
      const hostiles = Object.values(bot.entities || {}).filter(e => e?.position && W.isHostile(e) && e.position.distanceTo(bot.entity.position) < 10)
      if (hostiles.length) team.askHelp(bot.entity.position, hostiles.map(e => e.name))
    } catch {}
  }, 2000)
  iv1.unref?.(); iv2.unref?.()
  return { stop () { clearInterval(iv1); clearInterval(iv2) } }
}

module.exports = { Team, startTeam, goalType, fit, PLANS, NEEDS, needsFromMissing, describeNeeds, DEFAULTS }
