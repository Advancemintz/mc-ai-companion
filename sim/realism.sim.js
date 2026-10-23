'use strict'
// Simulated-world tests for player habits: hazards, cooking, gear, caving, the melon patch,
// sugar cane, animal pens, villager trading, netherite, and mannerisms.
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
const SV = require(P + 'src/body/survival')
const Z = require(P + 'src/body/zones')

function setup (startTiers = {}) {
  const bot = worldBot()
  bot.entities = {}
  bot.inventory.slots = []
  bot.nearestEntity = (fn = () => true) => Object.values(bot.entities).filter(e => e !== bot.entity && fn(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot._controls = {}
  bot.setControlState = (k, v) => { bot._controls[k] = v }
  bot.equip = async (item, dest) => { if (dest === 'off-hand') bot.inventory.slots[45] = item; else if (['head', 'torso', 'legs', 'feet'].includes(dest)) bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[dest]] = item; else bot.heldItem = item }
  bot.goals = []
  // The stub pathfinder teleports to the goal.
  bot.pathfinder.goto = async (goal) => {
    const a = goal.args
    bot.goals.push(goal.kind)
    if (goal.kind === 'GoalNear') bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5)
    else if (goal.kind === 'GoalNearXZ') bot.entity.position = new Vec3(a[0] + 0.5, bot.entity.position.y, a[1] + 0.5)
    else if (goal.kind === 'GoalLookAtBlock') {
      const p = a[0]
      const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p.offset(dx, 0, dz)).find(q => bot.blockAt(q).boundingBox === 'empty' && bot.blockAt(q.offset(0, 1, 0)).boundingBox === 'empty') ||
        [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p.offset(dx, -1, dz)).find(q => bot.blockAt(q).boundingBox === 'empty') || p.offset(0, 1, 0)
      bot.entity.position = new Vec3(spot.x + 0.5, spot.y, spot.z + 0.5)
    } else if (goal.kind === 'GoalFollow') { const e = a[0]; bot.entity.position = e.position.offset(1.5, 0, 0) }
    else if (goal.kind === 'GoalBlock') bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5)
    if (bot._onMove) await bot._onMove(goal)
  }
  const memory = new Memory(null)
  const config = { bot: { skills: { startTiers } }, reflexes: { fleeHealth: 6 } }
  const skills = new SkillBook(memory, config)
  Z.invalidate()
  return { bot, memory, skills, config }
}

async function act (env, name, args = {}, timeout = 30000) {
  const ex = new Executor(env.bot, actions, { memory: env.memory, config: env.config })
  env.skills.attach(ex)
  if (env.hooks) Object.assign(ex, env.hooks)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, timeout)
  return out
}

// ---------------------------------------------------------------- hazards

test('hazard: standing in lava, it scrambles onto safe ground', async () => {
  const { bot } = setup()
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) { bot.setBlock(new Vec3(x, 63, z), 'lava'); bot.setBlock(new Vec3(x, 64, z), 'lava') }
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  // Controls move it in the direction it looks.
  const iv = setInterval(() => { if (bot._controls.forward) { const y = bot.entity.yaw; bot.entity.position = bot.entity.position.offset(-Math.sin(y) * 0.3, 0, -Math.cos(y) * 0.3) } }, 30)
  bot.lookAt = async (p) => { const d = p.minus(bot.entity.position); bot.entity.yaw = Math.atan2(-d.x, -d.z) }
  try {
    const h = SV.hazard(bot)
    assert.strictEqual(h.kind, 'lava')
    const what = await SV.escape(bot, h)
    assert.match(what, /scrambled out of lava/)
    assert.strictEqual(SV.hazard(bot), null)
  } finally { clearInterval(iv) }
})

