'use strict'
// Simulated-world tests: real actions, builder, mining, railways and skills running against a
// fake in-memory Minecraft world (no server needed). Run with: npm run test:sim
// The pathfinder is replaced by a tiny stub (sim/pathfinder-stub.js) that "teleports" the bot.
const { worldBot, registry, run, ctxFor } = require('./harness')
const path = require('path')
const test = require('node:test')
const assert = require('node:assert')
const P = path.join(__dirname, '..') + '/'
const { Vec3 } = require('vec3')
const { fakeBot, until } = require(P + 'test/helpers')
const W = require(P + 'src/body/world')
const { actions, helpers } = require(P + 'src/body/actions')
const { Executor } = require(P + 'src/body/executor')
const perception = require(P + 'src/body/perception')

test('name resolution', () => {
  const r = registry()
  assert.deepStrictEqual(W.resolveBlockNames(r, 'wood').sort(), ['birch_log', 'oak_log'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'iron').sort(), ['deepslate_iron_ore', 'iron_ore'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'iron_ore').sort(), ['deepslate_iron_ore', 'iron_ore'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'cobblestone').sort(), ['cobblestone', 'stone'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'Oak Logs'), ['oak_log'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'coal'), ['coal_ore'])
  assert.deepStrictEqual(W.resolveBlockNames(r, 'planks'), [])
  const bot = worldBot(); bot.give('birch_log', 2)
  assert.strictEqual(W.resolveCraftTarget(bot, 'planks'), 'birch_planks')
  assert.strictEqual(W.resolveCraftTarget(bot, 'sticks'), 'stick')
  assert.ok(W.resolveItemName(bot, 'pickaxe').endsWith('_pickaxe'))
  bot.give('rotten_flesh', 3); bot.give('bread', 1); bot.give('iron_sword', 1); bot.give('wooden_axe', 1)
  assert.strictEqual(W.bestFood(bot).name, 'bread')
  assert.strictEqual(W.bestWeapon(bot).name, 'iron_sword')
})

test('collect_block mines the right count and fails helpfully', async () => {
  const bot = worldBot()
  for (let i = 0; i < 5; i++) bot.setBlock(new Vec3(3 + i, 64, 3), 'oak_log')
  let r = await run(bot, 'collect_block', { block: 'logs', count: 3 })
  assert.deepStrictEqual(r, { ok: true, text: 'collect_block: collected 3 logs' })
  assert.strictEqual(W.countItem(bot, 'oak_log'), 3)
  r = await run(bot, 'collect_block', { block: 'oak_log', count: 10 })
  assert.match(r.text, /collected 2\/10 oak_log; no more/)
  r = await run(bot, 'collect_block', { block: 'diamond', count: 1 })
  assert.strictEqual(r.ok, false)
  bot.setBlock(new Vec3(1, 64, 1), 'iron_ore')
  const orig = bot.blockAt
  bot.blockAt = (p) => { const b = orig(p); if (b.name === 'iron_ore') b.harvestTools = { 1009: true }; return b }
  r = await run(bot, 'collect_block', { block: 'iron', count: 1 })
  assert.match(r.text, /need a tool to mine iron_ore: stone_pickaxe/)
})

test('build hut places walls, roof and leaves a doorway', async () => {
  const bot = worldBot()
  bot.give('cobblestone', 80)
  bot.entity.yaw = 0 // facing north (-z): f = (0,0,-1), r = (1,0,0)
  const r = await run(bot, 'build', { structure: 'hut' })
  assert.ok(r.ok, r.text)
  const expected = helpers.structureOffsets('hut', {}).length
  assert.match(r.text, new RegExp(`using ${expected} cobblestone`), r.text)
  const [x, y, z] = r.text.match(/built an? \w+ hut at (-?\d+), (-?\d+), (-?\d+)/).slice(1).map(Number)
  const o = new Vec3(x, y, z)
  assert.strictEqual(y, 64)
  assert.strictEqual(bot.blockAt(o).name, 'air') // doorway
  assert.strictEqual(bot.blockAt(o.offset(0, 1, 0)).name, 'air')
  assert.strictEqual(bot.blockAt(o.offset(0, 2, 0)).name, 'cobblestone')
  assert.strictEqual(bot.blockAt(o.offset(0, 3, -2)).name, 'cobblestone') // roof center
  assert.strictEqual(bot.blockAt(o.offset(0, 0, -2)).name, 'air') // interior
  assert.strictEqual(bot.blockAt(o.offset(2, 1, -2)).name, 'cobblestone') // side wall
  assert.strictEqual(W.countItem(bot, 'cobblestone'), 80 - expected)
})

test('build refuses when materials are short', async () => {
  const bot = worldBot()
  bot.give('dirt', 5)
  const r = await run(bot, 'build', { structure: 'wall', length: 5, height: 3 })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /need 15 building blocks .* only have 5/)
})

test('craft uses recipes and reports missing ingredients', async () => {
  const bot = worldBot()
  bot.give('oak_planks', 2)
  const stick = bot.registry.itemsByName.stick.id
  const planks = bot.registry.itemsByName.oak_planks.id
  const pick = bot.registry.itemsByName.wooden_pickaxe.id
  const recipes = {
    [stick]: [{ result: { count: 4 }, requiresTable: false, delta: [{ id: planks, count: -2 }, { id: stick, count: 4 }] }],
    [pick]: [{ result: { count: 1 }, requiresTable: true, delta: [{ id: planks, count: -3 }, { id: stick, count: -2 }, { id: pick, count: 1 }] }]
  }
  bot.recipesAll = (id, m, table) => (recipes[id] || []).filter(r => !r.requiresTable || table)
  bot.recipesFor = (id, m, n, table) => bot.recipesAll(id, m, table).filter(r =>
    r.delta.every(d => d.count >= 0 || bot.inventory.count(d.id) + d.count * Math.ceil(n / r.result.count) >= 0))
  bot.craft = async (r, times) => {
    for (const d of r.delta) {
      const name = bot.registry.items[d.id].name
      if (d.count > 0) bot.give(name, d.count * times)
      else { const it = bot._items.find(i => i.name === name); it.count += d.count * times }
    }
  }
  let res = await run(bot, 'craft', { item: 'sticks', count: 4 })
  assert.match(res.text, /crafted 4 stick/)
  res = await run(bot, 'craft', { item: 'wooden_pickaxe' })
  assert.strictEqual(res.ok, false)
  assert.match(res.text, /missing ingredients for 1 wooden_pickaxe: need 3 oak_planks/)
  res = await run(bot, 'craft', { item: 'diamond_hoe' })
  assert.strictEqual(res.ok, false)
})

test('perception summary', () => {
  const bot = worldBot()
  bot.give('oak_log', 4); bot.give('bread', 2)
  bot.setBlock(new Vec3(2, 64, 2), 'crafting_table')
  bot.setBlock(new Vec3(5, 64, 5), 'oak_log')
  bot.entities = { 1: { type: 'hostile', name: 'zombie', position: new Vec3(5, 64, 0) }, 2: { type: 'player', username: 'Steve', position: new Vec3(1, 64, 1) } }
  const text = perception.describe(bot, {})
  console.log(text)
  assert.match(text, /Inventory \(\d+ free slots\): oak_log x4, bread x2/)
  assert.match(text, /Players nearby: Steve 1m/)
  assert.match(text, /zombie \(hostile\) 5m/)
  assert.match(text, /crafting_table x1 at 2 64 2/)
})

test('planks request adapts to the logs we actually have', () => {
  const bot = worldBot(); bot.give('birch_log', 1)
  assert.strictEqual(W.resolveCraftTarget(bot, 'oak_planks'), 'birch_planks')
  bot.give('oak_log', 1)
  assert.strictEqual(W.resolveCraftTarget(bot, 'oak_planks'), 'oak_planks')
})

module.exports = { worldBot, registry, run }

// ---------------------------------------------------------------- v2: terrain, memory, motivation
const T = require(P + 'src/body/terrain')
const { Memory } = require(P + 'src/brain/memory')
const { assessNeeds, describeNeeds } = require(P + 'src/brain/drives')
const fs = require('fs')
const os = require('os')

