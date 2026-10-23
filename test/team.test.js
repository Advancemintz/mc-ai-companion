'use strict'

// Teamwork between bots, as logic: two Team objects wired straight to each other, the whisper
// format, the link that picks a route, and the setup page passing messages along.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { Team, goalType, fit, needsFromMissing, describeNeeds } = require('../src/brain/team')
const L = require('../src/brain/teamLink')
const { Social } = require('../src/brain/social')
const { Memory } = require('../src/brain/memory')
const Z = require('../src/body/zones')

function pair () {
  const mk = (name) => {
    const memory = new Memory(null)
    const config = { social: {}, team: {} }
    const social = new Social(memory, config, { botName: name })
    const team = new Team({ memory, social, config, botName: name })
    team.notes = []
    team.notify = (text, wake) => team.notes.push({ text, wake })
    return { memory, social, team }
  }
  const a = mk('Pip'); const b = mk('Bob')
  a.team.online = () => ['Bob']; b.team.online = () => ['Pip']
  a.team.send = (env) => b.team.receive(JSON.parse(JSON.stringify(env)), { distanceTo: () => 20 })
  b.team.send = (env) => a.team.receive(JSON.parse(JSON.stringify(env)), { distanceTo: () => 20 })
  return { a, b }
}

const BASE = { style: 'surface', size: 'small', variant: 'cottage', upgrades: [], origin: { x: 40, y: 63, z: -10 }, f: { x: 0, z: -1 }, status: 'in progress', progress: 30, createdAt: 'x' }

test('goal types and how they fit', () => {
  assert.strictEqual(goalType('Build a big stone castle'), 'build')
  assert.strictEqual(goalType('find diamonds'), 'mine')
  assert.strictEqual(goalType('get netherite armor'), 'nether')
  assert.strictEqual(goalType('kill the zombies near home'), 'fight')
  assert.strictEqual(goalType('get rich'), 'other')
  assert.strictEqual(fit('build', 'build'), 'same')
  assert.strictEqual(fit('mine', 'build'), 'feeds')
  assert.strictEqual(fit('build', 'mine'), 'fed')
  assert.strictEqual(fit('explore', 'enchant'), null)
  const n = needsFromMissing({ 'walls/floor/roof (planks or cobblestone)': 40, 'frame (logs, or more planks/cobblestone)': 8, 'glass (optional)': 4 })
  assert.deepStrictEqual(n, { blocks: 40, logs: 8, glass: 4 })
  assert.strictEqual(describeNeeds(n), '40 cobblestone or planks, 8 logs, 4 glass')
})

