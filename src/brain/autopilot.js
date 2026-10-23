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

function chooseActivity (bot, { memory, skills = null } = {}) {
  const t = bot.time?.timeOfDay ?? 6000
  const night = t >= 12500 && t < 23300
  const pos = bot.entity.position
  const home = memory?.getPlace('home')
  const cover = T.cover(bot).kind
  const outside = cover === 'outdoors' || cover === 'under trees'

  const SV = require('../body/survival')
  const homeDist = home ? Math.hypot(home.x - pos.x, home.z - pos.z) : Infinity
  const near = (names, r) => {
    const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
    return ids.length ? bot.findBlock({ matching: ids, maxDistance: r }) : null
  }
  // 0. Night at home: go to bed, like everyone else.
  if (night && homeDist <= 16) {
    const beds = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'))
    if (near(beds, 24) || bot.inventory.items().some(i => i.name.endsWith('_bed'))) return { plan: [{ name: 'sleep', args: {} }], why: 'it is night and home is right here, so it is bedtime' }
  }
  // 1. Night: get home / under cover.
  if (night && outside) {
    if (home && Math.hypot(home.x - pos.x, home.z - pos.z) > 6) return { plan: [{ name: 'go_to_place', args: { name: 'home' } }], why: 'it is night, heading home' }
    if (!home && countMatching(bot, BUILDING) >= 50) return { plan: [{ name: 'build', args: { structure: 'hut', size: 2 } }], why: 'it is night and there is no shelter' }
  }
  // 2. Full inventory.
  if (bot.inventory.emptySlotCount() <= 4) return { plan: [{ name: 'clean_inventory', args: {} }], why: 'inventory is nearly full' }
  // 2b. Back home with pockets full of loot: put it away.
  if (homeDist <= 16 && SV.lootCount(bot) >= 48 && near(['chest', 'barrel'], 16)) return { plan: [{ name: 'deposit', args: {} }], why: 'putting the loot away now that you are home' }
  // 2c. Raw food and somewhere to cook it.
  const raw = Object.values(SV.rawFood(bot)).reduce((a, b) => a + b, 0)
  const fuel = bot.inventory.items().some(i => /^(coal|charcoal)$|_planks$|_log$/.test(i.name))
  if (raw >= 4 && fuel && Date.now() - (bot._lastCookTry || 0) > 10 * 60000 && (near(['smoker', 'furnace'], 24) || bot.inventory.items().some(i => i.name === 'furnace' || i.name === 'smoker'))) {
    bot._lastCookTry = Date.now()
    return { plan: [{ name: 'cook', args: {} }], why: 'cooking the raw food you are carrying' }
  }
  // 2d. Better gear is one crafting session away (or something is about to break).
  if (Date.now() - (bot._lastGearTry || 0) > 10 * 60000 && (SV.wornGear(bot).length || SV.gearPlan(bot).some(g => /pickaxe|sword|chestplate/.test(g.item)))) {
    bot._lastGearTry = Date.now()
    return { plan: [{ name: 'upgrade_gear', args: {} }], why: 'sorting out your gear' }
  }
  // 2e. Levels saved up, lapis in pocket, a table at home: enchant something.
  const ench = skills?.params?.('enchanting')
  if (ench && bot.experience && homeDist <= 24 && bot.inventory.items().some(i => i.name === 'lapis_lazuli') && Date.now() - (bot._lastEnchantTry || 0) > 10 * 60000) {
    const EN = require('../body/enchanting')
    const table = near(['enchanting_table'], 32)
    if (table && EN.enchantCandidates(bot).length && bot.experience.level >= (ench.waitForBest ? EN.bestLevelFor(EN.bookshelfPower(bot, table.position)) : 5)) {
      bot._lastEnchantTry = Date.now()
      return { plan: [{ name: 'enchant', args: {} }], why: 'spending your saved-up levels at the enchanting table' }
    }
  }
  // 3. Unfinished base and enough material to make progress.
  const unfinished = memory?.unfinishedProjects?.() || []
  if (unfinished.length && countMatching(bot, BUILDING) >= 30) return { plan: [{ name: 'build_base', args: { name: unfinished[0].name } }], why: `continuing the unfinished base "${unfinished[0].name}"` }
  // 4. Food: tend the farm if it has had time to grow, otherwise hunt.
  const farm = memory?.getProject?.('farm')
  if (farm && !night && (!farm.lastRound || Date.now() - Date.parse(farm.lastRound) > 25 * 60000) && bot.inventory.items().some(i => i.name.endsWith('_hoe'))) {
    return { plan: [{ name: 'farm', args: {} }], why: 'the crops should be ready' }
  }
  // 4b. Animal pens due a round (and the food or tools to make it worthwhile).
  const HB = require('../body/husbandry')
  const farming = skills?.params?.('farming')
  const pens = HB.myPens(memory)
  if (pens.length && !night && (!skills || farming?.breed) && Date.now() - (bot._lastTendTry || 0) > 10 * 60000) {
    const { ANIMAL_FOOD } = require('../body/farming')
    const due = pens.filter(p => !p.lastRound || Date.now() - Date.parse(p.lastRound) > 20 * 60000)
    const useful = due.filter(p => (ANIMAL_FOOD[p.kind] || []).some(f => countMatching(bot, new RegExp(`^${f}$`)) >= 2) ||
      (p.kind === 'sheep' && countMatching(bot, /^shears$/)) || p.kind === 'chicken' || ((p.herd?.adults || 0) + (p.herd?.babies || 0) > (p.cap || 8)))
    if (useful.length) { bot._lastTendTry = Date.now(); return { plan: [{ name: 'tend_animals', args: {} }], why: `your ${useful[0].kind} pen is due a round` } }
  }
  if (foodSupply(bot) < 20) {
    const animal = bot.nearestEntity(e => FOOD_ANIMALS.has(e.name) && e.position.distanceTo(pos) < 24 && !HB.protectedReason({ bot, memory, social: null }, e))
    if (animal) return { plan: [{ name: 'attack', args: { target: animal.name, count: 2 } }], why: 'food is running low' }
  }
  // 5. Wood is always useful.
  const logs = countMatching(bot, /_log$/)
  if (logs < 8) {
    const ids = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped')).map(b => b.id)
    const tree = bot.findBlock({ matching: ids, maxDistance: 32 })
    if (tree) return { plan: [{ name: 'collect_block', args: { block: 'log', count: 6 } }], why: 'stocking up on wood' }
  }
  // 6. Morning: go and see what's out there.
  const exp = skills?.params?.('exploration')
  if (exp && home && t < 6000 && outside && bot.health >= 16 && foodSupply(bot) >= 10 &&
    memory.exploredShare && memory.exploredShare(home, exp.radius, home.dimension) < 0.6) {
    return { plan: [{ name: 'explore', args: {} }], why: 'exploring while the day is young' }
  }
  // 7. Company: wander over to the nearest player.
  const friend = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(pos) > 6 && e.position.distanceTo(pos) < 48)
  if (friend) return { plan: [{ name: 'go_to_player', args: { player: friend.username, distance: 4 } }], why: `hanging out near ${friend.username}` }
  // 8. Have a little look around.
  if (outside && !night) {
    const angle = Math.random() * Math.PI * 2
    const dist = 10 + Math.random() * 8
    return { plan: [{ name: 'go_to', args: { x: Math.round(pos.x + Math.cos(angle) * dist), z: Math.round(pos.z + Math.sin(angle) * dist), range: 3 } }], why: 'having a look around' }
  }
  return null
}

module.exports = { chooseActivity }