test('cover: outdoors, under trees, underground', () => {
  const bot = worldBot()
  assert.strictEqual(T.cover(bot).kind, 'outdoors')
  bot.setBlock(new Vec3(0, 70, 0), 'oak_leaves')
  assert.strictEqual(T.cover(bot).kind, 'under trees')
  bot.entity.position = new Vec3(0.5, 40, 0.5)
  const c = T.cover(bot)
  assert.strictEqual(c.kind, 'underground')
  assert.match(T.describeCover(bot), /underground, about \d+ blocks of rock/)
})

test('underground build fails with a go_to_surface hint; go_to_surface finds the sky', async () => {
  const bot = worldBot()
  bot.give('dirt', 80)
  bot.entity.position = new Vec3(0.5, 40, 0.5)
  // carve a small cave so there is air around the bot
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 40; y <= 42; y++) bot.setBlock(new Vec3(x, y, z), 'air')
  let r = await run(bot, 'build', { structure: 'hut' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /go_to_surface/)
  let goal = null
  bot.pathfinder.goto = async (g) => { goal = g; bot.entity.position = new Vec3(g.args[0] + 0.5, g.args[1], g.args[2] + 0.5) }
  r = await run(bot, 'go_to_surface', {})
  assert.ok(r.ok, r.text)
  assert.strictEqual(goal.args[1], 64) // standing on top of the grass at y=63
})

test('site finder avoids water, trees and steep spots and the hut becomes home', async () => {
  const bot = worldBot()
  bot.entity.yaw = 0
  // Directly ahead: a pond and a tree; off to the east: clear flat land.
  for (let x = -4; x <= 4; x++) for (let z = -8; z <= -1; z++) bot.setBlock(new Vec3(x, 63, z), 'water')
  for (let y = 64; y <= 68; y++) bot.setBlock(new Vec3(-3, y, 3), 'oak_log')
  for (let x = -5; x <= -1; x++) for (let z = 1; z <= 5; z++) bot.setBlock(new Vec3(x, 68, z), 'oak_leaves')
  // a small bump that should be levelled if inside the footprint
  bot.setBlock(new Vec3(7, 64, -2), 'dirt')
  bot.give('dirt', 30); bot.give('oak_planks', 50)
  const mem = new Memory(null)
  const ex = new Executor(bot, actions, { memory: mem })
  let out = null
  ex.on('planFinished', e => { out = e.results[0] })
  ex.on('actionFailed', e => { out = 'FAILED ' + e.error })
  ex.setPlan([{ name: 'build', args: { structure: 'hut' } }])
  await until(() => out, 8000)
  assert.match(out, /built an? \w+ hut/, out)
  assert.match(out, /saved it as your home/)
  const [x, y, z] = out.match(/built an? \w+ hut at (-?\d+), (-?\d+), (-?\d+)/).slice(1).map(Number)
  // whole footprint must be on dry ground (not over the pond, not through the tree)
  for (let ri = -2; ri <= 2; ri++) {
    for (let fi = 0; fi <= 4; fi++) {
      const gx = x + ri; const gz = z - fi
      assert.notStrictEqual(bot.blockAt(new Vec3(gx, 63, gz)).name, 'water', `footprint over water at ${gx},${gz}`)
      assert.notStrictEqual(bot.blockAt(new Vec3(gx, 64, gz)).name, 'oak_log')
    }
  }
  const home = mem.getPlace('home')
  assert.ok(home)
  assert.strictEqual(home.y, 64)
  assert.match(out, /using .*(oak_planks|dirt)/)
})

test('mixed materials are combined when no single stack is enough', async () => {
  const bot = worldBot()
  bot.give('dirt', 40); bot.give('cobblestone', 40)
  const r = await run(bot, 'build', { structure: 'hut' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /cobblestone/)
  assert.match(r.text, /dirt/)
})

test('memory persists places, goals, journal and player notes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'bot.json')
  const m = new Memory(file)
  m.setPlace('Home', new Vec3(10.7, 64, -3.2), 'minecraft:overworld', 'my hut')
  const g = m.addGoal('get iron gear', 'creepers are scary')
  m.addGoal('find diamonds')
  m.notePlayer('Steve', 'likes cookies')
  m.finishGoal('diamonds', 'abandoned', 'too deep')
  m.saveNow()
  const m2 = new Memory(file)
  assert.deepStrictEqual([m2.getPlace('home').x, m2.getPlace('home').z], [10, -4])
  assert.deepStrictEqual(m2.activeGoals().map(x => x.text), ['get iron gear'])
  assert.strictEqual(m2.findGoal('#' + g.id).text, 'get iron gear')
  const text = m2.summary({ pos: new Vec3(0, 64, 0), dimension: 'overworld', playersNearby: ['steve'] })
  assert.match(text, /Home: 10 64 -4 \(\d+ blocks away\)/)
  assert.match(text, /Your goals: #1 get iron gear \(because creepers are scary\)/)
  assert.match(text, /About steve: likes cookies/)
  assert.match(text, /Gave up on goal #2: find diamonds \(too deep\)/)
  assert.throws(() => { for (let i = 0; i < 6; i++) m2.addGoal('goal ' + i) }, /already have 5 active goals/)
})

test('needs: evening with no home is urgent; tool progression is suggested', () => {
  const bot = worldBot()
  bot.time.timeOfDay = 11800
  bot.inventory.slots = []
  let needs = assessNeeds(bot, { memory: new Memory(null) })
  const text = describeNeeds(needs)
  assert.match(text, /\[urgent\] night falls in ~\d+ min and you have no shelter/)
  assert.match(text, /no pickaxe/)
  assert.match(text, /food supply is low/)
  bot.give('stone_pickaxe', 1); bot.give('bread', 10); bot.give('stone_sword', 1)
  bot.time.timeOfDay = 3000
  const m = new Memory(null); m.setPlace('home', new Vec3(0, 64, 0))
  needs = assessNeeds(bot, { memory: m })
  assert.match(describeNeeds(needs), /iron_pickaxe/)
  assert.doesNotMatch(describeNeeds(needs), /urgent/)
})

// ---------------------------------------------------------------- v4: base builder
const B = require(P + 'src/body/builder')

async function runWithMemory (bot, mem, name, args, timeout = 30000) {
  const ex = new Executor(bot, actions, { memory: mem })
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

function stockBase (bot, planks = 300) {
  bot.give('oak_planks', planks); bot.give('oak_log', 40); bot.give('cobblestone', 120)
  bot.give('glass', 12); bot.give('oak_door', 2); bot.give('torch', 16)
  bot.give('crafting_table', 1); bot.give('furnace', 1); bot.give('chest', 2)
}

test('surface base: medium house on flat land with all the details', async () => {
  const bot = worldBot(); bot.entity.yaw = 0 // facing north: f=(0,0,-1), r=(1,0,0)
  stockBase(bot)
  const mem = new Memory(null)
  const r = await runWithMemory(bot, mem, 'build_base', { style: 'surface', size: 'medium' })
  console.log(r.text)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /finished the medium surface base/)
  const p = mem.getProject('base')
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z)
  const at = (ri, up, fi) => bot.blockAt(o.offset(ri, up, -fi))
  assert.strictEqual(o.y, 63)
  assert.strictEqual(at(-4, 1, 0).name, 'oak_log') // corner frame
  assert.strictEqual(at(-1, 1, 0).name, 'oak_planks') // wall
  assert.strictEqual(at(0, 1, 0).name, 'oak_door') // door
  assert.strictEqual(at(0, 0, 4).name, 'cobblestone') // floor replaced the grass
  assert.strictEqual(at(0, 2, 8).name, 'glass') // back window
  assert.strictEqual(at(0, 5, 4).name, 'oak_planks') // roof
  assert.strictEqual(at(0, 1, 4).name, 'air') // inside
  assert.strictEqual(at(-3, 1, 7).name, 'crafting_table')
  assert.ok(['torch', 'wall_torch'].includes(at(-3, 2, 4).name))
  assert.ok(mem.getPlace('home'))
  assert.strictEqual(p.status, 'done')
})

test('surface base: levels a hill and clears a tree, floor ends up flat', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  // A hill in the middle of the area and a tree.
  for (let x = -6; x <= 6; x++) for (let z = -12; z <= 0; z++) {
    const hgt = Math.max(0, 3 - Math.floor(Math.hypot(x, z + 6) / 2))
    for (let y = 64; y < 64 + hgt; y++) bot.setBlock(new Vec3(x, y, z), 'dirt')
  }
  for (let y = 64; y <= 69; y++) bot.setBlock(new Vec3(8, y, -4), 'oak_log')
  stockBase(bot)
  const mem = new Memory(null)
  const r = await runWithMemory(bot, mem, 'build_base', { style: 'surface', size: 'small' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /finished/, r.text)
  const p = mem.getProject('base')
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z)
  const at = (ri, up, fi) => bot.blockAt(o.offset(ri, up, -fi))
  for (let fi = 1; fi <= 5; fi++) for (let ri = -2; ri <= 2; ri++) {
    assert.ok(T.isFirm(at(ri, 0, fi)), `floor at ${ri},${fi}`)
    assert.ok(['air', 'torch', 'wall_torch', 'crafting_table', 'furnace', 'chest'].includes(at(ri, 1, fi).name), `inside ${ri},${fi} is ${at(ri, 1, fi).name}`)
  }
})

