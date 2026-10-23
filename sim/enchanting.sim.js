'use strict'
// Simulated enchanting: a table ringed with bookshelves, a fake enchanting window and anvil, and
// the real enchant and anvil actions. Run with: npm run test:sim
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

function setup (tier, { shelves = 15 } = {}) {
  const bot = worldBot()
  bot.inventory.slots = []
  bot.entities = {}
  bot.equip = async (item, dest) => { if (dest === 'torso') bot.inventory.slots[6] = item; else bot.heldItem = item }
  bot.unequip = async () => {}
  bot.pathfinder.goto = async (g) => { if (g.kind === 'GoalNear') bot.entity.position = new Vec3(g.args[0] + 1.5, 64, g.args[2] + 0.5) }
  const T = new Vec3(10, 64, 0)
  bot.setBlock(T, 'enchanting_table')
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || n >= shelves) continue
    bot.setBlock(T.offset(dx, 0, dz), 'bookshelf'); n++
  }
  bot.experience = { level: 30, points: 0 }
  bot.registry.enchantments = { 1: { name: 'efficiency' }, 2: { name: 'unbreaking' }, 3: { name: 'fortune' } }
  const memory = new Memory(null)
  const skills = new SkillBook(memory, { bot: { skills: { startTiers: { enchanting: tier } } } })
  Z.invalidate()
  return { bot, memory, skills, T }
}

// An enchanting window whose offers depend on the number of shelves, like the real thing.
function fakeTable (bot, shelves) {
  bot.tableUses = []
  bot.openEnchantmentTable = async () => {
    const top = Math.min(30, 8 + Math.floor(shelves / 2) + shelves)
    const win = {
      target: null,
      lapis: null,
      enchantments: [{ level: Math.max(1, Math.round(top / 4)), expected: { enchant: 2, level: 1 } }, { level: Math.round(top * 0.66), expected: { enchant: 3, level: 2 } }, { level: top, expected: { enchant: 1, level: 4 } }],
      once (ev, fn) { if (ev === 'ready') setTimeout(fn, 5) },
      putTargetItem: async (it) => { win.target = it },
      putLapis: async (it) => { win.lapis = it },
      enchant: async (slot) => {
        const cost = win.enchantments[slot].level
        if (bot.experience.level < cost) throw new Error('not enough levels')
        bot.experience.level -= slot + 1
        for (let k = 0; k <= slot; k++) bot._use('lapis_lazuli')
        const name = bot.registry.enchantments[win.enchantments[slot].expected.enchant].name
        win.target.enchants = [{ name, lvl: win.enchantments[slot].expected.level }]
        bot.tableUses.push(slot)
        return win.target
      },
      takeTargetItem: async () => win.target,
      close () {}
    }
    return win
  }
}

async function act (env, name, args = {}) {
  const ex = new Executor(env.bot, actions, { memory: env.memory })
  env.skills.attach(ex)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, 20000)
  return out
}

test('enchant: an enchanter with 15 shelves and level 30 takes the top offer for the pickaxe first', async () => {
  const env = setup(2)
  const { bot } = env
  fakeTable(bot, 15)
  bot.give('iron_sword', 1); bot.give('diamond_pickaxe', 1); bot.give('lapis_lazuli', 5)
  const r = await act(env, 'enchant')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /enchanted diamond_pickaxe with efficiency 4 \(cost 3 levels\). Now level 27/)
  assert.deepStrictEqual(bot.tableUses, [2])
})

test('enchant: saving up — an enchanter at level 14 waits; a dabbler spends what it has', async () => {
  let env = setup(2)
  fakeTable(env.bot, 15)
  env.bot.experience.level = 14
  env.bot.give('diamond_pickaxe', 1); env.bot.give('lapis_lazuli', 5)
  let r = await act(env, 'enchant')
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /level 14 and this table's best offer costs about 30; I'll save up first/)
  env = setup(1)
  fakeTable(env.bot, 15)
  env.bot.experience.level = 14
  env.bot.give('diamond_pickaxe', 1); env.bot.give('lapis_lazuli', 5)
  r = await act(env, 'enchant')
  assert.ok(r.ok, r.text)
  assert.deepStrictEqual(env.bot.tableUses, [0]) // only the cheap offer was affordable (8 for slot 1, 20 for slot 2)
})

test('enchant: a weak table is reported, and no lapis means no enchanting', async () => {
  const env = setup(2, { shelves: 4 })
  fakeTable(env.bot, 4)
  env.bot.give('diamond_pickaxe', 1)
  let r = await act(env, 'enchant')
  assert.match(r.text, /needs lapis lazuli/)
  env.bot.give('lapis_lazuli', 3)
  r = await act(env, 'enchant')
  assert.ok(r.ok, r.text)
  assert.match(r.text, /The table has 4\/15 bookshelves/)
})

test('anvil: books on the right gear (Mending first), repairs with the right material', async () => {
  const env = setup(4)
  const { bot } = env
  bot.setBlock(new Vec3(-5, 64, 0), 'anvil')
  bot.give('diamond_pickaxe', 1); bot.give('iron_chestplate', 1)
  bot._items.push({ name: 'enchanted_book', count: 1, type: bot.registry.itemsByName.enchanted_book.id, enchants: [{ name: 'protection', lvl: 4 }] })
  bot._items.push({ name: 'enchanted_book', count: 1, type: bot.registry.itemsByName.enchanted_book.id, enchants: [{ name: 'mending', lvl: 1 }] })
  const combined = []
  bot.openAnvil = async () => ({
    combine: async (a, b) => {
      combined.push(`${a.name}+${b.name}`)
      if (b.name === 'enchanted_book') { a.enchants = [...(a.enchants || []), ...b.enchants]; bot._items.splice(bot._items.indexOf(b), 1) } else bot._use(b.name)
      bot.experience.level -= 2
    },
    rename: async (it, name) => { it.customName = name },
    close () {}
  })
  let r = await act(env, 'anvil', {})
  assert.ok(r.ok, r.text)
  assert.match(r.text, /put mending 1 on my diamond_pickaxe; put protection 4 on my iron_chestplate/)
  assert.deepStrictEqual(combined, ['diamond_pickaxe+enchanted_book', 'iron_chestplate+enchanted_book'])
  // A worn iron chestplate gets repaired with an iron ingot.
  bot.registry.items[bot.registry.itemsByName.iron_chestplate.id].maxDurability = 240
  bot._items.find(i => i.name === 'iron_chestplate').durabilityUsed = 235
  bot.give('iron_ingot', 2)
  r = await act(env, 'anvil', { job: 'repair' })
  assert.match(r.text, /repaired my iron_chestplate with iron_ingot/)
  r = await act(env, 'anvil', { job: 'rename', item: 'diamond_pickaxe', name: 'Old Faithful' })
  assert.match(r.text, /named my diamond_pickaxe "Old Faithful"/)
  const low = setup(2)
  low.bot.setBlock(new Vec3(-5, 64, 0), 'anvil')
  r = await act(low, 'anvil', {})
  assert.match(r.text, /haven't learned anvil yet/)
})
