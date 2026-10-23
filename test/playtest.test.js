'use strict'

// Fixes from the first real play session log (Minecraft 1.21.1): a reconnect left the old
// session thinking and acting next to the new one; attacking a player in creative went on
// forever; golden apples were refused when full; "acacia_planks" turned into oak.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { fakeBot, until } = require('./helpers')
const { Executor } = require('../src/body/executor')
const { Brain } = require('../src/brain/brain')
const { actions } = require('../src/body/actions')
const W = require('../src/body/world')

test('after a disconnect the old executor refuses work and the old brain stays silent', async () => {
  const bot = fakeBot()
  let ran = 0
  const ex = new Executor(bot, { wait: { run: async (ctx) => { ran++; await ctx.sleep(5000) } } })
  ex.setPlan([{ name: 'wait', args: {} }])
  await until(() => ran === 1, 1000)
  ex.shutdown()
  assert.deepStrictEqual(ex.setPlan([{ name: 'wait', args: {} }]), ['the bot is disconnected'])
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.strictEqual(ran, 1)
  assert.strictEqual(ex.current, null)

  const brain = Object.create(Brain.prototype)
  brain.events = []
  brain.timer = setTimeout(() => assert.fail('should have been cleared'), 50)
  brain.stop()
  brain.notify('[failed] attack FAILED: cow got away', true)
  assert.deepStrictEqual(brain.events, [])
  assert.strictEqual(brain.timer, null)
  await new Promise(resolve => setTimeout(resolve, 80))
})

test('players in creative or spectator mode are not worth attacking', async () => {
  const bot = fakeBot()
  const carson = { id: 7, type: 'player', username: 'ccccarson', position: new Vec3(2, 64, 0) }
  bot.players = { ccccarson: { username: 'ccccarson', gamemode: 1, entity: carson } }
  assert.strictEqual(W.playerInvulnerable(bot, 'CCCCarson'), 'creative')
  bot.players.ccccarson.gamemode = 0
  assert.strictEqual(W.playerInvulnerable(bot, 'ccccarson'), null)
  bot.players.ccccarson.gamemode = 3
  const ex = new Executor(bot, actions)
  let out = null
  ex.on('actionFailed', e => { out = e.error })
  ex.setPlan([{ name: 'attack', args: { target: 'ccccarson' } }])
  await until(() => out, 2000)
  assert.match(out, /ccccarson is in spectator mode and can't be hurt/)
})

test('golden apples can be eaten on a full stomach; ordinary food cannot', async () => {
  const bot = fakeBot()
  bot.registry.foodsByName = { enchanted_golden_apple: { foodPoints: 4 }, bread: { foodPoints: 5 } }
  bot._items.push({ name: 'enchanted_golden_apple', count: 3, type: 1 }, { name: 'bread', count: 2, type: 2 })
  bot.equip = async (it) => { bot.heldItem = it }
  bot.consume = async () => { bot.heldItem.count-- }
  const run = async (args) => {
    const ex = new Executor(bot, actions)
    let out = null
    ex.on('planFinished', e => { out = e.results[0] })
    ex.on('actionFailed', e => { out = e.error })
    ex.setPlan([{ name: 'eat', args }])
    await until(() => out, 2000)
    return out
  }
  assert.match(await run({ item: 'enchanted_golden_apple' }), /ate enchanted_golden_apple/)
  assert.strictEqual(bot._items[0].count, 2)
  assert.match(await run({ item: 'bread' }), /not hungry/)
})

test('asking for acacia planks with no logs keeps the acacia name', () => {
  const bot = fakeBot()
  bot.registry.itemsByName = { acacia_planks: { id: 1 }, oak_planks: { id: 2 }, birch_planks: { id: 3 } }
  assert.strictEqual(W.resolveCraftTarget(bot, 'acacia_planks'), 'acacia_planks')
  bot._items.push({ name: 'birch_log', count: 2 })
  assert.strictEqual(W.resolveCraftTarget(bot, 'acacia_planks'), 'birch_planks', 'with other logs it still uses what it has')
  assert.strictEqual(W.resolveCraftTarget(bot, 'planks'), 'birch_planks')
})