test('hazard: on fire with a water bucket, it douses itself and scoops the water back up', async () => {
  const { bot } = setup()
  bot.give('water_bucket', 1)
  bot.entity.metadata = [0x01]
  bot.activateItem = () => {
    if (bot.heldItem?.name === 'water_bucket') { bot._use('water_bucket'); bot.give('bucket', 1); bot.entity.metadata = [0] }
    else if (bot.heldItem?.name === 'bucket') { bot._use('bucket'); bot.give('water_bucket', 1) }
  }
  const what = await SV.escape(bot, SV.hazard(bot))
  assert.match(what, /water bucket/)
  assert.strictEqual(bot.entity.metadata[0], 0)
  assert.ok(bot._items.some(i => i.name === 'water_bucket'))
})

// ---------------------------------------------------------------- cooking and gear

test('cook: raw meat goes in the smoker when there is one', async () => {
  const env = setup()
  const { bot } = env
  bot.give('beef', 6); bot.give('coal', 3); bot.give('potato', 2)
  bot.setBlock(new Vec3(3, 64, 0), 'furnace')
  bot.setBlock(new Vec3(4, 64, 2), 'smoker')
  bot.setSmelting({ beef: 'cooked_beef' })
  const r = await act(env, 'cook')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /cooked 6 cooked_beef in the smoker/)
  assert.deepStrictEqual(bot.usedStations, ['smoker'])
  assert.strictEqual(bot._items.find(i => i.name === 'potato').count, 2) // seed potatoes kept
})

test('upgrade_gear: crafts an iron pickaxe and armour, wears it, says what is next', async () => {
  const env = setup()
  const { bot } = env
  bot.give('wooden_pickaxe', 1); bot.give('iron_ingot', 13); bot.give('stick', 2); bot.give('oak_planks', 8)
  bot.setBlock(new Vec3(2, 64, 0), 'crafting_table')
  bot.addRecipes({
    iron_pickaxe: { table: true, needs: { iron_ingot: 3, stick: 2 } },
    iron_sword: { table: true, needs: { iron_ingot: 2, stick: 1 } },
    iron_chestplate: { table: true, needs: { iron_ingot: 8 } },
    stick: { gives: 4, needs: { oak_planks: 2 } }
  })
  const r = await act(env, 'upgrade_gear')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /crafted iron_pickaxe, iron_sword, iron_chestplate/)
  assert.match(r.text, /now wearing iron_chestplate/)
  assert.strictEqual(bot.inventory.slots[6]?.name, 'iron_chestplate')
  assert.ok(bot.crafted.includes('iron_pickaxe'))
})

// ---------------------------------------------------------------- caving

function carveCave (bot) {
  // A shaft at (10, 54..63, 0) down into a tunnel running east at y 54..56, with ore in the walls.
  for (let y = 54; y <= 63; y++) bot.setBlock(new Vec3(10, y, 0), 'cave_air')
  for (let x = 10; x <= 40; x++) for (let y = 54; y <= 56; y++) for (let z = -1; z <= 1; z++) bot.setBlock(new Vec3(x, y, z), 'cave_air')
  bot.setBlock(new Vec3(18, 55, 2), 'iron_ore')
  bot.setBlock(new Vec3(19, 55, 2), 'iron_ore') // a vein of two
  bot.setBlock(new Vec3(30, 57, 0), 'coal_ore')
  bot.setBlock(new Vec3(36, 55, -2), 'iron_ore')
}

test('cave: walks in, lights the way, mines the ore on the walls, comes back out', async () => {
  const env = setup({ mining: 2 })
  const { bot, memory } = env
  carveCave(bot)
  memory.addDiscovery('cave', 'cave', new Vec3(10, 64, 0), 'overworld', 'a way down')
  bot.give('stone_pickaxe', 1); bot.give('torch', 16); bot.give('bread', 3)
  const r = await act(env, 'cave', {}, 60000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /went caving at the cave at 10 64 0: mined .*iron_ore/)
  assert.match(r.text, /placed \d+ torches/)
  assert.strictEqual(bot.blockAt(new Vec3(18, 55, 2)).name, 'air')
  assert.strictEqual(bot.blockAt(new Vec3(19, 55, 2)).name, 'air')
  assert.ok(bot.entity.position.distanceTo(new Vec3(10, 64, 0)) < 4, `ended at ${bot.entity.position}`)
  assert.match(memory.discoveriesNear(new Vec3(10, 64, 0), 'overworld', 1)[0].note, /caved .*iron_ore/)
})

