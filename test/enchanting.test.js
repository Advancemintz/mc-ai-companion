'use strict'

// Enchanting as logic: bookshelf power, which offer to take, what to enchant first, which
// book goes on which item.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const EN = require('../src/body/enchanting')
const { SKILLS } = require('../src/skills/registry')
const { fakeBot } = require('./helpers')

const tier = (n) => SKILLS.enchanting.tiers[n - 1].params

function tableBot (shelves, blocked = []) {
  const bot = fakeBot()
  const map = new Map()
  for (const p of shelves) map.set(p.toString(), 'bookshelf')
  for (const p of blocked) map.set(p.toString(), 'stone')
  bot.blockAt = (p) => ({ name: map.get(p.toString()) || 'air', position: p })
  return bot
}

function fullRing () {
  const out = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) out.push(new Vec3(dx, 64, dz))
  return out // 16 spots at table height
}

test('bookshelves: two out with air between, at most 15 count', () => {
  const T = new Vec3(0, 64, 0)
  assert.strictEqual(EN.bookshelfPower(tableBot(fullRing()), T), 15)
  assert.strictEqual(EN.bookshelfPower(tableBot(fullRing().slice(0, 6)), T), 6)
  // Something in the gap blocks the shelves behind it.
  const blockedGap = new Vec3(1, 64, 0)
  assert.strictEqual(EN.bookshelfPower(tableBot([new Vec3(2, 64, 0), new Vec3(2, 64, 1), new Vec3(-2, 64, 0)], [blockedGap]), T), 1)
  assert.strictEqual(EN.bestLevelFor(15), 30)
  assert.strictEqual(EN.bestLevelFor(0), 8)
})

test('offers: a dabbler takes the best it can afford, an enchanter saves for the top, a master reads them', () => {
  const bot = fakeBot()
  bot.registry.enchantments = { 1: { name: 'efficiency' }, 2: { name: 'unbreaking' }, 3: { name: 'fortune' }, 4: { name: 'bane_of_arthropods' } }
  const offers = [{ level: 8, expected: { enchant: 2, level: 1 } }, { level: 19, expected: { enchant: 3, level: 2 } }, { level: 30, expected: { enchant: 1, level: 4 } }]
  bot.experience = { level: 22 }
  assert.deepStrictEqual(EN.chooseOffer(bot, offers, { params: tier(1), lapis: 3, power: 15, kind: 'pickaxe' }), { slot: 1 })
  assert.match(EN.chooseOffer(bot, offers, { params: tier(2), lapis: 3, power: 15, kind: 'pickaxe' }).wait, /saving up for the top offer \(level 30/)
  bot.experience = { level: 30 }
  assert.deepStrictEqual(EN.chooseOffer(bot, offers, { params: tier(2), lapis: 3, power: 15, kind: 'pickaxe' }), { slot: 2 })
  assert.match(EN.chooseOffer(bot, offers, { params: tier(2), lapis: 2, power: 15, kind: 'pickaxe' }).wait, /need 3 lapis/)
  // A master would rather have Fortune II than Efficiency... unless efficiency is higher: here IV beats II.
  const tricky = [{ level: 8, expected: { enchant: 2, level: 1 } }, { level: 25, expected: { enchant: 3, level: 3 } }, { level: 30, expected: { enchant: 4, level: 5 } }]
  assert.deepStrictEqual(EN.chooseOffer(bot, tricky, { params: tier(4), lapis: 3, power: 15, kind: 'pickaxe' }), { slot: 1 }) // Fortune III over Bane of Arthropods on a pickaxe
  bot.experience = { level: 5 }
  assert.match(EN.chooseOffer(bot, offers, { params: tier(1), lapis: 3, power: 15, kind: 'pickaxe' }).wait, /can't afford/)
})

test('what to enchant first: pickaxe, sword, chestplate; best material first; nothing twice', () => {
  const bot = fakeBot()
  const it = (name, enchants = []) => ({ name, count: 1, enchants })
  bot._items.push(it('iron_sword'), it('diamond_pickaxe', [{ name: 'efficiency', lvl: 3 }]), it('iron_pickaxe'), it('diamond_chestplate'), it('stone_shovel'), it('bread'))
  bot.inventory.slots = []
  assert.deepStrictEqual(EN.enchantCandidates(bot).map(i => i.name), ['iron_pickaxe', 'iron_sword', 'diamond_chestplate', 'stone_shovel'])
  assert.deepStrictEqual(EN.enchantCandidates(bot, { only: 'sword' }).map(i => i.name), ['iron_sword'])
})

test('books: each goes on the gear it suits; Mending first on the best gear; no conflicts or downgrades', () => {
  const bot = fakeBot()
  bot.inventory.slots = []
  const it = (name, enchants = []) => ({ name, count: 1, enchants })
  const pick = it('diamond_pickaxe', [{ name: 'silk_touch', lvl: 1 }])
  const sword = it('iron_sword', [{ name: 'sharpness', lvl: 4 }])
  const chest = it('diamond_chestplate')
  bot._items.push(pick, sword, chest,
    it('enchanted_book', [{ name: 'fortune', lvl: 3 }]), // conflicts with silk touch: skipped
    it('enchanted_book', [{ name: 'sharpness', lvl: 3 }]), // would be a downgrade: skipped
    it('enchanted_book', [{ name: 'protection', lvl: 4 }]),
    it('enchanted_book', [{ name: 'mending', lvl: 1 }]))
  const plan = EN.bookPlan(bot, { mending: true }).map(p => `${p.ench.name}->${p.item.name}`)
  assert.deepStrictEqual(plan, ['mending->diamond_pickaxe', 'protection->diamond_chestplate'])
  assert.ok(!EN.canTake(pick, { name: 'fortune', lvl: 3 }))
  assert.ok(EN.canTake(sword, { name: 'sharpness', lvl: 5 }))
})

test('skill: four enchanting tiers, anvil from tier 3', () => {
  const t = SKILLS.enchanting.tiers
  assert.strictEqual(t.length, 4)
  assert.ok(!t[0].params.waitForBest && t[1].params.waitForBest && t[2].params.anvil && t[3].params.mending && t[3].params.readOffers)
  assert.deepStrictEqual(require('../src/skills/registry').ACTION_SKILLS.anvil, { skill: 'enchanting', minTier: 3 })
})