test('surface base: pauses when out of materials, remembers the project, resumes', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('oak_planks', 60); bot.give('dirt', 10)
  const mem = new Memory(null)
  let r = await runWithMemory(bot, mem, 'build_base', { style: 'surface', size: 'small', plan_only: true })
  assert.match(r.text, /Still needs about: .*walls\/floor\/roof/)
  r = await runWithMemory(bot, mem, 'build_base', { style: 'surface', size: 'small' })
  assert.match(r.text, /worked on the small surface base .* Still need: .*walls\/floor\/roof/)
  const proj = mem.getProject('base')
  assert.strictEqual(proj.status, 'in progress')
  assert.match(mem.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Unfinished project "base": small surface base/)
  stockBase(bot)
  r = await runWithMemory(bot, mem, 'build_base', {})
  assert.match(r.text, /finished the small surface base/, r.text)
  const again = mem.getProject('base')
  assert.deepStrictEqual(again.origin, proj.origin, 'same spot after resuming')
})

test('underground base: covered stairs with doors, carved room, water sealed', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 200); bot.give('oak_door', 2); bot.give('torch', 16); bot.give('chest', 1)
  // A water pocket next to where the room will be (room is ~10 down, 10-18 forward).
  for (let x = 5; x <= 6; x++) for (let z = -16; z <= -14; z++) bot.setBlock(new Vec3(x, 55, z), 'water')
  const mem = new Memory(null)
  const r = await runWithMemory(bot, mem, 'build_base', { style: 'underground', size: 'medium', depth: 10 }, 60000)
  console.log(r.text)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /finished the medium underground base/)
  const p = mem.getProject('base')
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z)
  const f = new Vec3(p.f.x, 0, p.f.z); const rr = B.rightOf(f)
  const at = (ri, up, fi) => bot.blockAt(o.plus(rr.scaled(ri)).plus(f.scaled(fi)).offset(0, up, 0))
  assert.strictEqual(at(0, 1, 0).name, 'oak_door')
  assert.strictEqual(at(1, 1, 0).name, 'oak_door')
  assert.strictEqual(at(0, 4, 0).name, 'cobblestone', 'entrance is roofed')
  assert.strictEqual(at(-1, 2, 0).name, 'cobblestone', 'entrance has walls')
  assert.strictEqual(at(0, -4, 5).name, 'air', 'stairs are dug')
  assert.strictEqual(at(0, -9, 14).name, 'air', 'room is dug')
  // no water left touching the room
  const plan = B.toWorld(B.undergroundBaseCells('medium', 10), o, f, rr)
  const wet = plan.cells.filter(c => c.role !== 'support' && bot.blockAt(c.pos).name === 'water')
  assert.strictEqual(wet.length, 0, 'water sealed out')
  assert.ok(r.text.includes('sealed') || plan.cells.every(c => bot.blockAt(c.pos).name !== 'water'))
  assert.ok(mem.getPlace('home'))
})

test('underground base: digging into water seals it off', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 200)
  // Block every direction except north with someone's chests, so the tunnel must go north.
  for (const [x, z] of [[4, 0], [0, 4], [-4, 0], [4, 1], [1, 4], [-4, 1]]) bot.setBlock(new Vec3(x, 62, z), 'chest')
  // Water pocket inside where the north room goes (room air y 54..57, z -10..-18).
  for (let x = -1; x <= 1; x++) for (let z = -15; z <= -13; z++) bot.setBlock(new Vec3(x, 56, z), 'water')
  const mem = new Memory(null)
  const r = await runWithMemory(bot, mem, 'build_base', { style: 'underground', size: 'medium', depth: 10 }, 60000)
  console.log(r.text)
  assert.ok(r.ok, r.text)
  const p = mem.getProject('base')
  assert.deepStrictEqual(p.f, { x: 0, z: -1 })
  assert.match(r.text, /sealed \d+ water\/lava spots/)
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z); const f = new Vec3(0, 0, -1)
  const plan = B.toWorld(B.undergroundBaseCells('medium', 10), o, f, B.rightOf(f))
  assert.strictEqual(plan.cells.filter(c => bot.blockAt(c.pos).name === 'water').length, 0)
})

// ---------------------------------------------------------------- v5: tidy behaviour
const PL = require(P + 'src/body/placement')

// A 7x7 room (walls 3 high) with a door in the south wall at (0,64,3); bot in the middle.
function roomBot () {
  const bot = worldBot()
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    bot.setBlock(new Vec3(x, 63, z), 'cobblestone')
    const edge = Math.abs(x) === 3 || Math.abs(z) === 3
    for (let y = 64; y <= 66; y++) bot.setBlock(new Vec3(x, y, z), edge ? 'oak_planks' : 'air')
    bot.setBlock(new Vec3(x, 67, z), 'oak_planks')
  }
  bot.setBlock(new Vec3(0, 64, 3), 'oak_door'); bot.setBlock(new Vec3(0, 65, 3), 'oak_door')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  return bot
}

test('utility blocks go against a wall, away from the door, and chests pair up', async () => {
  const bot = roomBot()
  bot.give('chest', 2); bot.give('crafting_table', 1)
  let r = await run(bot, 'place_block', { block: 'chest' })
  assert.ok(r.ok, r.text)
  const first = r.text.match(/at (-?\d+), (-?\d+), (-?\d+)/).slice(1).map(Number)
  const p1 = new Vec3(...first)
  const touchingWall = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(d => bot.blockAt(p1.offset(...d)).name === 'oak_planks')
  assert.ok(touchingWall, `first chest at ${p1} is against a wall`)
  assert.ok(!(p1.x === 0 && p1.z === 0), 'not in the middle')
  assert.ok(Math.abs(p1.x) + Math.abs(p1.z - 3) > 2, 'not next to the door')
  r = await run(bot, 'place_block', { block: 'chest' })
  const p2 = new Vec3(...r.text.match(/at (-?\d+), (-?\d+), (-?\d+)/).slice(1).map(Number))
  assert.strictEqual(p1.distanceTo(p2), 1, `second chest ${p2} is beside the first ${p1}`)
  assert.notStrictEqual(bot._props.get(`${p1.x},${p1.y},${p1.z}`).type, 'single', 'they joined into a double chest')
  r = await run(bot, 'place_block', { block: 'crafting_table' })
  const p3 = new Vec3(...r.text.match(/at (-?\d+), (-?\d+), (-?\d+)/).slice(1).map(Number))
  assert.ok([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(d => bot.blockAt(p3.offset(...d)).name === 'oak_planks'))
})

test('collect_block never takes blocks from a base, and leaves buried ores for the mine', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot)
  const mem = new Memory(null)
  let r = await runWithMemory(bot, mem, 'build_base', { style: 'surface', size: 'small' })
  assert.match(r.text, /finished/)
  bot._items.splice(0) // empty inventory
  const before = []
  for (const c of B.toWorld(B.surfaceBaseCells('small'), new Vec3(mem.getProject('base').origin.x, 63, mem.getProject('base').origin.z), new Vec3(0, 0, -1), new Vec3(1, 0, 0)).cells) {
    if (bot.blockAt(c.pos).name === 'oak_log') before.push(c.pos)
  }
  assert.ok(before.length > 0)
  bot.setBlock(new Vec3(15, 64, 15), 'oak_log') // a lone tree trunk outside
  r = await runWithMemory(bot, mem, 'collect_block', { block: 'log', count: 1 })
  assert.ok(r.ok, r.text)
  assert.strictEqual(bot.blockAt(new Vec3(15, 64, 15)).name, 'air', 'took the tree')
  assert.ok(before.every(p => bot.blockAt(p).name === 'oak_log'), 'base frame untouched')
  // A buried iron ore: refuse and suggest mining.
  bot.give('stone_pickaxe', 1)
  bot.setBlock(new Vec3(-10, 50, -10), 'iron_ore')
  const orig = bot.blockAt
  r = await runWithMemory(bot, mem, 'collect_block', { block: 'iron_ore', count: 1 })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /mine/)
})

