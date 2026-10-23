'use strict'
// Simulated-world tests for teamwork: a gatherer bringing materials to a teammate's depot chest,
// a builder picking them up and finishing the base, running to help a friend in a fight, and
// shared chests that aren't theft.
// Run with: npm run test:sim
const { worldBot } = require('./harness')
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const P = path.join(__dirname, '..') + '/'
const { Vec3 } = require('vec3')
const { until } = require(P + 'test/helpers')
const { actions } = require(P + 'src/body/actions')
const { Executor } = require(P + 'src/body/executor')
const { Memory } = require(P + 'src/brain/memory')
const { Social } = require(P + 'src/brain/social')
const { Team } = require(P + 'src/brain/team')
const TW = require(P + 'src/body/teamwork')
const C = require(P + 'src/body/combat')
const Z = require(P + 'src/body/zones')

function teamFor (name, memory, social = null) {
  const team = new Team({ memory, social, config: { team: {} }, botName: name })
  team.sent = []
  team.notes = []
  team.send = (env) => team.sent.push(env)
  team.notify = (t) => team.notes.push(t)
  team.online = () => ['Pip', 'Bob'].filter(n => n !== name)
  return team
}

async function act (bot, { memory, team, social = null }, name, args = {}, timeout = 60000) {
  const ex = new Executor(bot, actions, { memory, team, social, config: { team: {} } })
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

function walking (bot) {
  const orig = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal) => {
    const a = goal.args
    if (goal.kind === 'GoalNear') { bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5); return }
    if (goal.kind === 'GoalFollow') { bot.entity.position = a[0].position.offset(1.5, 0, 0); return }
    return orig(goal)
  }
}

const BASE = { style: 'surface', size: 'small', variant: 'cottage', upgrades: [], origin: { x: 0, y: 63, z: -4 }, f: { x: 0, z: -1 }, status: 'in progress' }

test('gatherer: brings what the build needs to the depot (putting a chest down), and says so', async () => {
  const bot = worldBot(); walking(bot)
  const memory = new Memory(null)
  const team = teamFor('Bob', memory)
  team.receive({ id: 'p1', from: 'Pip', kind: 'propose', data: { pact: { id: 'pip1', plan: 'you_gather', goal: 'Pip\'s cottage', leader: 'Pip', members: ['Pip', 'Bob'], roles: { pip: 'builder', bob: 'gatherer' }, project: { owner: 'Pip', name: 'base' } }, record: BASE } })
  team.accept('pip1')
  team.receive({ id: 'p2', from: 'Pip', kind: 'need', data: { id: 'pip1', needs: { blocks: 40, glass: 4 }, depot: [6, 64, 6] } })
  assert.match(team.notes.at(-1), /Pip needs 40 cobblestone or planks, 4 glass/)
  bot.give('cobblestone', 64); bot.give('glass', 2); bot.give('chest', 1); bot.give('iron_pickaxe', 1)
  const r = await act(bot, { memory, team }, 'team', { mode: 'deliver' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /dropped off 40 cobblestone, 2 glass in the depot .* Still needed: 2 glass/)
  const chest = TW.nearestChest(bot, new Vec3(6, 64, 6), 6)
  assert.ok(chest, 'a depot chest was put down')
  assert.deepStrictEqual(bot.chestContents(chest.position), { cobblestone: 40, glass: 2 })
  assert.strictEqual(bot.inventory.items().find(i => i.name === 'cobblestone').count, 24, 'kept the rest')
  const msg = team.sent.find(e => e.kind === 'delivered')
  assert.deepStrictEqual(msg.data.items, { cobblestone: 40, glass: 2 })
  assert.strictEqual(msg.to, 'Pip')
})

test('builder: picks up deliveries from the depot, finishes the base, tells the team', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  const memory = new Memory(null)
  const team = teamFor('Pip', memory)
  let r = await act(bot, { memory, team }, 'build_base', { style: 'surface', size: 'small', plan_only: true })
  assert.match(r.text, /Still needs about/)
  team.propose('Bob', { plan: 'you_gather', goal: 'my cottage', project: 'base' })
  team.receive({ id: 'b1', from: 'Bob', kind: 'accept', data: { id: 'pip1' } })
  const depot = TW.depotFor(memory.getProject('base'))
  const dp = new Vec3(depot[0], depot[1], depot[2])
  bot.setBlock(dp, 'chest')
  bot.setChest(dp, { oak_planks: 300, oak_log: 40, cobblestone: 120, glass: 12, oak_door: 2, torch: 16 })
  team.receive({ id: 'b2', from: 'Bob', kind: 'delivered', data: { id: 'pip1', items: { oak_planks: 300 }, depot } })
  r = await act(bot, { memory, team }, 'build_base', {}, 120000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /finished the small surface base/)
  assert.match(r.text, /Picked up .*300 oak_planks.* from the depot/)
  assert.ok(team.sent.some(e => e.kind === 'done' && e.to === 'Bob'))
  assert.strictEqual(team.pact('pip1').status, 'done')
  assert.ok(memory.getPlace('home'))
})