test('sharing goals: each side hears the other\'s plans and gets an idea that fits', () => {
  const { a, b } = pair()
  a.memory.addGoal('build a big stone castle')
  b.memory.addGoal('mine lots of iron and coal')
  assert.ok(a.team.shareGoals({ force: true }))
  assert.ok(b.team.shareGoals({ force: true }))
  assert.match(b.team.notes.at(-1).text, /Pip is working on "build a big stone castle".*plan i_gather/)
  assert.match(a.team.notes.at(-1).text, /Bob is working on "mine lots of iron and coal".*plan you_gather/)
  assert.match(a.team.stateLines().join('\n'), /Other bots' plans: Bob: mine lots of iron and coal/)
  // Not again for a while.
  const n = a.team.notes.length
  b.team.shareGoals({ force: true })
  assert.strictEqual(a.team.notes.length, n)
})

test('a pact: Pip builds, Bob gathers; needs, delivery, finishing together', () => {
  const { a, b } = pair()
  a.memory.saveProject('base', { ...BASE })
  const p = a.team.propose('Bob', { plan: 'you_gather', goal: 'a cottage for Pip', project: 'base' })
  assert.strictEqual(p.status, 'proposed')
  assert.match(b.team.notes.at(-1).text, /Pip proposes "a cottage for Pip": I build, you bring materials.*id pip1/)
  assert.ok(b.team.notes.at(-1).wake)
  b.team.accept('pip1')
  const ap = a.team.pact('pip1'); const bp = b.team.pact('pip1')
  assert.strictEqual(ap.status, 'active'); assert.strictEqual(bp.status, 'active')
  assert.strictEqual(b.team.roleOf(bp), 'gatherer')
  // Bob keeps a copy of Pip's base, and both count it as theirs.
  const copy = b.memory.getProject('pip_base')
  assert.deepStrictEqual([copy.sharedOwner, copy.origin], ['Pip', BASE.origin])
  assert.deepStrictEqual(a.memory.getProject('base').helpers, ['Bob'])
  Z.invalidate()
  const inside = new Vec3(40, 64, -13)
  assert.deepStrictEqual(Z.coOwnersAt(a.memory, inside), ['Bob'])
  Z.invalidate()
  assert.deepStrictEqual(Z.coOwnersAt(b.memory, inside), ['Pip'])
  // The build pauses: Bob is told what to bring.
  a.team.projectNeeds('base', { 'walls/floor/roof (planks or cobblestone)': 40, 'glass (optional)': 4 }, [41, 64, -6])
  assert.deepStrictEqual(bp.needs, { blocks: 40, glass: 4 })
  assert.match(b.team.notes.at(-1).text, /Pip needs 40 cobblestone or planks, 4 glass .* team mode deliver/)
  assert.match(b.team.stateLines()[0], /your role: gatherer. Still needed: 40 cobblestone or planks, 4 glass/)
  const before = a.social.feeling('Bob')
  b.team.delivered('pip1', { cobblestone: 30 }, [41, 64, -6])
  assert.deepStrictEqual(bp.needs, { blocks: 10, glass: 4 })
  assert.ok(ap.uncollected)
  assert.match(a.team.notes.at(-1).text, /Bob dropped off 30 cobblestone in the depot chest at 41 64 -6/)
  assert.ok(a.social.feeling('Bob') > before)
  a.team.projectFinished('base')
  assert.strictEqual(ap.status, 'done'); assert.strictEqual(bp.status, 'done')
  assert.ok(b.social.feeling('Pip') >= 8)
  assert.match(b.team.notes.at(-1).text, /finished!/)
})

test('build_together and i_gather put the base with the right bot', () => {
  const { a, b } = pair()
  b.memory.saveProject('base', { ...BASE })
  a.team.propose('Bob', { plan: 'i_gather', goal: 'help Bob' })
  b.team.accept(b.team.offers()[0].id)
  const ap = a.team.activePacts()[0]
  assert.strictEqual(a.team.roleOf(ap), 'gatherer')
  assert.strictEqual(ap.project.local, 'bob_base')
  assert.ok(a.memory.getProject('bob_base'))
  assert.deepStrictEqual(b.memory.getProject('base').helpers, ['Pip'])
  assert.throws(() => a.team.propose('Bob', { plan: 'build_together', project: 'nope' }), /no base project called "nope"/)
})

test('feelings decide: no pact with someone you dislike; shared bases only for good friends', () => {
  const { a, b } = pair()
  a.memory.saveProject('base', { ...BASE, status: 'done' })
  b.social.adjust('Pip', -40, 'stole from me')
  a.team.propose('Bob', { plan: 'together', goal: 'explore the mountains' })
  assert.strictEqual(a.team.pacts()[0].status, 'declined')
  assert.match(a.team.notes.at(-1).text, /Bob turned down/)
  assert.throws(() => a.team.offerBase('Bob', 'base'), /only share your base with a good friend/)
  a.social.adjust('Bob', 50, 'old friend')
  assert.throws(() => a.team.propose('Pip', {}), /say who/)
  a.team.offerBase('Bob', 'base')
  assert.strictEqual(a.team.pacts().at(-1).status, 'declined', 'Bob still dislikes Pip, so he says no')
  b.social.adjust('Pip', 90, 'made up')
  const offer = a.team.offerBase('Bob', 'base')
  b.team.accept(offer.id)
  assert.deepStrictEqual(a.memory.getProject('base').sharedWith, ['Bob'])
  assert.ok(b.memory.getPlace('home'), 'Bob had no home, so the shared base became home')
  assert.ok(b.memory.getPlace('shared_base_pip'))
  assert.match(a.memory.summary({ pos: new Vec3(0, 64, 0), dimension: 'overworld' }), /Your base "base".*\(shared with Bob\)/)
})

test('help in a fight: friends nearby are told; the helper is thanked', () => {
  const { a, b } = pair()
  assert.strictEqual(a.team.askHelp(new Vec3(5, 64, 5), ['zombie', 'skeleton']), 1)
  assert.match(b.team.notes.at(-1).text, /Pip is in trouble at 5 64 5 \(zombie, skeleton\), 20 blocks away/)
  assert.match(b.team.stateLines().join('\n'), /HELP WANTED: Pip/)
  assert.strictEqual(a.team.askHelp(new Vec3(5, 64, 5), []), 0, 'not twice in a row')
  b.team.helped('Pip', 2)
  assert.match(a.team.notes.at(-1).text, /Bob came to your rescue and killed 2/)
  assert.ok(a.social.feeling('Bob') >= 5)
  // Too far away, or a disliked caller: ignored.
  const far = b.team.receive({ id: 'x1', from: 'Pip', kind: 'help', data: { pos: [900, 64, 0] } }, { distanceTo: () => 900 })
  assert.strictEqual(far, null)
})

test('leaving a pact costs goodwill; the base helper is removed', () => {
  const { a, b } = pair()
  a.memory.saveProject('base', { ...BASE })
  a.team.propose('Bob', { plan: 'build_together', project: 'base' })
  b.team.accept(b.team.offers()[0].id)
  const f = a.social.feeling('Bob')
  b.team.leave(b.team.activePacts()[0].id, 'got bored')
  assert.ok(a.social.feeling('Bob') < f)
  assert.deepStrictEqual(a.memory.getProject('base').helpers, [])
  assert.match(a.team.notes.at(-1).text, /Bob left your plan .*got bored/)
})

test('whispers: one line when it fits, numbered parts otherwise, all under the chat limit', () => {
  const small = { to: 'Bob', kind: 'coming', id: 'pip-1', data: {}, say: 'hang on, coming to help!' }
  const one = L.encodeWhisper(small)
  assert.strictEqual(one.length, 1)
  assert.match(one[0], /^\/msg Bob hang on, coming to help! #T\{/)
  const back = L.decodeWhisper('Pip', one[0].replace('/msg Bob ', ''))
  assert.deepStrictEqual([back.kind, back.id, back.from], ['coming', 'pip-1', 'Pip'])
  const big = { to: 'Bob', kind: 'propose', id: 'pip-2', say: 'want to team up?', data: { pact: { id: 'pip1', plan: 'build_together', goal: 'a very long goal about building a castle by the lake', members: ['Pip', 'Bob'], roles: { pip: 'builder', bob: 'builder' } }, record: BASE } }
  const lines = L.encodeWhisper(big)
  assert.ok(lines.length >= 2)
  assert.ok(lines.every(l => l.length <= L.MAX_CHAT))
  assert.ok(lines.every(l => L.isTeamWhisper(l)))
  const r = new L.Reassembler()
  let env = null
  for (const l of [...lines].reverse()) env = r.feed('Pip', l.replace('/msg Bob ', '')) || env
  assert.deepStrictEqual(env.data, big.data)
  assert.ok(!L.isTeamWhisper('hey, want to go mining?'))
})

test('the link: setup-page route for bots on its roster, whispers for the rest', () => {
  const chat = []; const ipc = []
  const bot = { username: 'Pip', players: { Bob: {}, Cat: {} }, chat: (l) => chat.push(l), entity: { position: new Vec3(0, 64, 0) } }
  const team = new Team({ config: { bot: { otherBots: ['Bob', 'Cat', 'Dee'] } }, botName: 'Pip' })
  const link = L.createLink({ bot, team, config: { bot: { otherBots: ['Bob', 'Cat', 'Dee'] } }, send: (m) => ipc.push(m) })
  link.onIpc({ type: 'team-roster', names: ['Pip', 'Bob'] })
  assert.deepStrictEqual(team.online().sort(), ['Bob', 'Cat'], 'Dee is not online')
  team._out('*', 'coming', {}, 'hi')
  assert.strictEqual(ipc.length, 1); assert.strictEqual(ipc[0].msg.to, 'Bob')
  assert.strictEqual(chat.length, 1); assert.match(chat[0], /^\/msg Cat hi #T/)
  // Receiving: a team whisper is handled (not chat); ordinary whispers aren't.
  const got = []
  team.receive = (env) => got.push(env)
  assert.ok(link.onWhisper('Cat', 'hi #T{"k":"coming","i":"c-1","d":{}}'))
  assert.ok(!link.onWhisper('Cat', 'just saying hi'))
  link.onIpc({ type: 'team', msg: { id: 'b-1', from: 'Bob', kind: 'goals', data: { goals: [] } } })
  assert.deepStrictEqual(got.map(e => [e.from, e.via]), [['Cat', 'whisper'], ['Bob', 'ipc']])
})

test('the setup page passes team messages to the right bot', () => {
  const { Processes } = require('../src/manager/processes')
  const pr = new Processes({ roster: {} })
  const mk = (id, name, gameName) => { const sent = []; const e = pr.entry(id); Object.assign(e, { running: true, name, gameName, child: { send: (m) => sent.push(m) } }); return sent }
  const pip = mk('1', 'Pip', 'Pip'); const bob = mk('2', 'Bob', 'BobTheBuilder'); const cat = mk('3', 'Cat', 'Cat')
  pr._relay(pr.entry('1'), { from: 'Pip', to: 'BobTheBuilder', kind: 'help' })
  assert.strictEqual(bob.length, 1); assert.strictEqual(cat.length, 0); assert.strictEqual(pip.length, 0)
  pr._relay(pr.entry('1'), { from: 'Pip', to: '*', kind: 'goals' })
  assert.strictEqual(bob.length, 2); assert.strictEqual(cat.length, 1); assert.strictEqual(pip.length, 0)
  pr._roster()
  assert.deepStrictEqual(cat.at(-1), { type: 'team-roster', names: ['Pip', 'BobTheBuilder', 'Cat'] })
})