test('mine: entrance away from home, stairs down to the ore level, branch mining, resumable', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 64); bot.give('torch', 10)
  const mem = new Memory(null)
  mem.setPlace('home', new Vec3(0, 64, 0))
  // An iron layer at y=17 around the area.
  for (let x = -60; x <= 60; x++) for (let z = -60; z <= 60; z++) if ((x + z) % 3 === 0) bot.setBlock(new Vec3(x, 17, z), 'iron_ore')
  const t0 = Date.now()
  let r = await runWithMemory(bot, mem, 'mine', { target: 'iron', count: 4 }, 120000)
  console.log(r.text, `(${Math.round((Date.now() - t0) / 1000)}s)`)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /mined at y=16: .*iron_ore/)
  const mine = mem.getProject('mine')
  const o = new Vec3(mine.origin.x, mine.origin.y, mine.origin.z)
  assert.ok(Math.hypot(o.x, o.z) >= 12, `entrance ${o} is well away from home`)
  assert.strictEqual(mine.depth, 48)
  const f = new Vec3(mine.f.x, 0, mine.f.z)
  const stair = (i) => bot.blockAt(o.plus(f.scaled(i)).offset(0, 1 - i, 0))
  for (const i of [1, 10, 30, 47]) assert.strictEqual(stair(i).name, 'air', `stair step ${i} is dug`)
  assert.strictEqual(bot.blockAt(o.offset(0, 4, 0)).name, 'cobblestone', 'covered entrance')
  const progress1 = mine.levels['16'].progress
  { const M = require(P + 'src/body/mining'); const plan = B.toWorld(M.shaftCells(mine.depth), o, f, B.rightOf(f))
    for (const c of plan.cells) { const b = bot.blockAt(c.pos); if (c.role === 'air' || c.role === 'doortop') assert.ok(['air', 'torch', 'wall_torch'].includes(b.name), `stair cell ${c.rel} dug`) } }
  r = await runWithMemory(bot, mem, 'mine', { target: 'iron', count: 4 }, 120000)
  assert.ok(r.ok, r.text)
  const mine2 = mem.getProject('mine')
  assert.deepStrictEqual(mine2.origin, mine.origin, 'same mine')
  assert.ok(mine2.levels['16'].progress > progress1, 'dug further')
  assert.match(mem.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Your mine: entrance at/)
})

// ---------------------------------------------------------------- v6: railways
const RW = require(P + 'src/body/railway')

function railWorld () {
  const bot = worldBot(); bot.entity.yaw = 0
  // A hill in the way and a pond to cross.
  for (let x = 24; x <= 34; x++) for (let z = -3; z <= 3; z++) {
    const h = 3 - Math.floor(Math.abs(x - 29) / 2)
    for (let y = 64; y < 64 + Math.max(0, h); y++) bot.setBlock(new Vec3(x, y, z), 'dirt')
  }
  for (let x = 42; x <= 48; x++) for (let z = -3; z <= 3; z++) { bot.setBlock(new Vec3(x, 63, z), 'water'); bot.setBlock(new Vec3(x, 62, z), 'water') }
  const mem = new Memory(null)
  mem.setPlace('home', new Vec3(0, 64, 0))
  mem.setPlace('steve_base', new Vec3(70, 64, 25), 'overworld', '', 'Steve')
  mem.addZone('steve_base', new Vec3(70, 64, 25), 8)
  return { bot, mem }
}

function stockRails (bot, rails = 120) {
  bot.give('rail', rails); bot.give('powered_rail', 16); bot.give('redstone_torch', 14); bot.give('oak_button', 2); bot.give('cobblestone', 200)
}

test('railway: from home to a player base, over a hill and across water, with stations', async () => {
  const { bot, mem } = railWorld()
  stockRails(bot)
  let r = await runWithMemory(bot, mem, 'plan_railway', { to: 'Steve' })
  assert.match(r.text, /railway home -> Steve's base: about \d+ blocks/)
  r = await runWithMemory(bot, mem, 'build_railway', { to: 'Steve' }, 120000)
  console.log(r.text)
  assert.match(r.text, /finished the railway to Steve's base/)
  const proj = mem.getProject('rail_steve')
  const rails = proj.rails
  assert.strictEqual(rails.length, proj.cols.length)
  // Stations are outside both protected areas.
  assert.ok(Math.hypot(rails[0].x, rails[0].z) > 7)
  assert.ok(Math.hypot(rails.at(-1).x - 70, rails.at(-1).z - 25) > 8)
  for (let i = 0; i < rails.length; i++) {
    const rr = rails[i]
    const b = bot.blockAt(new Vec3(rr.x, rr.y, rr.z))
    assert.ok(/rail$/.test(b.name), `rail ${i} at ${rr.x},${rr.y},${rr.z} is ${b.name}`)
    assert.ok(T.isFirm(bot.blockAt(new Vec3(rr.x, rr.y - 1, rr.z))), `rail ${i} has a solid bed`)
    assert.ok(['air', 'rail', 'powered_rail'].includes(bot.blockAt(new Vec3(rr.x, rr.y + 1, rr.z)).name), `headroom over rail ${i}`)
    if (i) assert.ok(Math.abs(rr.y - rails[i - 1].y) <= 1, 'no steps higher than one block')
    if (rr.kind === 'powered') {
      const s = new Vec3(rr.x, rr.y, rr.z).plus(RW.sideOf(new Vec3(rr.dx, 0, rr.dz)))
      assert.strictEqual(bot.blockAt(s).name, 'redstone_torch', `torch beside powered rail ${i}`)
    }
  }
  // It went over the hill (some rail higher than 64) or through it, and crossed the pond on a bridge.
  const overPond = rails.filter(rr => rr.x >= 42 && rr.x <= 48)
  if (overPond.length) assert.ok(overPond.every(rr => rr.y >= 64), 'rails sit above the water')
  assert.ok(rails.filter(rr => rr.kind === 'powered').length >= 2)
  assert.strictEqual(rails[0].kind, 'brake'); assert.strictEqual(rails.at(-1).kind, 'brake')
  const end = rails.at(-1); const endDir = new Vec3(end.dx, 0, end.dz)
  assert.ok(T.isFirm(bot.blockAt(new Vec3(end.x, end.y, end.z).plus(endDir))), 'buffer block at the end')
  assert.strictEqual(bot.blockAt(new Vec3(end.x, end.y, end.z).plus(RW.sideOf(endDir))).name, 'oak_button')
  assert.ok(mem.getPlace('rail_steve_station_a'))
})

test('railway: pauses when rails run out and resumes where it stopped', async () => {
  const { bot, mem } = railWorld()
  stockRails(bot, 30)
  let r = await runWithMemory(bot, mem, 'build_railway', { to: 'Steve' }, 120000)
  assert.match(r.text, /Paused, still need: .*rail/)
  const built = mem.getProject('rail_steve').built
  assert.ok(built > 0 && built < mem.getProject('rail_steve').cols.length)
  assert.match(mem.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Railway "rail_steve" to Steve's base: \d+\/\d+ blocks built/)
  bot.give('rail', 100)
  r = await runWithMemory(bot, mem, 'build_railway', { to: 'Steve' }, 120000)
  assert.match(r.text, /finished/, r.text)
})

test('railway offers: once per interval, only when it is easy, and asks where unknown players live', async () => {
  const { startRailOffers } = require(P + 'src/brain/railOffers')
  const { bot, mem } = railWorld()
  bot.players = { Steve: { username: 'Steve', entity: null }, Alex: { username: 'Alex', entity: { type: 'player', username: 'Alex', position: new Vec3(3, 64, 3) } } }
  const notes = []
  const brain = { paused: false, notify: (t, w) => notes.push({ t, w }) }
  const cfg = { bot: { otherBots: [], railOffers: { enabled: true, intervalDays: 7, minDistance: 40 } } }
  // No materials: no offer to Steve (too hard), but Alex nearby gets asked where they live.
  const ctl = startRailOffers(bot, brain, mem, cfg)
  ctl.tick()
  assert.strictEqual(notes.length, 1)
  assert.match(notes[0].t, /don't know where their base is/)
  ctl.tick()
  assert.strictEqual(notes.length, 1, 'Steve is skipped while materials are lacking')
  // With materials (fresh controller so the "too hard" cache is empty): offer to Steve.
  stockRails(bot, 200)
  const ctl2 = startRailOffers(bot, brain, mem, cfg)
  ctl2.tick()
  assert.strictEqual(notes.length, 2)
  assert.match(notes[1].t, /\[railway idea\] You could build a powered minecart railway .* Steve's base/)
  assert.ok(notes[1].w)
  ctl2.tick()
  assert.strictEqual(notes.length, 2, 'not again within a week')
  ctl.stop(); ctl2.stop()
})

// ---------------------------------------------------------------- v7: skill tiers in action
const { SkillBook } = require(P + 'src/skills/skillbook')

async function runSkilled (bot, mem, skills, name, args, timeout = 60000) {
  const ex = new Executor(bot, actions, { memory: mem })
  skills.attach(ex)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

test('novice builder: only small huts, misses blocks, earns XP; bases are refused', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('cobblestone', 120)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: {} } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /haven't learned build base yet/)
  const before = skills.state('building').xp
  r = await runSkilled(bot, mem, skills, 'build', { structure: 'hut', size: 5 })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /kept it small: size 2/)
  assert.ok(skills.state('building').xp > before)
  // ~12% miss chance on a 50-block hut: almost always at least one gap
  assert.match(r.text, /missed \d+ spots|built an? \w+ hut/)
})

test('cabin builder: small bases only, finishing one earns a big chunk of XP', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', size: 'medium' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /a medium base is beyond me for now; I can manage: small/)
  const xp0 = skills.state('building').xp
  r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage' })
  assert.match(r.text, /finished the small surface base/, r.text)
  assert.ok(skills.state('building').xp >= xp0 + 40)
})

test('architect: a two-storey house with a ladder and an upper floor', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 600); bot.give('cobblestone', 200); bot.give('oak_log', 40); bot.give('ladder', 8)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'medium', storeys: 2 }, 120000)
  console.log(r.text)
  assert.match(r.text, /finished the two-storey medium surface base/, r.text)
  const p = mem.getProject('base')
  assert.strictEqual(p.storeys, 2)
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z)
  const at = (ri, up, fi) => bot.blockAt(o.offset(ri, up, -fi))
  for (let up = 1; up <= 5; up++) assert.strictEqual(at(-3, up, 1).name, 'ladder', `ladder at up ${up}`)
  assert.ok(T.isFirm(at(0, 5, 4)), 'upper floor')
  assert.strictEqual(at(0, 6, 4).name, 'air', 'room upstairs')
  assert.ok(T.isFirm(at(0, 10, 4)), 'roof on top of the second storey')
  assert.strictEqual(at(-4, 5, 4).name, 'oak_log', 'log band between floors')
})

