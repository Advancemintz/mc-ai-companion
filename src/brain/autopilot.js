'use strict'

// When the LLM keeps choosing to do nothing (or can't be reached), the body picks a sensible
// everyday activity by itself, like a player who doesn't just stand still.
// Returns { plan: [...actions], why } or null.

const T = require('../body/terrain')
const { foodSupply } = require('./drives')

const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const BUILDING = /^(cobblestone|cobbled_deepslate|stone|dirt|.*_planks|stone_bricks|bricks)$/

function countMatching (bot, re) {
  return bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
}

function chooseActivity (bot, { memory } = {}) {
  const t = bot.time?.timeOfDay ?? 6000
  const night = t >= 12500 && t < 23300
  const pos = bot.entity.position
  const home = memory?.getPlace('home')
  const cover = T.cover(bot).kind
  const outside = cover === 'outdoors' || cover === 'under trees'

  // 1. Night: get home / under cover.
  if (night && outside) {
    if (home && Math.hypot(home.x - pos.x, home.z - pos.z) > 6) return { plan: [{ name: 'go_to_place', args: { name: 'home' } }], why: 'it is night, heading home' }
    if (!home && countMatching(bot, BUILDING) >= 50) return { plan: [{ name: 'build', args: { structure: 'hut', size: 2 } }], why: 'it is night and there is no shelter' }
  }
  // 2. Full inventory.
  if (bot.inventory.emptySlotCount() <= 4) return { plan: [{ name: 'clean_inventory', args: {} }], why: 'inventory is nearly full' }
  // 3. Unfinished base and enough material to make progress.
  const unfinished = memory?.unfinishedProjects?.() || []
  if (unfinished.length && countMatching(bot, BUILDING) >= 30) return { plan: [{ name: 'build_base', args: { name: unfinished[0].name } }], why: `continuing the unfinished base "${unfinished[0].name}"` }
  // 4. Food.
  if (foodSupply(bot) < 20) {
    const animal = bot.nearestEntity(e => FOOD_ANIMALS.has(e.name) && e.position.distanceTo(pos) < 24)
    if (animal) return { plan: [{ name: 'attack', args: { target: animal.name, count: 2 } }], why: 'food is running low' }
  }
  // 5. Wood is always useful.
  const logs = countMatching(bot, /_log$/)
  if (logs < 8) {
    const ids = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped')).map(b => b.id)
    const tree = bot.findBlock({ matching: ids, maxDistance: 32 })
    if (tree) return { plan: [{ name: 'collect_block', args: { block: 'log', count: 6 } }], why: 'stocking up on wood' }
  }
  // 6. Company: wander over to the nearest player.
  const friend = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(pos) > 6 && e.position.distanceTo(pos) < 48)
  if (friend) return { plan: [{ name: 'go_to_player', args: { player: friend.username, distance: 4 } }], why: `hanging out near ${friend.username}` }
  // 7. Have a little look around.
  if (outside && !night) {
    const angle = Math.random() * Math.PI * 2
    const dist = 10 + Math.random() * 8
    return { plan: [{ name: 'go_to', args: { x: Math.round(pos.x + Math.cos(angle) * dist), z: Math.round(pos.z + Math.sin(angle) * dist), range: 3 } }], why: 'having a look around' }
  }
  return null
}

module.exports = { chooseActivity }
