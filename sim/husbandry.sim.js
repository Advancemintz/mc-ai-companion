'use strict'
// Simulated-world tests for looking after animals: ranch rounds (breeding, culling, shearing,
// milking, eggs, mending the fence, chasing escapees), leaving your own livestock alone when
// hunting, and taming and caring for pets.
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
const { SkillBook } = require(P + 'src/skills/skillbook')
const Z = require(P + 'src/body/zones')
const R = require(P + 'src/body/ranch')
const HB = require(P + 'src/body/husbandry')

const CORNER = new Vec3(2, 63, 2) // ring x/z 2..8 at y 64; inside 3..7; gate at 5 64 8
const M = HB.META

function setup (startTiers = {}) {
  const bot = worldBot()
  bot.entities = {}
  bot.inventory.slots = []
  bot.player = { uuid: 'me-uuid' }
  bot.nearestEntity = (fn = () => true) => Object.values(bot.entities).filter(e => e !== bot.entity && fn(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.setControlState = () => {}
  bot.equip = async (item) => { bot.heldItem = item }
  bot.unequip = async () => { bot.heldItem = null; for (const e of Object.values(bot.entities)) e._following = false }
  let nextId = 500
  const spawn = (name, pos, meta = {}, extra = {}) => {
    const metadata = []
    for (const [k, v] of Object.entries(meta)) metadata[M[k]] = v
    const e = { id: nextId++, name, type: name === 'item' ? 'object' : 'animal', position: pos.clone(), metadata, isValid: true, health: 10, height: 1, ...extra }
    bot.entities[e.id] = e
    return e
  }
  const give = (name, n = 1) => bot.give(name, n)
  // Moving: animals follow food (or a lead), and walking over drops picks them up.
  bot.pathfinder.goto = async (goal) => {
    const a = goal.args
    if (goal.kind === 'GoalNear') bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5)
    else if (goal.kind === 'GoalFollow') bot.entity.position = a[0].position.offset(1.5, 0, 0)
    else if (goal.kind === 'GoalLookAtBlock') bot.entity.position = a[0].offset(0.5, 1, 1.5)
    else if (goal.kind === 'GoalBlock') bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5)
    const food = bot.heldItem?.name
    for (const e of Object.values(bot.entities)) {
      if (e.type !== 'animal') continue
      const tempted = { wheat: ['cow', 'sheep'], carrot: ['pig'], wheat_seeds: ['chicken'] }[food] || []
      if (e._leashed || ((e._following || e.position.distanceTo(bot.entity.position) < 10) && tempted.includes(e.name))) {
        e._following = true
        e.position = bot.entity.position.offset(0.3, 0, 0.3)
      }
    }
    for (const e of Object.values(bot.entities)) {
      if (e.name === 'item' && e.position.distanceTo(bot.entity.position) < 2.5) { give(e._item, e._count || 1); delete bot.entities[e.id] }
    }
    if (env.onMove) await env.onMove(goal)
  }
  // Right-clicking animals.
  const love = new Map()
  bot.activateEntity = async (e) => {
    const held = bot.heldItem?.name
    const use = () => bot._use(held)
    if (held === 'lead') { e._leashed = !e._leashed; if (e._leashed) use(); else give('lead', 1); return }
    if (e._leashed) { e._leashed = false; give('lead', 1); return }
    if (held === 'shears' && e.name === 'sheep' && !(e.metadata[M.sheep] & 0x10)) {
      e.metadata[M.sheep] = (e.metadata[M.sheep] || 0) | 0x10
      spawn('item', e.position, {}, { _item: 'white_wool', _count: 2 })
      return
    }
    if (held === 'bucket' && e.name === 'cow') { use(); give('milk_bucket', 1); return }
    if (held === 'bone' && e.name === 'wolf') {
      use()
      e._bones = (e._bones || 0) + 1
      if (e._bones >= 3) { e.metadata[M.tameFlags] = 0x04; e.metadata[M.owner] = 'me-uuid' }
      return
    }
    if (!held && (e.metadata[M.tameFlags] & 0x04)) { e.metadata[M.tameFlags] ^= 0x01; return } // sit / stand
    if (e.name === 'wolf' && /beef|porkchop|rotten_flesh/.test(held || '')) { use(); e.metadata[M.health] = Math.min(40, (e.metadata[M.health] || 40) + 8); return }
    const foods = { cow: 'wheat', sheep: 'wheat', pig: 'carrot', chicken: 'wheat_seeds' }
    if (held && foods[e.name] === held && !e.metadata[M.baby]) {
      use()
      love.set(e.id, e)
      const mates = [...love.values()].filter(x => x.name === e.name)
      if (mates.length >= 2) {
        for (const m of mates.slice(0, 2)) love.delete(m.id)
        env.born++
        spawn(e.name, e.position.offset(0.2, 0, 0), { baby: true })
      }
    }
  }
  bot.attack = (e) => {
    e.health -= 6
    if (e.health <= 0) { e.isValid = false; delete bot.entities[e.id]; spawn('item', e.position, {}, { _item: e.name === 'pig' ? 'porkchop' : 'beef' }) }
  }
  bot.activateItem = () => { if (bot.heldItem?.name === 'egg') { bot._use('egg'); env.thrown++ } }
  const memory = new Memory(null)
  const config = { bot: { skills: { startTiers } }, reflexes: { fleeHealth: 6 } }
  const skills = new SkillBook(memory, config)
  Z.invalidate()
  const env = { bot, memory, skills, config, spawn, born: 0, thrown: 0 }
  return env
}