test('mining tiers: tunneler can mine iron but not diamonds, and its branches are short', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 64)
  for (let x = -60; x <= 60; x++) for (let z = -60; z <= 60; z++) if ((x + z) % 3 === 0) bot.setBlock(new Vec3(x, 17, z), 'iron_ore')
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { mining: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'mine', { target: 'diamond' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /don't know how to mine for diamond yet; I can go after: stone, coal, copper, iron/)
  const xp0 = skills.state('mining').xp
  r = await runSkilled(bot, mem, skills, 'mine', { target: 'iron', count: 3 }, 120000)
  assert.ok(r.ok, r.text)
  assert.strictEqual(mem.getProject('mine').levels['16'].length, 3)
  assert.ok(skills.state('mining').xp > xp0 + 10, 'ores give XP')
})

test('novice miner cannot dig mines at all', async () => {
  const bot = worldBot(); bot.give('stone_pickaxe', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: {} } })
  const r = await runSkilled(bot, mem, skills, 'mine', { target: 'iron' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /haven't learned mine yet: it needs mining tier 2 "Tunneler"/)
})

// ------------------------------------------------------------------ v0.8: home variants and upgrades
const H = require(P + 'src/body/homes')

function projAt (mem, name = 'base') {
  const p = mem.getProject(name)
  const o = new Vec3(p.origin.x, p.origin.y, p.origin.z)
  const f = new Vec3(p.f.x, 0, p.f.z); const rr = B.rightOf(f)
  return { p, o, at: (ri, up, fi) => o.plus(rr.scaled(ri)).plus(f.scaled(fi)).offset(0, up, 0) }
}

test('variants: the bot picks among the designs it knows, at random', () => {
  const seen = new Set()
  for (let i = 0; i < 40; i++) seen.add(H.pickVariant('surface', ['cottage', 'longhouse', 'cellar', 'hall']))
  assert.deepStrictEqual([...seen].sort(), ['cottage', 'longhouse'])
  assert.strictEqual(H.pickVariant('underground', ['cellar', 'hall'], () => 0.99), 'hall')
  assert.strictEqual(H.pickVariant('surface', []), 'cottage', 'falls back to the classic design')
})

test('longhouse: a long narrow house with a peaked roof', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 400)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 2 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'longhouse' }, 120000)
  assert.match(r.text, /finished the small surface base "base" \(longhouse\)/, r.text)
  const { p, at } = projAt(mem)
  assert.strictEqual(p.variant, 'longhouse')
  const geo = H.baseGeometry(p).geo
  assert.ok(geo.L > geo.W, 'longer than it is wide')
  assert.strictEqual(bot.blockAt(at(0, 1, 0)).name, 'oak_door')
  const ridge = geo.top + 1 + geo.h
  assert.ok(T.isFirm(bot.blockAt(at(0, ridge, 3))), 'ridge of the roof in the middle')
  assert.strictEqual(bot.blockAt(at(geo.h - 1, ridge, 3)).name, 'air', 'roof slopes down toward the sides')
  assert.ok(T.isFirm(bot.blockAt(at(geo.h - 1, geo.top + 2, 3))), 'lower roof near the side wall')
})

test('hall: an underground hall with pillars', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 300); bot.give('oak_door', 2); bot.give('torch', 16)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'underground', variant: 'hall', size: 'medium', depth: 10 }, 120000)
  assert.match(r.text, /finished the medium underground base "base" \(hall\)/, r.text)
  const { p, at } = projAt(mem)
  const geo = H.baseGeometry(p).geo
  const lv = geo.level
  assert.strictEqual(bot.blockAt(at(0, lv, geo.mid)).name, 'air', 'the hall is dug out')
  assert.ok(T.isFirm(bot.blockAt(at(geo.h - 1, lv, geo.roomStart + 2))), 'a pillar left standing')
  assert.strictEqual(bot.blockAt(at(0, 1, 0)).name, 'oak_door')
})

test('upgrades: a finished base suggests upgrades; tier gates them', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 400)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage' }, 120000)
  assert.match(r.text, /finished/, r.text)
  r = await runSkilled(bot, mem, skills, 'build_base', {})
  assert.match(r.text, /already finished .* upgrade_base: storage_room\./, r.text)
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'bunker' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /building tier 3/, r.text)
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'teleporter' })
  assert.match(r.text, /don't know an upgrade called/)
})

test('storage room upgrade: a side room with chests that join into a double chest', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 500); bot.give('chest', 3)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'small' }, 120000)
  assert.match(r.text, /finished/, r.text)
  const xp0 = skills.state('building').xp
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'storage' }, 120000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /added the storage room to the/, r.text)
  const { p, at } = projAt(mem)
  assert.deepStrictEqual(p.upgrades, ['storage_room'])
  const geo = H.baseGeometry(p).geo
  const chests = [-1, 0, 1].map(df => at(-geo.h - 3, 1, geo.mid + df)).filter(q => bot.blockAt(q).name === 'chest')
  assert.ok(chests.length >= 2, `chests in the storage room (${chests.length})`)
  assert.ok(chests.some(q => ['left', 'right'].includes(bot._props.get(`${q.x},${q.y},${q.z}`)?.type)), 'a double chest')
  assert.strictEqual(bot.blockAt(at(-geo.h, 1, geo.mid)).name, 'air', 'doorway through the house wall')
  assert.ok(skills.state('building').xp >= xp0 + 50)
})