test('cave: no torches, no trip; a beginner miner can\'t cave yet', async () => {
  let env = setup({ mining: 2 })
  env.bot.give('stone_pickaxe', 1)
  let r = await act(env, 'cave')
  assert.match(r.text, /need at least 4 torches/)
  env = setup({ mining: 1 })
  env.bot.give('stone_pickaxe', 1); env.bot.give('torch', 10)
  r = await act(env, 'cave')
  assert.match(r.text, /haven't learned cave yet/)
})

// ---------------------------------------------------------------- farming

test('melon patch: stems with room to grow, then the fruit gets harvested', async () => {
  const env = setup({ farming: 5 })
  const { bot, memory } = env
  bot.give('wooden_hoe', 1); bot.give('melon_seeds', 4)
  let r = await act(env, 'farm', { crop: 'melon' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /started a melon patch at .*planted 3 melon/)
  const proj = memory.getProject('melon_patch')
  const c = new Vec3(proj.corner.x, proj.corner.y, proj.corner.z)
  for (const x of [1, 3, 5]) assert.strictEqual(bot.blockAt(c.offset(x, 1, 1)).name, 'melon_stem')
  assert.strictEqual(bot.blockAt(c.offset(2, 0, 1)).name, 'grass_block') // room for fruit
  bot.setBlock(c.offset(2, 1, 1), 'melon'); bot.setBlock(c.offset(3, 1, 0), 'melon')
  r = await act(env, 'farm', { crop: 'melon' })
  assert.match(r.text, /harvested 2 melon slice/)
  assert.strictEqual(bot.blockAt(c.offset(3, 1, 1)).name, 'melon_stem') // stems stay
})

test('sugar cane: planted beside water, cut leaving the bottom block', async () => {
  const env = setup({ farming: 5 })
  const { bot } = env
  bot.setBlock(new Vec3(6, 63, 6), 'water')
  bot.give('sugar_cane', 4)
  let r = await act(env, 'farm', { crop: 'sugar cane' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /picked 4 spots by the water .*planted 4 sugar cane/)
  bot.setBlock(new Vec3(7, 65, 6), 'sugar_cane'); bot.setBlock(new Vec3(7, 66, 6), 'sugar_cane')
  r = await act(env, 'farm', { crop: 'sugar_cane' })
  assert.match(r.text, /harvested 2 sugar cane/)
  assert.strictEqual(bot.blockAt(new Vec3(7, 64, 6)).name, 'sugar_cane')
  assert.strictEqual(bot.blockAt(new Vec3(7, 65, 6)).name, 'air')
  const low = setup({ farming: 4 })
  low.bot.give('sugar_cane', 2)
  r = await act(low, 'farm', { crop: 'sugar_cane' })
  assert.match(r.text, /don't know how to grow sugar cane yet/)
})

test('build_pen: fences a 7x7 pen and lures cows in with wheat', async () => {
  const env = setup({ farming: 3 })
  const { bot, memory } = env
  bot.give('oak_fence', 30); bot.give('wheat', 6)
  const cows = [new Vec3(-12, 64, 4), new Vec3(-10, 64, -6), new Vec3(14, 64, 12)].map((p, i) => ({ id: 50 + i, name: 'cow', type: 'animal', position: p.offset(0.5, 0, 0.5) }))
  for (const c of cows) bot.entities[c.id] = c
  // Animals follow someone holding their food (if they're close enough to notice).
  bot._onMove = async () => {
    if (bot.heldItem?.name !== 'wheat') return
    for (const c of cows) if (c._following || c.position.distanceTo(bot.entity.position) < 10) { c._following = true; c.position = bot.entity.position.offset(0.3, 0, 0.3) }
  }
  bot.unequip = async () => { bot.heldItem = null; for (const c of cows) c._following = false }
  const r = await act(env, 'build_pen', { animal: 'cows', count: 2 }, 60000)
  assert.ok(r.ok, r.text)
  assert.match(r.text, /built a cow pen at .*has [23] cows \(lured [23] in\)/)
  const p = memory.getProject('pen_cow')
  const c = new Vec3(p.corner.x, p.corner.y, p.corner.z)
  const R = require(P + 'src/body/ranch')
  const fenced = R.penRing(c).filter(q => /_fence/.test(bot.blockAt(q).name)).length
  assert.strictEqual(fenced, 24) // ring closed, gate spot included
})

// ---------------------------------------------------------------- trading

test('trade: sells surplus wheat, buys bookshelves, remembers the offers', async () => {
  const env = setup()
  const { bot, memory } = env
  bot.give('wheat', 90); bot.give('emerald', 2)
  const vil = { id: 77, uuid: 'v-1', name: 'villager', type: 'mob', position: new Vec3(8.5, 64, 3.5) }
  bot.entities[vil.id] = vil
  const it = (name, count) => ({ name, count, type: bot.registry.itemsByName[name].id })
  const trades = [
    { inputItem1: it('wheat', 20), outputItem: it('emerald', 1), maximumNbTradeUses: 16, nbTradeUses: 0 },
    { inputItem1: it('emerald', 6), outputItem: it('bookshelf', 3), maximumNbTradeUses: 12, nbTradeUses: 0 },
    { inputItem1: it('emerald', 1), outputItem: it('paper', 4), maximumNbTradeUses: 12, nbTradeUses: 0 }
  ]
  bot.openVillager = async () => ({ trades, close () {} })
  bot.trade = async (win, index, times) => {
    const t = trades[index]
    for (let k = 0; k < t.inputItem1.count * times; k++) bot._use(t.inputItem1.name)
    bot.give(t.outputItem.name, t.outputItem.count * times)
    t.nbTradeUses += times
  }
  const r = await act(env, 'trade', { want: 'bookshelf' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /looked at 1 villager's trades/)
  assert.match(r.text, /sold 80 wheat/) // sold enough to afford it
  assert.match(r.text, /bought 3 bookshelf/)
  assert.match(r.text, /worth knowing: 3 bookshelf for 6 emerald/)
  assert.strictEqual(bot._items.find(i => i.name === 'wheat').count, 10)
  const book = Object.values(memory.data.tradeBook)[0]
  assert.strictEqual(book.trades.length, 3)
  assert.match(memory.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Villager offers you know \(1 villagers\): 3 bookshelf for 6 emerald/)
})

// ---------------------------------------------------------------- the Nether end game

test('make_netherite: debris to scrap, scrap to ingots, then a smithing upgrade', async () => {
  const env = setup({ combat: 4, mining: 4, nether: 5 })
  const { bot } = env
  bot.give('ancient_debris', 4); bot.give('gold_ingot', 4); bot.give('coal', 2)
  bot.give('diamond_sword', 1); bot.give('netherite_upgrade_smithing_template', 1)
  bot.setBlock(new Vec3(3, 64, 0), 'blast_furnace')
  bot.setBlock(new Vec3(0, 64, 3), 'crafting_table')
  bot.setBlock(new Vec3(-3, 64, 0), 'smithing_table')
  bot.setSmelting({ ancient_debris: 'netherite_scrap' })
  bot.addRecipes({ netherite_ingot: { table: true, needs: { netherite_scrap: 4, gold_ingot: 4 } } })
  // A smithing table window: slots 0-3, then the inventory.
  bot.openBlock = async () => {
    const win = { slots: [null, null, null, null], inventoryStart: 4, inventoryEnd: 4 + bot._items.length }
    bot._items.forEach((i, k) => { win.slots[4 + k] = i })
    win.check = () => { if (win.slots[0] && win.slots[1] && win.slots[2]) win.slots[3] = { name: 'netherite_sword', count: 1 } }
    bot._win = win
    return win
  }
  bot.moveSlotItem = async (from, to) => { bot._win.slots[to] = bot._win.slots[from]; bot._win.slots[from] = null; bot._win.check() }
  bot.clickWindow = async (slot) => {
    if (slot !== 3 || !bot._win.slots[3]) return
    bot._use('netherite_upgrade_smithing_template'); bot._use('diamond_sword'); bot._use('netherite_ingot')
    bot.give('netherite_sword', 1)
  }
  bot.closeWindow = () => {}
  const r = await act(env, 'make_netherite', {})
  assert.ok(r.ok, r.text)
  assert.match(r.text, /smelted 4 netherite_scrap in the blast furnace/)
  assert.match(r.text, /crafted 1 netherite_ingot/)
  assert.match(r.text, /upgraded to netherite_sword/)
  assert.ok(bot._items.some(i => i.name === 'netherite_sword'))
  assert.ok(!bot._items.some(i => i.name === 'diamond_sword'))
})

test('ancient debris: tunnels at the debris layer and only takes what the tunnel uncovers', async () => {
  const env = setup({ combat: 4, mining: 4, nether: 5 })
  const { bot } = env
  bot.give('diamond_pickaxe', 1)
  bot.entity.position = new Vec3(0.5, 15, 0.5)
  for (let y = 15; y <= 16; y++) bot.setBlock(new Vec3(0, y, 0), 'air')
  bot.setBlock(new Vec3(3, 15, 1), 'ancient_debris') // next to the tunnel: found
  bot.setBlock(new Vec3(3, 15, 9), 'ancient_debris') // deep in the rock: never seen
  const NT = require(P + 'src/body/netherite')
  const ctx = { bot, memory: env.memory, skills: env.skills, check () {}, sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))), race: (p) => p, setStatus () {} }
  const stats = { dug: 0 }
  await NT.tunnelForDebris(ctx, new Vec3(-20, 15, 0), 128, Date.now() + 5000, stats)
  assert.ok(stats.debris >= 1)
  assert.strictEqual(bot.blockAt(new Vec3(3, 15, 1)).name, 'air')
  assert.strictEqual(bot.blockAt(new Vec3(3, 15, 9)).name, 'ancient_debris')
})

// ---------------------------------------------------------------- mannerisms

test('mannerisms: a pause before work, and a step back to admire a finished hut', async () => {
  const env = setup({ building: 1 })
  const { bot } = env
  const { attachMannerisms } = require(P + 'src/body/mannerisms')
  bot.give('cobblestone', 80)
  bot.entity.yaw = 0
  const ex = new Executor(bot, actions, { memory: env.memory })
  env.skills.attach(ex)
  const brain = {}
  attachMannerisms(bot, ex, brain, { bot: { mannerisms: { level: 1 } } })
  const looks = []
  bot.lookAt = async (p) => { looks.push(p) }
  const rnd = Math.random
  Math.random = () => 0.1
  try {
    let out = null
    ex.on('planFinished', e => { out = e.results[0] })
    ex.on('actionFailed', e => { out = 'FAILED ' + e.error })
    const t0 = Date.now()
    ex.setPlan([{ name: 'build', args: { structure: 'hut' } }])
    await until(() => out, 20000)
    assert.match(out, /built an? \w+ hut/)
    assert.ok(Date.now() - t0 >= 150, 'paused first')
    assert.ok(bot.goals.includes('GoalNearXZ'), 'stepped back')
    assert.ok(looks.length >= 1, 'looked at the build')
    // Gestures: a crouch-nod for thanks.
    const said = []
    bot.setControlState = (k, v) => said.push(`${k}:${v}`)
    brain.onSaid('thanks!')
    await until(() => said.includes('sneak:true'), 2000)
  } finally { Math.random = rnd }
})