test('builder: when the build pauses, the gatherer is told exactly what to bring', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  const memory = new Memory(null)
  const team = teamFor('Pip', memory)
  await act(bot, { memory, team }, 'build_base', { style: 'surface', size: 'small', plan_only: true })
  team.propose('Bob', { plan: 'you_gather', project: 'base' })
  team.receive({ id: 'b1', from: 'Bob', kind: 'accept', data: { id: 'pip1' } })
  bot.give('oak_planks', 40)
  const r = await act(bot, { memory, team }, 'build_base', {}, 120000)
  assert.match(r.text, /Your teammate has been told what to bring/)
  const need = team.sent.find(e => e.kind === 'need')
  assert.ok(need.data.needs.blocks > 10, JSON.stringify(need.data))
  assert.ok(Array.isArray(need.data.depot))
})

test('help_fight: runs to a friend and clears the monsters around them', async () => {
  const bot = worldBot(); walking(bot)
  bot.entities = {}
  const memory = new Memory(null)
  const team = teamFor('Bob', memory)
  const pip = { id: 90, type: 'player', username: 'Pip', name: 'player', position: new Vec3(15.5, 64, 12.5) }
  bot.players = { Pip: { username: 'Pip', entity: pip } }
  bot.entities[90] = pip
  bot.entities[91] = { id: 91, name: 'zombie', type: 'hostile', position: new Vec3(17.5, 64, 12.5), isValid: true }
  bot.entities[92] = { id: 92, name: 'skeleton', type: 'hostile', position: new Vec3(13.5, 64, 14.5), isValid: true }
  bot.entities[93] = { id: 93, name: 'zombie', type: 'hostile', position: new Vec3(-15.5, 64, -15.5), isValid: true } // far from Pip: not our business
  team.receive({ id: 'h1', from: 'Pip', kind: 'help', data: { pos: [15, 64, 12], threats: ['zombie', 'skeleton'] } }, { distanceTo: () => 20 })
  const engage = C.engage
  const fought = []
  C.engage = async (b, target) => { fought.push(target.name); delete b.entities[target.id]; return { killed: true, kills: 1, crits: 0, arrows: 0, ate: 0 } }
  try {
    const r = await act(bot, { memory, team }, 'help_fight', {})
    assert.ok(r.ok, r.text)
    assert.match(r.text, /helped Pip: killed 2 monsters/)
  } finally { C.engage = engage }
  assert.deepStrictEqual(fought.sort(), ['skeleton', 'zombie'])
  assert.ok(bot.entities[93], 'left the far zombie alone')
  assert.deepStrictEqual(team.sent.map(e => e.kind), ['coming', 'helped'])
})

test('shared base: taking from our chest is announced and never counted as theft', async () => {
  const bot = worldBot()
  const memory = new Memory(null)
  const social = new Social(memory, { social: {} }, { botName: 'Pip' })
  const team = teamFor('Pip', memory, social)
  memory.saveProject('base', { ...BASE, status: 'done', sharedWith: ['Bob'] })
  Z.invalidate()
  const chestPos = new Vec3(1, 64, -7)
  bot.setBlock(chestPos, 'chest')
  bot.setChest(chestPos, { iron_ingot: 10, bread: 5 })
  let r = await act(bot, { memory, team, social }, 'withdraw', { item: 'bread', count: 2 })
  assert.ok(r.ok, r.text)
  // Bob takes some iron while we're away.
  bot._chests.get('1,64,-7').find(i => i.name === 'iron_ingot').count = 4
  r = await act(bot, { memory, team, social }, 'withdraw', { item: 'bread', count: 1 })
  assert.ok(r.ok, r.text)
  assert.doesNotMatch(r.text, /missing/)
  assert.strictEqual(social.thefts().length, 0)
  const took = team.sent.filter(e => e.kind === 'took')
  assert.strictEqual(took.length, 2)
  assert.deepStrictEqual(took[0].data.items, { bread: 2 })
  assert.strictEqual(took[0].to, 'Bob')
})