test('bunker upgrade: a room under the house with a ladder down', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 500); bot.give('ladder', 8); bot.give('chest', 1); bot.give('stone_pickaxe', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'small' }, 120000)
  assert.match(r.text, /finished/, r.text)
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'bunker' }, 120000)
  assert.ok(r.ok, r.text)
  const { p, at } = projAt(mem)
  const geo = H.baseGeometry(p).geo
  const lf = geo.bunkerF ?? geo.mid + 1
  for (let up = -4; up <= 0; up++) assert.strictEqual(bot.blockAt(at(geo.h - 1, up, lf)).name, 'ladder', `ladder at ${up}`)
  assert.strictEqual(bot.blockAt(at(geo.h - 1, 1, lf)).name, 'air', 'nothing blocks the top of the ladder')
  assert.strictEqual(bot.blockAt(at(0, -3, geo.mid)).name, 'air', 'the bunker is dug out')
  assert.ok(T.isFirm(bot.blockAt(at(0, -1, geo.mid))), 'the house floor is still there above it')
})

test('second storey upgrade: an existing one-storey cottage gets an upper floor', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 700); bot.give('ladder', 8); bot.give('cobblestone', 200); bot.give('oak_log', 40)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'medium' }, 120000)
  assert.match(r.text, /finished the medium/, r.text)
  const { at } = projAt(mem)
  assert.ok(T.isFirm(bot.blockAt(at(0, 5, 4))), 'flat roof before')
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'second story' }, 180000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /two-storey/, r.text)
  for (let up = 1; up <= 5; up++) assert.strictEqual(bot.blockAt(at(-3, up, 1)).name, 'ladder', `ladder at up ${up}`)
  assert.strictEqual(bot.blockAt(at(0, 6, 4)).name, 'air', 'room upstairs')
  assert.ok(T.isFirm(bot.blockAt(at(0, 10, 4))), 'new roof on top')
})

test('enchanting room upgrade: a table ringed by 15 bookshelves with a gap to walk in', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 700); bot.give('bookshelf', 15); bot.give('enchanting_table', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'small' }, 120000)
  assert.match(r.text, /finished/, r.text)
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'enchanting_room' }, 180000)
  assert.ok(r.ok, r.text)
  const { p, at } = projAt(mem)
  const geo = H.baseGeometry(p).geo
  const inner = (d) => geo.h + d
  assert.strictEqual(bot.blockAt(at(inner(3), 1, geo.mid)).name, 'enchanting_table')
  let shelves = 0
  for (let dd = -2; dd <= 2; dd++) for (let df = -2; df <= 2; df++) if (bot.blockAt(at(inner(3 + dd), 1, geo.mid + df)).name === 'bookshelf') shelves++
  assert.strictEqual(shelves, 15)
  assert.strictEqual(bot.blockAt(at(inner(1), 1, geo.mid)).name, 'air', 'gap to walk in')
  for (let dd = -1; dd <= 1; dd++) for (let df = -1; df <= 1; df++) if (dd || df) assert.strictEqual(bot.blockAt(at(inner(3 + dd), 1, geo.mid + df)).name, 'air', 'air between table and shelves')
})

test('upgrades show up in memory and the protected zone grows to cover them', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  stockBase(bot, 500); bot.give('chest', 3)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'cottage', size: 'small' }, 120000)
  const Zn = require(P + 'src/body/zones')
  const { p, at } = projAt(mem)
  const geo = H.baseGeometry(p).geo
  const wingSpot = at(-geo.h - 4, 1, geo.mid)
  Zn.invalidate()
  assert.strictEqual(Zn.zoneAt(mem, at(-geo.h - 7, 1, geo.mid)), null)
  await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'storage_room' }, 120000)
  Zn.invalidate()
  assert.ok(Zn.zoneAt(mem, wingSpot), 'the wing is protected')
  assert.match(mem.summary({ pos: bot.entity.position, dimension: 'overworld' }), /storage room/)
})

// ------------------------------------------------------------------ v0.8: farming
test('farming tier 1: wheat patch next to existing water, other crops refused', async () => {
  const bot = worldBot()
  bot.give('wooden_hoe', 1); bot.give('wheat_seeds', 30); bot.give('carrot', 5)
  bot.setBlock(new Vec3(6, 63, 6), 'water')
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: {} } })
  let r = await runSkilled(bot, mem, skills, 'farm', { crop: 'carrots' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /only know how to grow wheat/)
  r = await runSkilled(bot, mem, skills, 'farm', {}, 60000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /started a 5x5 farm at 6 63 6/, r.text)
  assert.match(r.text, /planted 24 wheat/, r.text)
  assert.strictEqual(bot.blockAt(new Vec3(7, 63, 7)).name, 'farmland')
  assert.strictEqual(bot.blockAt(new Vec3(7, 64, 7)).name, 'wheat')
  assert.ok(mem.getPlace('farm'))
  const r2 = await runSkilled(bot, mem, new SkillBook(new Memory(null), { bot: { skills: {} } }), 'breed_animals', { animal: 'cow' })
  assert.match(r2.text, /farming tier 3/)
})

test('farming tier 1 with no water around says what is missing', async () => {
  const bot = worldBot()
  bot.give('wooden_hoe', 1); bot.give('wheat_seeds', 10); bot.give('water_bucket', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: {} } })
  const r = await runSkilled(bot, mem, skills, 'farm', {})
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /no water source/)
})

test('farming tier 2: makes its own water, fences the plot, harvests and replants ripe wheat', async () => {
  const bot = worldBot()
  bot.give('wooden_hoe', 1); bot.give('wheat_seeds', 64); bot.give('water_bucket', 1); bot.give('oak_fence', 64)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { farming: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'farm', {}, 90000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /started a 9x9 farm/, r.text)
  assert.match(r.text, /placed the water source/)
  assert.match(r.text, /put up \d+ fence posts/)
  const proj = mem.getProject('farm')
  const c = new Vec3(proj.center.x, proj.center.y, proj.center.z)
  assert.strictEqual(bot.blockAt(c).name, 'water')
  assert.strictEqual(proj.water, 'made')
  assert.strictEqual(bot.blockAt(c.offset(5, 1, 3)).name, 'oak_fence')
  assert.strictEqual(bot.blockAt(c.offset(0, 1, -5)).name, 'air', 'a gap in the fence to get in')
  // Grow everything, then another round harvests and replants.
  let ripe = 0
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    const q = c.offset(dx, 1, dz)
    if (bot.blockAt(q).name === 'wheat') { bot._props.set(`${q.x},${q.y},${q.z}`, { age: 7 }); ripe++ }
  }
  assert.ok(ripe >= 60)
  const left = bot._items.findIndex(i => i.name === 'wheat_seeds'); if (left >= 0) bot._items.splice(left, 1) // no seeds in hand
  const dig = bot.dig
  bot.dig = async (b) => { if (b.name === 'wheat') { bot.give('wheat', 1); bot.give('wheat_seeds', 2) } return dig(b) }
  const xp = skills.state('farming').xp
  r = await runSkilled(bot, mem, skills, 'farm', {}, 90000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, new RegExp(`harvested ${ripe} wheat`), r.text)
  assert.match(r.text, /planted \d+ wheat/)
  assert.ok(skills.state('farming').xp > xp + ripe)
  const Zn = require(P + 'src/body/zones'); Zn.invalidate()
  assert.ok(Zn.zoneAt(mem, c.offset(2, 1, 2)), 'the farm is protected')
})

test('farming tier 4: bone meal ripens crops', async () => {
  const bot = worldBot()
  bot.give('wooden_hoe', 1); bot.give('wheat_seeds', 64); bot.give('bone_meal', 10)
  bot.setBlock(new Vec3(3, 63, 3), 'water')
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { farming: 4 } } } })
  await runSkilled(bot, mem, skills, 'farm', {}, 90000)
  const r = await runSkilled(bot, mem, skills, 'farm', {}, 90000)
  assert.match(r.text, /used bone meal 10x/, r.text)
})

test('breeding: feeds two cows of the same kind', async () => {
  const bot = worldBot()
  bot.give('wheat', 4)
  bot.entities = {
    1: { id: 1, name: 'cow', position: new Vec3(3, 64, 0) },
    2: { id: 2, name: 'cow', position: new Vec3(4, 64, 1) },
    3: { id: 3, name: 'pig', position: new Vec3(2, 64, 2) }
  }
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { farming: 3 } } } })
  let r = await runSkilled(bot, mem, skills, 'breed_animals', { animal: 'cows' })
  assert.ok(r.ok, r.text)
  assert.deepStrictEqual(bot.fed.sort(), [1, 2])
  r = await runSkilled(bot, mem, skills, 'breed_animals', { animal: 'pig' })
  assert.match(r.text, /need 2 carrot or potato or beetroot/)
})

