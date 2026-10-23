'use strict'

// Player habits as pure logic: hazards, gear plans, food, loot, trades, gestures, and the needs
// and autopilot choices that come from them.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const SV = require('../src/body/survival')
const { chooseTrades } = require('../src/body/trading')
const { gestureFor, levelOf } = require('../src/body/mannerisms')
const { SKILLS } = require('../src/skills/registry')
const { assessNeeds } = require('../src/brain/drives')
const { chooseActivity } = require('../src/brain/autopilot')
const { Memory } = require('../src/brain/memory')
const { fakeBot } = require('./helpers')

const ITEMS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'iron_ingot', 'stick', 'oak_planks', 'cobblestone', 'diamond', 'iron_sword',
  'iron_chestplate', 'beef', 'potato', 'cooked_beef', 'bread', 'dirt', 'leather', 'emerald', 'wheat', 'bookshelf', 'red_bed', 'raw_iron']

function botWith (items = {}, blocks = {}) {
  const bot = fakeBot()
  bot.registry.itemsByName = {}
  bot.registry.items = {}
  ITEMS.forEach((n, i) => { bot.registry.itemsByName[n] = { id: 100 + i, name: n, maxDurability: /_pickaxe|_sword|_chestplate/.test(n) ? 250 : undefined }; bot.registry.items[100 + i] = bot.registry.itemsByName[n] })
  bot.registry.foodsByName = { beef: { foodPoints: 3, saturation: 1.8 }, potato: { foodPoints: 1, saturation: 0.6 }, cooked_beef: { foodPoints: 8, saturation: 12.8 }, bread: { foodPoints: 5, saturation: 6 } }
  bot.registry.blocksByName = { red_bed: { id: 1, name: 'red_bed' }, chest: { id: 2, name: 'chest' }, furnace: { id: 3, name: 'furnace' } }
  for (const [name, n] of Object.entries(items)) {
    const [base, used] = name.split('@')
    bot._items.push({ name: base, count: n, type: bot.registry.itemsByName[base].id, durabilityUsed: used ? Number(used) : 0 })
  }
  const solid = (name) => ({ name, boundingBox: 'block', position: null })
  bot.blockAt = (p) => {
    const k = `${p.x},${p.y},${p.z}`
    if (blocks[k]) return { ...(typeof blocks[k] === 'string' ? (blocks[k] === 'air' ? { name: 'air', boundingBox: 'empty' } : blocks[k] === 'lava' || blocks[k] === 'cobweb' || blocks[k] === 'fire' ? { name: blocks[k], boundingBox: 'empty' } : solid(blocks[k])) : blocks[k]), position: p }
    return p.y < 64 ? { ...solid('stone'), position: p } : { name: 'air', boundingBox: 'empty', position: p }
  }
  return bot
}

test('hazards: lava, fire, smothering sand (not a slab overhead), cobwebs', () => {
  let bot = botWith({}, { '0,64,0': 'lava' })
  assert.strictEqual(SV.hazard(bot).kind, 'lava')
  bot = botWith()
  bot.entity.metadata = [0x01]
  assert.strictEqual(SV.hazard(bot).kind, 'fire')
  bot = botWith({}, { '0,65,0': { name: 'sand', boundingBox: 'block' } })
  assert.strictEqual(SV.hazard(bot).kind, 'suffocating')
  bot = botWith({}, { '0,65,0': { name: 'oak_slab', boundingBox: 'block', shapes: [[0, 0.5, 0, 1, 1, 1]] } })
  assert.strictEqual(SV.hazard(bot), null)
  bot = botWith({}, { '0,64,0': 'cobweb' })
  assert.strictEqual(SV.hazard(bot).kind, 'cobweb')
  assert.strictEqual(SV.hazard(botWith()), null)
})

test('hazards: the safe spot is solid ground away from lava', () => {
  const blocks = {}
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) blocks[`${x},63,${z}`] = 'lava'
  blocks['0,64,0'] = 'lava'
  const bot = botWith({}, blocks)
  const s = SV.safeSpot(bot, new Vec3(0, 64, 0), 5)
  assert.ok(s)
  assert.ok(Math.max(Math.abs(s.x), Math.abs(s.z)) >= 3, `spot ${s} should be off the lava pool`)
})

test('gear: upgrades what it can afford, replaces worn tools, plans armour', () => {
  let bot = botWith({ wooden_pickaxe: 1, iron_ingot: 3, stick: 4 })
  assert.deepStrictEqual(SV.gearPlan(bot).map(p => p.item), ['iron_pickaxe'])
  bot = botWith({ 'iron_pickaxe@245': 1, iron_ingot: 3, stick: 2 })
  const plan = SV.gearPlan(bot)
  assert.strictEqual(plan[0].item, 'iron_pickaxe')
  assert.match(plan[0].why, /nearly broken/)
  assert.deepStrictEqual(SV.wornGear(bot).map(w => w.name), ['iron_pickaxe'])
  bot = botWith({ iron_pickaxe: 1, iron_sword: 1, iron_ingot: 24 })
  const armour = SV.gearPlan(bot).map(p => p.item)
  assert.ok(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].every(a => armour.includes(a)), armour.join())
  assert.match(SV.nextGearHint(botWith({ stone_pickaxe: 1, iron_ingot: 1 })), /iron pickaxe \(2 more iron/)
})

