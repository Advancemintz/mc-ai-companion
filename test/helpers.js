'use strict'

// A fake mineflayer bot with just enough surface for the brain, executor and
// perception to run without a Minecraft server.

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

function fakeBot (overrides = {}) {
  const bot = new EventEmitter()
  bot.username = 'Buddy'
  bot.version = '1.21.4'
  bot.health = 20
  bot.food = 20
  bot.game = { dimension: 'overworld' }
  bot.time = { timeOfDay: 3000 }
  bot.entity = { position: new Vec3(0, 64, 0), yaw: 0, height: 1.62 }
  bot.entities = {}
  bot.players = {}
  bot.heldItem = null
  bot.said = []
  bot.chat = (m) => bot.said.push(m)
  const items = []
  bot.inventory = {
    items: () => items,
    slots: [],
    emptySlotCount: () => 36 - items.length,
    count: (id) => items.filter(i => i.type === id).reduce((n, i) => n + i.count, 0)
  }
  bot._items = items
  bot.registry = { blocksByName: {}, itemsByName: {}, items: {}, foodsByName: {} }
  bot.findBlocks = () => []
  bot.findBlock = () => null
  bot.blockAt = () => null
  bot.nearestEntity = () => null
  bot.stopDigging = () => {}
  bot.clearControlStates = () => {}
  bot.pathfinder = { stop () {}, setGoal () {}, goal: null }
  bot.pvp = { forceStop () {}, target: null }
  bot.collectBlock = { cancelTask () {} }
  return Object.assign(bot, overrides)
}

// Scripted LLM: returns queued replies in order and records what it was sent.
function scriptedLLM (replies) {
  const calls = []
  return {
    name: 'scripted',
    model: 'test',
    calls,
    async complete (req) {
      calls.push(req)
      const next = replies.shift()
      if (next instanceof Error) throw next
      return typeof next === 'string' ? next : JSON.stringify(next ?? { say: '', actions: [] })
    }
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function until (fn, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await wait(10)
  }
  throw new Error('condition not met in time')
}

module.exports = { fakeBot, scriptedLLM, wait, until }