// ------------------------------------------------------------------ v0.8: the Nether
test('nether is locked until combat 3 and mining 3', async () => {
  const bot = worldBot()
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: {} } })
  assert.strictEqual(skills.tier('nether'), 0)
  const r = await runSkilled(bot, mem, skills, 'build_portal', {})
  assert.match(r.text, /haven't learned build portal yet.*first get combat tier 3 and mining tier 3/)
})

test('portal: builds a 4x5 obsidian frame with cheap corners and lights it', async () => {
  const bot = worldBot()
  bot.give('obsidian', 10); bot.give('cobblestone', 20); bot.give('flint_and_steel', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { nether: 1 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_portal', {}, 60000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /built and lit a Nether portal/)
  const p = mem.getPlace('nether_portal')
  assert.strictEqual(bot.blockAt(new Vec3(p.x, p.y, p.z)).name, 'nether_portal')
  assert.strictEqual(bot._items.find(i => i.name === 'obsidian'), undefined, 'used all 10 obsidian')
  const r2 = await runSkilled(bot, mem, skills, 'build_portal', {})
  assert.match(r2.text, /already a lit portal/)
})

test('portal refuses without enough obsidian', async () => {
  const bot = worldBot()
  bot.give('obsidian', 6); bot.give('flint_and_steel', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { nether: 1 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_portal', {})
  assert.match(r.text, /need 10 obsidian .* have 6/)
})

test('nether trip: through the portal, mines quartz within range, comes back', async () => {
  const bot = worldBot()
  bot.give('obsidian', 14); bot.give('flint_and_steel', 1); bot.give('bread', 4)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { nether: 2 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_portal', {}, 60000)
  assert.ok(r.ok, r.text)
  // Standing in a portal block switches dimension (the sim keeps one world for both sides).
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal) => {
    await goto(goal)
    if (goal.kind === 'GoalBlock' && bot.blockAt(bot.entity.position).name === 'nether_portal') {
      bot.game.dimension = /nether/.test(bot.game.dimension) ? 'overworld' : 'the_nether'
    }
  }
  const portal = mem.getPlace('nether_portal')
  const near = new Vec3(portal.x + 6, 64, portal.z + 6); const far = new Vec3(portal.x + 18, 64, portal.z - 18)
  bot.setBlock(near, 'nether_quartz_ore'); bot.setBlock(far.offset(30, 0, 0), 'nether_quartz_ore')
  const dig = bot.dig
  bot.dig = async (b) => { if (b.name === 'nether_quartz_ore') bot.give('quartz', 1); return dig(b) }
  r = await runSkilled(bot, mem, skills, 'nether_trip', { get: 'quartz' }, 90000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /back from the Nether with 1 quartz/, r.text)
  assert.strictEqual(bot.game.dimension, 'overworld')
  assert.ok(mem.getPlace('nether_portal_nether'))
  r = await runSkilled(bot, mem, skills, 'nether_trip', { get: 'blaze rods' })
  assert.match(r.text, /not experienced enough to go for blaze_rod/)
})

// ------------------------------------------------------------------ v0.8.1: tier 3 and 4 designs
const ALL_FURNITURE = ['chest', 'barrel', 'ender_chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'smithing_table',
  'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table', 'lectern', 'enchanting_table', 'bookshelf', 'brewing_stand', 'cauldron', 'red_bed', 'oak_fence', 'composter']
function furnishAll (bot, n = 1) {
  for (const it of ALL_FURNITURE) bot.give(it, it === 'chest' ? 24 * n : it === 'bookshelf' ? 15 * n : it === 'red_bed' ? 4 * n : it === 'oak_fence' ? 16 * n : it === 'barrel' ? 4 * n : n)
}
function bigStock (bot, n = 1) {
  bot.give('oak_planks', 1200 * n); bot.give('stone_bricks', 900 * n); bot.give('oak_log', 200 * n); bot.give('cobblestone', 600 * n)
  bot.give('glass', 40); bot.give('oak_door', 4); bot.give('torch', 40); bot.give('ladder', 24)
}
const count = (bot, name) => bot._items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

test('designs: tier 3 adds watchtower and farmhouse; asking for a manor at tier 3 explains what is needed', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  assert.ok(skills.params('building').variants.includes('watchtower'))
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'manor' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /haven't learned manor designs yet: it needs building tier 4 "Architect"/, r.text)
})

test('variantOrder: the newest designs are the likeliest, every known design still appears', () => {
  const known = ['cottage', 'longhouse', 'watchtower', 'farmhouse', 'manor']
  const first = {}
  for (let i = 0; i < 2000; i++) { const o = H.variantOrder('surface', known); first[o[0]] = (first[o[0]] || 0) + 1; assert.strictEqual(new Set(o).size, 5) }
  assert.ok(first.manor > first.watchtower && first.watchtower > first.cottage, JSON.stringify(first))
  assert.ok(first.cottage > 100, 'old favourites still turn up')
})

test('watchtower: three floors joined by a ladder, stone walls, battlements, lookout', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot); furnishAll(bot)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'watchtower', size: 'medium' }, 120000)
  assert.match(r.text, /finished the three-storey medium surface base "base" \(watchtower\)/, r.text)
  const { p, at } = projAt(mem)
  const geo = H.baseGeometry(p).geo
  for (let up = 1; up <= geo.top; up++) assert.strictEqual(bot.blockAt(at(-geo.h + 1, up, 5)).name, 'ladder', `ladder at ${up}`)
  assert.strictEqual(bot.blockAt(at(-geo.h, 2, 2)).name, 'stone_bricks', 'stone walls')
  assert.strictEqual(bot.blockAt(at(0, 1, 0)).name, 'oak_door')
  assert.ok(T.isFirm(bot.blockAt(at(0, geo.top, 3))), 'roof platform')
  const merlons = [-3, -2, -1, 0, 1, 2, 3].map(ri => bot.blockAt(at(ri, geo.top + 1, 0)).name)
  assert.ok(merlons.includes('air') && merlons.includes('stone_bricks'), `battlements: ${merlons}`)
  assert.strictEqual(bot.blockAt(at(2, 5, 2)).name, 'red_bed', 'bedroom on the middle floor')
  assert.strictEqual(bot.blockAt(at(0, 10, 0)).name, 'glass', 'lookout window')
})

test('farmhouse: L-shaped with a kitchen wing, a doorway into it, a covered porch and a yard', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot); furnishAll(bot)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 3, mining: 2 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'farmhouse', size: 'medium' }, 120000)
  assert.match(r.text, /finished the medium surface base "base" \(farmhouse\)/, r.text)
  const { p, at } = projAt(mem)
  const { h } = H.baseGeometry(p).geo // E = 9, h = 4
  assert.strictEqual(bot.blockAt(at(h, 1, 6)).name, 'air', 'doorway into the wing')
  assert.ok(T.isFirm(bot.blockAt(at(h + 5, 1, 6))), 'wing outer wall')
  assert.strictEqual(bot.blockAt(at(h + 1, 1, 7)).name, 'smoker', 'kitchen')
  assert.strictEqual(bot.blockAt(at(h + 3, 1, 1)).name, 'air', 'the yard in the corner of the L is open')
  assert.ok(T.isFirm(bot.blockAt(at(0, 5, -1))), 'porch roof')
  assert.strictEqual(bot.blockAt(at(0, 1, -1)).name, 'air', 'under the porch')
  assert.strictEqual(bot.blockAt(at(-h, 1, -2)).name, 'oak_fence', 'porch post')
  assert.ok(T.isFirm(bot.blockAt(at(0, 9, 4))), 'roof ridge')
  assert.strictEqual(bot.blockAt(at(h - 1, 9, 4)).name, 'air', 'peaked: lower toward the sides')
})

