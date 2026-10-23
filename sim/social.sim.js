'use strict'
// Simulated-world tests for the social system and exploration: real actions against the fake
// world (chests with contents, other bots as player entities, a sun that moves).
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
const { SkillBook } = require(P + 'src/skills/skillbook')
const { startSocialSenses } = require(P + 'src/brain/socialSenses')
const Z = require(P + 'src/body/zones')

function setup ({ social = {}, startTiers = {} } = {}) {
  const bot = worldBot()
  bot.entities = {}
  bot.nearestEntity = (fn = () => true) => Object.values(bot.entities).filter(e => e !== bot.entity && fn(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.setControlState = (k, v) => { bot._controls = { ...(bot._controls || {}), [k]: v } }
  // Walking: the stub pathfinder teleports to whatever the goal is near.
  bot.pathfinder.goto = async (goal) => {
    const a = goal.args
    if (goal.kind === 'GoalNear') bot.entity.position = new Vec3(a[0] + 1.5, 64, a[2] + 0.5)
    else if (goal.kind === 'GoalNearXZ') bot.entity.position = new Vec3(a[0] + 0.5, 64, a[1] + 0.5)
    else if (goal.kind === 'GoalLookAtBlock') bot.entity.position = new Vec3(a[0].x + 1.5, 64, a[0].z + 0.5)
    else if (goal.kind === 'GoalBlock') bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5)
    if (bot._onMove) await bot._onMove()
  }
  const memory = new Memory(null)
  const config = { social, bot: { autonomous: true, skills: { startTiers } }, reflexes: { fleeHealth: 6 } }
  const s = new Social(memory, config, { botName: bot.username })
  const skills = new SkillBook(memory, config)
  Z.invalidate()
  return { bot, memory, social: s, skills, config }
}

async function act (env, name, args, timeout = 30000) {
  const ex = new Executor(env.bot, actions, { memory: env.memory, social: env.social, config: env.config })
  env.skills.attach(ex)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

function player (bot, name, pos) {
  const e = { id: 100 + Object.keys(bot.entities).length, type: 'player', username: name, name: 'player', position: pos, height: 1.8 }
  bot.entities[e.id] = e
  bot.players[name] = { username: name, entity: e }
  return e
}

function slipsBase (env) {
  env.memory.setPlace('slip_base', new Vec3(30, 64, 0), 'overworld', '', 'slip')
  env.bot.setBlock(new Vec3(32, 64, 0), 'chest')
  env.bot.setChest(new Vec3(32, 64, 0), { diamond: 8, iron_ingot: 20, bread: 12, cobblestone: 64 })
  return new Vec3(32, 64, 0)
}

test('steal: takes a modest share of the best stuff from a disliked bot, unseen', async () => {
  const env = setup()
  const chest = slipsBase(env)
  env.social.adjust('slip', -30, 'test')
  const r = await act(env, 'steal', { from: 'slip' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /quietly took 2 diamond, 5 iron_ingot, 3 bread from slip's chest at 32 64 0\. Nobody saw/)
  assert.deepStrictEqual(env.bot.chestContents(chest), { diamond: 6, iron_ingot: 15, bread: 9, cobblestone: 64 })
  assert.strictEqual(env.social.myThefts().length, 1)
  assert.match(env.social.describe({}), /Your secret: you took 2 diamond/)
  // Lie low afterwards.
  const again = await act(env, 'steal', { from: 'slip' })
  assert.match(again.text, /lie low/)
})

test('steal: refuses neutral and protected players, and when the operators switch it off', async () => {
  const env = setup({ social: { protected: ['boot'] } })
  slipsBase(env)
  let r = await act(env, 'steal', { from: 'slip' })
  assert.match(r.text, /don't dislike slip enough/)
  env.social.adjust('boot', -100)
  r = await act(env, 'steal', { from: 'boot' })
  assert.match(r.text, /protected/)
  env.social.adjust('slip', -40)
  env.social.setFeature('stealing', false)
  r = await act(env, 'steal', { from: 'slip' })
  assert.match(r.text, /switched off/)
})

test('steal: backs out when someone can see, but a wall hides you', async () => {
  const env = setup({ social: { stealing: { patienceSeconds: 1 } } })
  const chest = slipsBase(env)
  env.social.adjust('slip', -30)
  const em = player(env.bot, 'em', new Vec3(40, 64, 6))
  let r = await act(env, 'steal', { from: 'slip' })
  assert.match(r.text, /too risky: em could see you/)
  assert.strictEqual(env.bot.chestContents(chest).diamond, 8)
  // A stone wall between em and the chest (and the bot, who ends up next to it).
  for (let x = 26; x <= 42; x++) for (let y = 64; y <= 67; y++) env.bot.setBlock(new Vec3(x, y, 4), 'stone')
  em.position = new Vec3(36, 64, 9)
  r = await act(env, 'steal', { from: 'slip' })
  assert.ok(r.ok, r.text)
})

test('ownership: deposit and withdraw never use somebody else\'s chest', async () => {
  const env = setup()
  env.bot.entity.position = new Vec3(30.5, 64, 2.5)
  slipsBase(env)
  env.bot.give('cobblestone', 10)
  let r = await act(env, 'deposit', {})
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /belong to slip, not you; I won't put my things in their chests/)
  r = await act(env, 'withdraw', { item: 'diamond' })
  assert.match(r.text, /belong to slip.*Taking from them would be stealing/)
  r = await act(env, 'whose', {})
  assert.match(r.text, /where you stand is slip's; the nearest chest \(32 64 0\) is slip's/)
})

test('theft detection: your chest comes up short, check_chests names the suspect, feelings drop', async () => {
  const env = setup()
  const { bot, memory, social } = env
  memory.setPlace('home', new Vec3(0, 64, 0), 'overworld')
  const chest = new Vec3(2, 64, 2)
  bot.setBlock(chest, 'chest')
  bot.give('iron_ingot', 12); bot.give('cobblestone', 5); bot.give('bread', 3)
  let r = await act(env, 'deposit', {})
  assert.ok(r.ok, r.text)
  assert.deepStrictEqual(bot.chestContents(chest), { iron_ingot: 12, cobblestone: 5 }) // food stays in the pockets
  // While the bot is away, slip opens it and takes some iron; boot just walks past.
  await new Promise(resolve => setTimeout(resolve, 5))
  social.recordSighting('boot', new Vec3(6, 64, 0))
  social.recordChestOpen('2,64,2', chest, 'slip')
  bot._chests.get('2,64,2').find(i => i.name === 'iron_ingot').count = 7
  r = await act(env, 'check_chests', {})
  assert.ok(r.ok, r.text)
  assert.match(r.text, /THEFT! your chest at 2 64 2 is missing 5 iron_ingot .*Suspects: slip \(seen opening it/)
  assert.strictEqual(social.feeling('slip'), -30)
  // Using the chest again doesn't raise a new alarm.
  r = await act(env, 'withdraw', { item: 'cobblestone', count: 1 })
  assert.strictEqual(r.text, 'withdraw: took 1 cobblestone')
  r = await act(env, 'check_chests', {})
  assert.match(r.text, /nothing missing/)
})

test('sabotage: only at deep hatred, unseen, small: takes their torches', async () => {
  const env = setup()
  slipsBase(env)
  const torches = [new Vec3(28, 64, 2), new Vec3(31, 64, -3), new Vec3(26, 64, 0)]
  for (const t of torches) env.bot.setBlock(t, 'torch')
  env.social.adjust('slip', -60)
  let r = await act(env, 'sabotage', { target: 'slip', kind: 'torches' })
  assert.match(r.text, /only for deep hatred/)
  env.social.adjust('slip', -30)
  r = await act(env, 'sabotage', { target: 'slip', kind: 'torches' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /took 3 of slip's lights/)
  assert.ok(torches.every(t => env.bot.blockAt(t).name === 'air'))
  r = await act(env, 'sabotage', { target: 'slip' })
  assert.match(r.text, /wait a while/)
})

test('sabotage: blocks a doorway with one block, from the outside', async () => {
  const env = setup()
  slipsBase(env)
  env.social.setFeeling('slip', -90)
  const door = new Vec3(30, 64, 3)
  env.bot.setBlock(door, 'oak_door'); env.bot._props.set('30,64,3', { facing: 'south', half: 'lower' })
  // A roof on the north (inside) side.
  for (let x = 28; x <= 32; x++) for (let z = -2; z <= 2; z++) env.bot.setBlock(new Vec3(x, 67, z), 'oak_planks')
  env.bot.give('cobblestone', 3)
  const r = await act(env, 'sabotage', { target: 'slip', kind: 'doorway' })
  assert.ok(r.ok, r.text)
  assert.strictEqual(env.bot.blockAt(new Vec3(30, 64, 4)).name, 'cobblestone') // outside
  assert.strictEqual(env.bot.blockAt(new Vec3(30, 64, 2)).name, 'air') // inside untouched
})

test('feelings: adjust_feelings is capped; the model sees feelings and rules in STATE', async () => {
  const env = setup()
  let r = await act(env, 'adjust_feelings', { player: 'mike', change: 40, why: 'shared his bread' })
  assert.match(r.text, /you now feel 15 \(neutral\) about mike/)
  r = await act(env, 'adjust_feelings', { player: 'mike', change: 15, why: 'helped me build' })
  r = await act(env, 'adjust_feelings', { player: 'mike', change: 15, why: 'saved me' })
  assert.match(r.text, /already moved a lot this hour/)
  const text = env.social.describe({ nearby: ['mike', 'slip'] })
  assert.match(text, /mike \+30 \(like\) \[helped me build; shared his bread\]|mike \+30 \(like\) \[shared his bread; helped me build\]/)
  assert.match(text, /No strong feelings yet about: slip/)
  assert.match(text, /Social rules: stealing allowed from people at -20 or worse; sabotage only at deep hatred \(-80 or worse\)/)
})

test('social senses: who opens which chest, whose base it is, and griefing', async () => {
  const env = setup()
  const { bot, social, memory } = env
  const notes = []
  const brain = { notify: (t) => notes.push(t), paused: false }
  const senses = startSocialSenses(bot, brain, social, env.config)
  try {
    // Boot keeps opening a chest out in the wild: that's boot's base now.
    const c = new Vec3(-40, 64, 10)
    bot.setBlock(c, 'chest')
    const boot = player(bot, 'boot', new Vec3(-41, 64, 11))
    bot.emit('chestLidMove', bot.blockAt(c), 1)
    bot.emit('chestLidMove', bot.blockAt(c), 1)
    assert.strictEqual(social.ownerAt(c).owner, 'boot')
    assert.ok(notes.some(n => /looks like boot lives around -40 64 10/.test(n)))
    // Opening YOUR chest is noticed (and a little rude).
    memory.setPlace('home', new Vec3(0, 64, 0), 'overworld')
    Z.invalidate()
    const mine = new Vec3(1, 64, 1)
    bot.setBlock(mine, 'chest')
    boot.position = new Vec3(2, 64, 2)
    bot.emit('chestLidMove', bot.blockAt(mine), 1)
    assert.ok(notes.some(n => /boot just opened YOUR chest at 1 64 1/.test(n)))
    assert.strictEqual(social.feeling('boot'), -2)
    // Breaking a block in your base.
    bot.emit('blockUpdate', { name: 'oak_planks', position: new Vec3(3, 65, 0) }, { name: 'air', position: new Vec3(3, 65, 0) })
    assert.ok(notes.some(n => /boot broke a oak_planks in your base/.test(n)))
    assert.strictEqual(social.feeling('boot'), -12)
    // Our own digging is never blamed on anyone.
    bot.emit('diggingCompleted', { position: new Vec3(4, 65, 0) })
    bot.emit('blockUpdate', { name: 'oak_planks', position: new Vec3(4, 65, 0) }, { name: 'air', position: new Vec3(4, 65, 0) })
    assert.strictEqual(social.feeling('boot'), -12)
    // The sightings log feeds theft suspects.
    senses.watch()
    assert.ok(social._store().sightings.some(s => s.p === 'boot'))
  } finally {
    senses.stop()
  }
})

test('social senses: a disliked bot away from home gives the bot a sneaky idea', async () => {
  const env = setup()
  const notes = []
  const brain = { notify: (t, wake) => notes.push({ t, wake }), paused: false }
  slipsBase(env)
  env.social.adjust('slip', -30)
  const senses = startSocialSenses(env.bot, brain, env.social, env.config)
  try {
    senses.ideas()
    assert.ok(notes.some(n => /\[sneaky idea\] You dislike slip/.test(n.t) && n.wake))
    notes.length = 0
    senses.ideas()
    assert.strictEqual(notes.length, 0) // not again for a while
  } finally { senses.stop() }
})

// ---------------------------------------------------------------- exploration

function exploreWorld (env) {
  const { bot, memory } = env
  memory.setPlace('home', new Vec3(0, 64, 0), 'overworld')
  bot.time.timeOfDay = 1000
  let biome = 'plains'
  const orig = bot.blockAt
  bot.blockAt = (p) => { const b = orig(p); b.biome = { name: p.x > 100 ? 'desert' : biome }; return b }
  return { setBiome: (b) => { biome = b } }
}

test('explore: heads into new land, finds a village, saves it, maps the area and comes home', async () => {
  const env = setup({ startTiers: { exploration: 2 } })
  exploreWorld(env)
  const { bot, memory } = env
  bot.setBlock(new Vec3(60, 64, 2), 'bell')
  player(bot, 'v1', new Vec3(0, 0, 0)) // keep entities non-empty
  const r = await act(env, 'explore', { direction: 'east' }, 60000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /explored east \(\d+ blocks out, \d+ new areas mapped\)/)
  assert.match(r.text, /village at 60 64 2 \(saved as village\)/)
  assert.match(r.text, /new biomes: plains, desert/)
  assert.match(r.text, /came home because I reached the edge of how far I go \(192 blocks\)/)
  assert.ok(memory.getPlace('village'))
  assert.ok(bot.entity.position.distanceTo(new Vec3(0, 64, 0)) < 6)
  assert.ok(memory.exploredShare(new Vec3(0, 64, 0), 192, 'overworld') > 0.05)
  assert.ok(!memory.data.exploreTrip)
  assert.ok(env.skills.state('exploration').xp > 20)
  assert.match(memory.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Finds: village at 60 64 2/)
})

test('explore: the next trip picks a direction it hasn\'t been', async () => {
  const env = setup({ startTiers: { exploration: 3 } })
  exploreWorld(env)
  for (let x = 0; x <= 384; x += 16) for (let z = -40; z <= 40; z += 16) env.memory.markExplored(new Vec3(x, 64, z), 'overworld', 0)
  const { chooseDirection } = require(P + 'src/body/explore')
  for (let i = 0; i < 10; i++) assert.notStrictEqual(chooseDirection(env.memory, new Vec3(0, 64, 0), 384, 'overworld', { smart: true }), 'east')
})

test('explore: turns back when it gets late, and refuses to start at dusk', async () => {
  const env = setup({ startTiers: { exploration: 1 } })
  exploreWorld(env)
  env.bot.time.timeOfDay = 9000
  env.bot._onMove = async () => { env.bot.time.timeOfDay += 400 }
  let r = await act(env, 'explore', { direction: 'north' }, 30000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /came home because it was getting late/)
  env.bot._onMove = null
  env.bot.time.timeOfDay = 11600
  r = await act(env, 'explore', {})
  assert.match(r.text, /too close to night/)
})

test('explore: comes home when hurt, and spots lava and a cave on the way', async () => {
  const env = setup({ startTiers: { exploration: 2 } })
  exploreWorld(env)
  const { bot } = env
  bot.setBlock(new Vec3(-30, 63, 5), 'lava')
  for (let y = 54; y <= 63; y++) bot.setBlock(new Vec3(-34, y, -4), 'air') // a shaft into the dark
  let hops = 0
  bot._onMove = async () => { if (++hops === 3) bot.health = 9 }
  const r = await act(env, 'explore', { direction: 'west' }, 30000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /came home because I got hurt/)
  assert.match(r.text, /lava at -30 63 5/)
  assert.match(r.text, /cave at -34 63 -4 \(saved as cave\)/)
})

test('explore: a wanderer only notices biomes and villages', async () => {
  const env = setup({ startTiers: { exploration: 1 } })
  exploreWorld(env)
  env.bot.setBlock(new Vec3(-30, 63, 5), 'lava')
  const r = await act(env, 'explore', { direction: 'west' }, 30000)
  assert.ok(r.ok, r.text)
  assert.doesNotMatch(r.text, /lava/)
  assert.match(r.text, /reached the edge of how far I go \(96 blocks\)/)
})

