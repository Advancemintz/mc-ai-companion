'use strict'

// The bot's "needs": computed in code every turn and shown to the LLM, so it has
// reasons to act on its own (like a Sims character). The LLM decides what to do
// about them; this file only notices them and ranks them.

const T = require('../body/terrain')

const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
const TIER_RANK = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

function bestTier (bot, suffix) {
  let best = 0
  for (const i of bot.inventory.items()) {
    if (!i.name.endsWith(suffix)) continue
    const tier = TIERS.find(t => i.name.startsWith(t + '_'))
    best = Math.max(best, TIER_RANK[tier] || 0)
  }
  return best
}

function foodSupply (bot) {
  const foods = bot.registry.foodsByName || {}
  return bot.inventory.items().reduce((n, i) => n + (foods[i.name] ? foods[i.name].foodPoints * i.count : 0), 0)
}

function hasItem (bot, re) {
  return bot.inventory.items().some(i => re.test(i.name))
}

// Returns a list of { level: 'urgent'|'soon'|'someday', text } sorted by importance.
function assessNeeds (bot, { memory, lastChatAt, skills } = {}) {
  const needs = []
  const add = (level, text) => needs.push({ level, text })
  const t = bot.time?.timeOfDay ?? 6000
  const where = T.cover(bot).kind
  const outside = where === 'outdoors' || where === 'under trees'
  const home = memory?.getPlace('home')
  const pos = bot.entity.position
  const homeDist = home ? Math.round(Math.hypot(home.x - pos.x, home.z - pos.z)) : null
  const hasBed = hasItem(bot, /_bed$/)

  // Safety
  if (bot.health <= 8) add('urgent', `health is low (${Math.round(bot.health)}/20): avoid fights, eat, stay safe`)
  const night = t >= 12500 && t < 23300
  if (t >= 11000 && t < 12500 && outside) {
    const mins = Math.max(1, Math.round((12500 - t) / 1200))
    if (home && homeDist > 12) add('urgent', `night falls in ~${mins} min: head home (${homeDist} blocks away) or sleep`)
    else if (!home) add('urgent', `night falls in ~${mins} min and you have no shelter: build a hut, or dig in`)
  } else if (night && outside) {
    add('soon', 'it is night and you are outside: monsters are spawning. Sleep in a bed, shelter, or stay alert')
  }
  if (night && hasBed && !bot.isSleeping) add('soon', 'you carry a bed: you could place it and sleep to skip the night')

  // Hunger
  const supply = foodSupply(bot)
  if (bot.food <= 12 && supply === 0) add('urgent', 'hungry and no food: hunt animals (cow, pig, sheep, chicken) or find food')
  else if (supply < 20) add('soon', 'food supply is low: hunt or gather food when convenient')

  // Tools & gear progression
  const pick = bestTier(bot, '_pickaxe')
  if (pick === 0) add('soon', 'no pickaxe: make a wooden_pickaxe (logs -> planks + sticks, crafting table)')
  else if (pick === 1) add('soon', 'only a wooden pickaxe: get cobblestone and make a stone_pickaxe')
  else if (pick === 2) add('someday', 'stone tools: find iron_ore, smelt it, and make an iron_pickaxe')
  else if (pick === 3 && !hasItem(bot, /^diamond/)) add('someday', 'iron tools: dig deep (y below 16, best around -58) to look for diamonds')
  if (bestTier(bot, '_sword') === 0 && bestTier(bot, '_axe') === 0) add('soon', 'no weapon: craft a sword')
  const wearing = [5, 6, 7, 8].filter(s => bot.inventory.slots[s]).length
  if (wearing === 0 && pick >= 3) add('someday', 'no armor: iron armor would keep you alive')
  if (!hasItem(bot, /^torch$/) && pick >= 2) add('someday', 'no torches: coal + sticks make torches for caves and night')

  // Habits: gear that's about to break, better gear you could make, raw food, sleep, loot.
  const SV = require('../body/survival')
  for (const w of SV.wornGear(bot).slice(0, 2)) add('soon', `your ${w.name} is nearly broken (${w.left} uses left): make a new one (upgrade_gear) before it breaks`)
  const gear = SV.gearPlan(bot)
  if (gear.length) add('someday', `you could craft better gear right now: ${gear.slice(0, 3).map(g => g.item).join(', ')} (upgrade_gear)`)
  const raw = SV.rawFood(bot)
  const rawN = Object.values(raw).reduce((a, b) => a + b, 0)
  if (rawN >= 3) add(SV.readyFood(bot) < 20 ? 'soon' : 'someday', `you have raw food (${Object.entries(raw).map(([k, v]) => `${v} ${k}`).join(', ')}): cook it, it fills you up far more`)
  if (memory?.data && bot.time?.age !== undefined) {
    const today = Math.floor(bot.time.age / 24000)
    const last = memory.data.lastSleptDay ?? memory.data.firstSeenDay ?? today
    if (memory.data.firstSeenDay === undefined) { memory.data.firstSeenDay = today; memory.save?.() }
    const nights = today - last
    if (nights >= 3) add(night ? 'urgent' : 'soon', `you haven't slept for ${nights} nights: phantoms will start swooping at you. Sleep in a bed tonight`)
  }
  if (home && homeDist !== null && homeDist <= 16 && SV.lootCount(bot) >= 48) add('soon', 'you are home with lots of loot in your pockets: put it away in your chests (deposit)')

  // Home & storage
  const canBase = !skills || skills.tier('building') >= 2
  if (!home) add('someday', canBase ? 'no home base yet: build one with build_base (surface house or underground), or a quick hut for now' : 'no home yet: build a hut (you are still learning to build; proper bases come later)')
  const unfinished = memory?.unfinishedProjects?.() || []
  if (unfinished.length) add('someday', `your ${unfinished[0].style} base "${unfinished[0].name}" is unfinished${unfinished[0].needs ? ` (needs ${unfinished[0].needs})` : ''}`)
  // Grow the base instead of starting over: suggest upgrades the bot knows but hasn't built.
  if (memory && !unfinished.length) {
    const H = require('../body/homes')
    const known = skills ? (skills.params('building')?.upgrades || []) : []
    for (const [name, p] of Object.entries(memory.data.projects || {})) {
      if (p.status !== 'done' || !H.UPGRADES || !(p.style === 'surface' || p.style === 'underground')) continue
      const open = H.availableUpgrades(p, known)
      if (open.length) { add('someday', `your base "${name}" could be improved with upgrade_base (${open.join(', ')}) instead of building a new one`); break }
    }
  }
  // Farming: a steady food supply; come back when crops have had time to grow.
  const farm = memory?.getProject?.('farm')
  const canFarm = !skills || skills.tier('farming') >= 1
  if (farm) {
    const mins = farm.lastRound ? (Date.now() - Date.parse(farm.lastRound)) / 60000 : Infinity
    if (mins > 25) add(supply < 20 ? 'soon' : 'someday', 'your farm has had time to grow: tend it with farm (harvest and replant)')
  } else if (canFarm && supply < 30 && hasItem(bot, /_hoe$|wheat_seeds/)) {
    add('someday', 'no farm yet: start one with farm for a steady food supply (needs a hoe and seeds)')
  }
  // Exploration: land around home nobody has looked at yet.
  const exp = skills ? skills.params('exploration') : null
  if (exp && home && memory?.exploredShare && t < 7000 && outside && bot.health >= 16) {
    const share = memory.exploredShare(home, exp.radius, home.dimension)
    if (share < 0.5) add('someday', `most of the land around home is unexplored (${Math.round(share * 100)}% mapped within ${exp.radius} blocks): explore in the daytime to find villages, caves and more`)
  }
  if (bot.inventory.emptySlotCount() <= 4) add('soon', `inventory almost full (${bot.inventory.emptySlotCount()} free slots): use clean_inventory or deposit`)

  // Social
  const company = Object.values(bot.players).filter(p => p.entity && p.username !== bot.username &&
    p.entity.position.distanceTo(pos) < 24).map(p => p.username)
  if (company.length && lastChatAt && Date.now() - lastChatAt > 10 * 60000) {
    add('someday', `nobody has talked for a while (${company.join(', ')} nearby)`)
  }

  const order = { urgent: 0, soon: 1, someday: 2 }
  return needs.sort((a, b) => order[a.level] - order[b.level]).slice(0, 5)
}

function describeNeeds (needs) {
  if (!needs.length) return 'Needs: nothing pressing - free to follow your goals or interests'
  return 'Needs: ' + needs.map(n => `[${n.level}] ${n.text}`).join('; ')
}

module.exports = { assessNeeds, describeNeeds, foodSupply, bestTier }