test('manor: the end-game house, fully furnished', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot, 2); furnishAll(bot)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  const xp0 = skills.state('building').xp
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'manor', size: 'small' }, 300000)
  assert.match(r.text, /finished the two-storey small surface base "base" \(manor\)/, r.text)
  assert.doesNotMatch(r.text, /Furniture spots still empty/, r.text)
  const { p, at } = projAt(mem)
  const g = H.baseGeometry(p).geo // W 17, L 11, h 8, mid 5
  const name = (ri, up, fi) => bot.blockAt(at(ri, up, fi)).name
  const up2 = g.H + 1
  // Structure: stone ground floor, wooden upper floor, interior walls with doorways, ladder, balcony.
  assert.strictEqual(name(-g.h, 1, 2), 'stone_bricks')
  assert.strictEqual(name(-g.h, up2 + 1, 2), 'oak_planks')
  assert.strictEqual(name(-2, 1, 3), 'stone_bricks', 'hall wall')
  assert.strictEqual(name(-2, 1, g.mid), 'air', 'doorway into the vault')
  assert.strictEqual(name(2, up2 + 1, g.mid), 'air', 'doorway into the bedrooms')
  for (let up = 1; up <= up2; up++) assert.strictEqual(name(0, up, g.L - 2), 'ladder', `ladder ${up}`)
  assert.strictEqual(name(0, up2 + 1, 0), 'oak_door', 'balcony door')
  assert.ok(T.isFirm(bot.blockAt(at(0, up2, -2))), 'balcony floor')
  assert.strictEqual(name(0, up2 + 1, -2), 'oak_fence', 'balcony railing')
  assert.ok(T.isFirm(bot.blockAt(at(0, g.top + 1 + g.mid, g.mid))), 'roof ridge')
  // Storage vault: a wall of double chests.
  const vault = []; for (let fi = 1; fi <= g.L - 2; fi++) vault.push(at(-g.h + 1, 1, fi))
  assert.ok(vault.every(q => bot.blockAt(q).name === 'chest'))
  assert.ok(vault.filter(q => ['left', 'right'].includes(bot._props.get(`${q.x},${q.y},${q.z}`)?.type)).length >= 8, 'paired into double chests')
  assert.strictEqual(name(-3, 1, g.L - 2), 'ender_chest')
  // Workshop.
  for (const [ri, fi, it] of [[g.h - 1, 1, 'crafting_table'], [g.h - 1, 3, 'blast_furnace'], [3, g.L - 2, 'anvil'], [4, g.L - 2, 'smithing_table'], [4, 1, 'loom']]) assert.strictEqual(name(ri, 1, fi), it)
  // Library: table, 15 shelves, air between, a gap toward the hall.
  const cx = -5
  assert.strictEqual(name(cx, up2 + 1, g.mid), 'enchanting_table')
  let shelves = 0
  for (let dr = -2; dr <= 2; dr++) for (let df = -2; df <= 2; df++) {
    const n = name(cx + dr, up2 + 1, g.mid + df)
    if (Math.max(Math.abs(dr), Math.abs(df)) === 2) { if (n === 'bookshelf') shelves++ } else if (dr || df) assert.strictEqual(n, 'air', 'air between table and shelves')
  }
  assert.strictEqual(shelves, 15)
  assert.strictEqual(name(cx + 2, up2 + 1, g.mid), 'air', 'the way into the ring')
  // Bedrooms and brewing.
  assert.strictEqual([1, 3, 5, 7].filter(fi => name(g.h - 1, up2 + 1, fi) === 'red_bed').length, 4)
  assert.strictEqual(name(4, up2 + 1, g.L - 2), 'brewing_stand')
  assert.ok(skills.state('building').xp > xp0 + 170, 'end-game designs are worth a lot of XP')
  // Upgrades: what's built in is reported, a bunker still fits.
  let u = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'storage_room' })
  assert.match(u.text, /manor already has that built in/)
  u = await runSkilled(bot, mem, skills, 'build_base', {})
  assert.match(u.text, /upgrade_base: bunker\./, u.text)
})

test('manor: missing furniture is listed, and bringing it later furnishes the house', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot, 2); bot.give('chest', 4)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'manor', size: 'small' }, 300000)
  assert.match(r.text, /finished the two-storey small surface base/, r.text)
  for (const want of [/\d+ chest/, /15 bookshelf/, /1 brewing_stand/, /4 bed/, /1 anvil/]) assert.match(r.text, new RegExp('Furniture spots still empty: .*' + want.source), r.text)
  r = await runSkilled(bot, mem, skills, 'build_base', {})
  assert.match(r.text, /already finished.*Furniture spots still empty/, r.text)
  bot.give('bookshelf', 15); bot.give('enchanting_table', 1)
  const xp = skills.state('building').xp
  r = await runSkilled(bot, mem, skills, 'build_base', {}, 120000)
  assert.match(r.text, /: furnished the two-storey small surface base/, r.text)
  assert.doesNotMatch(r.text, /bookshelf/, 'shelves are all in')
  assert.strictEqual(count(bot, 'bookshelf'), 0)
  assert.ok(skills.state('building').xp - xp < 40, 'furnishing is not paid like a new base')
})

function buildHill (bot) {
  // A big hill to the north: solid stone from y 64 to 75 for z <= -6.
  for (let x = -16; x <= 16; x++) for (let z = -36; z <= -6; z++) for (let y = 64; y <= 75; y++) bot.setBlock(new Vec3(x, y, z), 'stone')
}

test('hillside fortress: dug into a hill with a facade, great hall, vault, forge, library, bedroom, brewing room', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  buildHill(bot)
  bigStock(bot); furnishAll(bot); bot.give('stone_pickaxe', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  const r = await runSkilled(bot, mem, skills, 'build_base', { style: 'underground', variant: 'hillside', size: 'small' }, 300000)
  assert.match(r.text, /finished the small underground base "base" \(hillside\)/, r.text)
  const { p, at } = projAt(mem)
  assert.deepStrictEqual(p.f, { x: 0, z: -1 }, 'faces the hill')
  const g = H.baseGeometry(p).geo
  const name = (ri, up, fi) => bot.blockAt(at(ri, up, fi)).name
  assert.strictEqual(name(0, 1, 0), 'oak_door')
  assert.strictEqual(name(2, 2, 0), 'glass', 'facade windows')
  assert.strictEqual(name(-3, 3, 0), 'stone_bricks', 'facade frame')
  assert.strictEqual(name(0, 4, g.mid), 'air', 'the great hall is 4 high')
  assert.strictEqual(name(2, 2, 6), 'stone_bricks', 'pillar')
  assert.ok(T.isFirm(bot.blockAt(at(0, 5, g.mid))), 'rock roof over the hall')
  assert.strictEqual(name(-10, 1, 7), 'chest', 'vault')
  assert.strictEqual(name(10, 1, 9), 'anvil', 'forge')
  assert.strictEqual(name(0, 1, g.back + 3), 'enchanting_table')
  assert.strictEqual(name(0, 1, g.back + 1), 'air', 'way into the library')
  assert.strictEqual(name(-8, 1, g.back + 1), 'red_bed')
  assert.strictEqual(name(8, 1, g.back + 3), 'brewing_stand')
  assert.ok(mem.getPlace('home'))
})

test('hillside: with no hill nearby it says so; a random pick falls back to another design', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bot.give('stone_pickaxe', 1); bot.give('cobblestone', 300); bot.give('oak_door', 2)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  let r = await runSkilled(bot, mem, skills, 'build_base', { style: 'underground', variant: 'hillside' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /no hill or cliff nearby/)
  const rnd = Math.random
  Math.random = () => 0.99 // weighted order: hillside first
  try {
    r = await runSkilled(bot, mem, skills, 'build_base', { style: 'underground', size: 'small', depth: 8 }, 120000)
  } finally { Math.random = rnd }
  assert.match(r.text, /I wanted a hillside, but the land here didn't suit it, so I went with a (cellar|hall)/, r.text)
})

test('upgrades follow the design: a watchtower takes a bunker but not a second storey', async () => {
  const bot = worldBot(); bot.entity.yaw = 0
  bigStock(bot); furnishAll(bot); bot.give('stone_pickaxe', 1)
  const mem = new Memory(null)
  const skills = new SkillBook(mem, { bot: { skills: { startTiers: { building: 4, mining: 3 } } } })
  await runSkilled(bot, mem, skills, 'build_base', { style: 'surface', variant: 'watchtower', size: 'small' }, 120000)
  let r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'second_storey' })
  assert.match(r.text, /doesn't fit a watchtower/)
  r = await runSkilled(bot, mem, skills, 'upgrade_base', { upgrade: 'bunker' }, 120000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /added the bunker to the two-storey small surface base "base" \(watchtower \+ bunker\)/, r.text)
})