function penFor (env, kind, n, meta = {}) {
  const { bot, memory } = env
  for (const p of R.penRing(CORNER)) bot.setBlock(p, 'oak_fence')
  memory.saveProject(`pen_${kind}`, { style: 'pen', kind, corner: { x: CORNER.x, y: CORNER.y, z: CORNER.z } })
  const spots = []
  for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) spots.push(new Vec3(x + 0.5, 64, z + 0.5))
  return Array.from({ length: n }, (_, i) => env.spawn(kind, spots[(i * 3) % spots.length], meta))
}

async function act (env, name, args = {}, timeout = 60000) {
  const ex = new Executor(env.bot, actions, { memory: env.memory, config: env.config })
  env.skills.attach(ex)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

const inPen = (env, kind) => R.animalsInPen(env.bot, kind, CORNER)

test('ranch round: breeds the cows, mends the fence, shuts the gate; then waits for the cooldown', async () => {
  const env = setup({ farming: 3 })
  const { bot, memory } = env
  penFor(env, 'cow', 4)
  bot.setBlock(new Vec3(2, 64, 5), 'air') // a creeper took out a post
  bot.give('wheat', 10); bot.give('oak_fence', 4)
  let r = await act(env, 'tend_animals')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /cow pen \(4 adults \+ 2 young\): bred 2 pairs, mended 1 fence post/)
  assert.strictEqual(env.born, 2)
  assert.ok(R.penRing(CORNER).every(p => /_fence/.test(bot.blockAt(p).name)), 'fence whole again, gate shut')
  assert.strictEqual(inPen(env, 'cow').length, 6, 'nobody got out')
  const proj = memory.getProject('pen_cow')
  assert.deepStrictEqual(proj.herd, { adults: 4, babies: 2 })
  assert.strictEqual(proj.totals.born, 2)
  assert.ok(proj.lastBred)
  assert.match(memory.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Your cow pen at 2 63 2: 4 adults \+ 2 young.*so far 2 born/)
  r = await act(env, 'tend_animals', { animal: 'cows' })
  assert.match(r.text, /nothing to do \[bred 0 min ago; they need about 5 minutes/)
  assert.strictEqual(env.born, 2)
})

test('ranch round: a skilled farmer culls the extra adults for meat, keeps the young', async () => {
  const env = setup({ farming: 4 })
  const { bot } = env
  penFor(env, 'pig', 9)
  penFor(env, 'pig', 0) // (same pen)
  env.spawn('pig', new Vec3(4.5, 64, 6.5), { baby: true })
  bot.give('iron_sword', 1); bot.give('oak_fence', 2)
  const r = await act(env, 'tend_animals', { herd_size: 8 })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /pig pen \(7 adults \+ 1 young\): culled 2 for meat/)
  assert.ok(inPen(env, 'pig').some(e => e.metadata[M.baby]), 'the piglet is spared')
  assert.ok(bot.inventory.items().some(i => i.name === 'porkchop'), 'picked up the meat')
  // A rancher (tier 3) only notices the crowding.
  const low = setup({ farming: 3 })
  penFor(low, 'pig', 10)
  low.bot.give('oak_fence', 2)
  const r2 = await act(low, 'tend_animals', { herd_size: 8 })
  assert.match(r2.text, /pen is crowded \(10\/8\)/)
  assert.strictEqual(inPen(low, 'pig').length, 10)
})