test('food and loot: raw food to cook (keeping seed potatoes), loot that belongs in a chest', () => {
  const bot = botWith({ beef: 5, potato: 6, cooked_beef: 2, iron_pickaxe: 1, dirt: 60, raw_iron: 10 })
  assert.deepStrictEqual(SV.rawFood(bot), { beef: 5, potato: 2 })
  assert.strictEqual(SV.readyFood(bot), 16)
  assert.strictEqual(SV.lootCount(bot), 70)
})

test('needs: worn pickaxe, raw food, nights without sleep, loot at home', () => {
  const bot = botWith({ 'iron_pickaxe@245': 1, iron_sword: 1, beef: 6, cooked_beef: 1, dirt: 64 })
  bot.time = { timeOfDay: 3000, age: 24000 * 10 + 3000 }
  bot.inventory.slots = []
  const memory = new Memory(null)
  memory.setPlace('home', new Vec3(0, 64, 0), 'overworld')
  memory.data.lastSleptDay = 6
  const needs = assessNeeds(bot, { memory }).map(n => `${n.level}: ${n.text}`).join('\n')
  assert.match(needs, /soon: you haven't slept for 4 nights/)
  assert.match(needs, /iron_pickaxe is nearly broken/)
  assert.match(needs, /raw food \(6 beef\)/)
  assert.match(needs, /lots of loot/)
})

test('autopilot: bedtime at home, putting loot away', () => {
  const bot = botWith({ dirt: 64 })
  bot.time = { timeOfDay: 15000 }
  bot.findBlock = ({ matching }) => [].concat(matching).includes(1) ? { position: new Vec3(2, 64, 0) } : null
  const memory = new Memory(null)
  memory.setPlace('home', new Vec3(0, 64, 0), 'overworld')
  assert.deepStrictEqual(chooseActivity(bot, { memory }).plan, [{ name: 'sleep', args: {} }])
  bot.time = { timeOfDay: 3000 }
  bot.findBlock = ({ matching }) => [].concat(matching).includes(2) ? { position: new Vec3(2, 64, 0) } : null
  assert.deepStrictEqual(chooseActivity(bot, { memory }).plan, [{ name: 'deposit', args: {} }])
})

test('trading: sell surplus for emeralds, buy what was asked, never sell what you need', () => {
  const bot = botWith({ wheat: 50, emerald: 2, iron_ingot: 4 })
  const it = (name, count) => ({ name, count })
  const trades = [
    { inputItem1: it('wheat', 20), outputItem: it('emerald', 1), maximumNbTradeUses: 16, nbTradeUses: 0 },
    { inputItem1: it('emerald', 6), outputItem: it('bookshelf', 3), maximumNbTradeUses: 12, nbTradeUses: 0 },
    { inputItem1: it('iron_ingot', 4), outputItem: it('emerald', 1), maximumNbTradeUses: 12, nbTradeUses: 0 },
    { inputItem1: it('wheat', 20), outputItem: it('emerald', 1), tradeDisabled: true }
  ]
  const plan = chooseTrades(bot, trades, { want: 'bookshelf' })
  assert.deepStrictEqual(plan.map(p => [p.kind, p.index, p.times]), [['sell', 0, 2], ['buy', 1, 4]])
  // Without a shopping list it keeps some back.
  assert.deepStrictEqual(chooseTrades(bot, trades, {}).map(p => [p.kind, p.times]), [['sell', 1]])
  // Iron isn't surplus unless you ask to sell it.
  assert.ok(!plan.some(p => p.index === 2))
  assert.ok(chooseTrades(bot, trades, { sell: 'iron_ingot' }).some(p => p.index === 2 && p.times === 1))
})

test('mannerisms: gestures fit what is said; level comes from config', () => {
  assert.strictEqual(gestureFor('hey there, thanks!'), 'nod')
  assert.strictEqual(gestureFor('haha nice one'), 'hop')
  assert.strictEqual(gestureFor('nope, not doing that'), 'shake')
  assert.strictEqual(gestureFor('mining some iron'), null)
  assert.strictEqual(levelOf({ bot: { mannerisms: { enabled: false, level: 1 } } }), 0)
  assert.strictEqual(levelOf({ bot: { mannerisms: { level: 0.8 } } }), 0.8)
  assert.strictEqual(levelOf({ bot: {} }), 0.5)
})

test('skills: every "future" tier is real now', () => {
  for (const [id, s] of Object.entries(SKILLS)) for (const t of s.tiers) assert.doesNotMatch(t.next, /future/, `${id}: ${t.name}`)
  assert.ok(SKILLS.mining.tiers[4].params.strip)
  assert.ok(SKILLS.mining.tiers[1].params.cave && !SKILLS.mining.tiers[0].params.cave)
  assert.ok(SKILLS.farming.tiers[4].params.crops.includes('sugar_cane'))
  assert.ok(SKILLS.farming.tiers[2].params.pens)
  assert.deepStrictEqual(SKILLS.nether.tiers[4].requires, { combat: 4, mining: 4 })
  assert.ok(SKILLS.nether.tiers[4].params.targets.includes('ancient_debris'))
})