test('ranch round: shears the sheep, milks a cow, and brings back a sheep that slipped out', async () => {
  const env = setup({ farming: 3 })
  const { bot, memory } = env
  const sheep = penFor(env, 'sheep', 3, { sheep: 0 })
  memory.getProject('pen_sheep').lastBred = new Date().toISOString() // not ready to breed again
  bot.give('shears', 1); bot.give('wheat', 4); bot.give('oak_fence', 3)
  // While the gate is open, one wanders out.
  let escaped = false
  env.onMove = async () => {
    const p = bot.entity.position.floored()
    if (!escaped && R.penInside(CORNER, p)) { escaped = true; sheep[2].position = new Vec3(5.5, 64, 13.5) }
  }
  const r = await act(env, 'tend_animals')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /sheared 3/)
  assert.match(r.text, /brought back 1 that got out/)
  assert.strictEqual(inPen(env, 'sheep').length, 3)
  assert.ok(sheep.every(s => HB.animalState(s).sheared))
  assert.ok(bot.inventory.items().find(i => i.name === 'white_wool')?.count >= 4, 'wool picked up')

  const cows = setup({ farming: 3 })
  penFor(cows, 'cow', 2)
  cows.memory.getProject('pen_cow').lastBred = new Date().toISOString()
  cows.bot.give('bucket', 1); cows.bot.give('oak_fence', 2)
  const r2 = await act(cows, 'tend_animals')
  assert.match(r2.text, /got a bucket of milk/)
  assert.ok(cows.bot.inventory.items().some(i => i.name === 'milk_bucket'))
})

test('ranch round: chickens: eggs collected, spare eggs thrown for chicks', async () => {
  const env = setup({ farming: 4 })
  const { bot } = env
  const hens = penFor(env, 'chicken', 3)
  env.spawn('item', hens[0].position, {}, { _item: 'egg', _count: 3 })
  bot.give('egg', 6); bot.give('oak_fence', 2)
  const r = await act(env, 'tend_animals')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /threw 6 eggs for chicks/)
  assert.match(r.text, /collected 3 eggs/)
  assert.strictEqual(env.thrown, 6)
})

test('build_pen with a lead: an agronomist leads a far-off cow in', async () => {
  const env = setup({ farming: 4 })
  const { bot, memory } = env
  memory.setPlace('home', new Vec3(0, 64, 0))
  bot.give('oak_fence', 30); bot.give('lead', 1)
  const cow = env.spawn('cow', new Vec3(-30.5, 64, 18.5))
  const r = await act(env, 'build_pen', { animal: 'cow', count: 1 })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /has 1 cow \(lured 1 in\)/)
  const p = memory.getProject('pen_cow')
  assert.ok(R.penInside(new Vec3(p.corner.x, p.corner.y, p.corner.z), cow.position.floored()))
  assert.ok(!cow._leashed, 'lead taken off')
  assert.ok(bot.inventory.items().some(i => i.name === 'lead'), 'and back in the pocket')
})

test('hunting leaves your penned cows, pets and named animals alone', async () => {
  const env = setup({ farming: 3, combat: 2 })
  penFor(env, 'cow', 1)
  let r = await act(env, 'attack', { target: 'cow' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /the only cow near here is in your pen/)
  env.spawn('pig', new Vec3(12.5, 64, -6.5), { name: '{"text":"Wilbur"}' })
  r = await act(env, 'attack', { target: 'pig' })
  assert.match(r.text, /named "Wilbur"/)
})

test('pets: tame a wolf with bones, name it, sit and follow, heal it', async () => {
  const env = setup()
  const { bot, memory } = env
  const wolf = env.spawn('wolf', new Vec3(10.5, 64, -8.5), { health: 40 })
  bot.give('bone', 6)
  let r = await act(env, 'tame', { animal: 'dog', name: 'Rex' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /tamed a wolf after 3 bones and named it Rex/)
  assert.ok(HB.isMyPet(bot, wolf))
  assert.strictEqual(memory.data.pets[0].name, 'Rex')
  r = await act(env, 'pet', { mode: 'sit', name: 'rex' })
  assert.match(r.text, /Rex the dog sat down/)
  assert.ok(HB.animalState(wolf).sitting)
  r = await act(env, 'pet', { mode: 'list' })
  assert.match(r.text, /With you: Rex the dog \(sitting, health 40\/40\)/)
  r = await act(env, 'pet', { mode: 'follow' })
  assert.match(r.text, /Rex the dog got up to follow you/)
  wolf.metadata[M.health] = 12
  bot.give('rotten_flesh', 5)
  r = await act(env, 'pet', { mode: 'feed' })
  assert.match(r.text, /fed Rex the dog \(4\)/)
  assert.ok(HB.animalState(wolf).health >= 38)
  r = await act(env, 'attack', { target: 'wolf' })
  assert.match(r.text, /your pet; I won't kill it/)
  assert.match(memory.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Your pets: Rex the dog/)
})
