'use strict'

// Helpers for reading the world: name resolution, mob classification, inventory lookups.
// LLMs say "wood", "iron", "planks", "cobble"... these helpers map that to real IDs.

const { Vec3 } = require('vec3')

const HOSTILE_MOBS = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute',
  'guardian', 'elder_guardian', 'silverfish', 'endermite', 'shulker', 'warden', 'breeze', 'creaking'
])

// Neutral mobs: only fight them if they are actually attacking.
const NEUTRAL_MOBS = new Set([
  'enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem', 'llama', 'polar_bear',
  'panda', 'dolphin', 'goat', 'trader_llama'
])

// Mobs that self-defense should never auto-attack (too dangerous or pointless).
const NEVER_AUTO_ATTACK = new Set(['warden', 'ender_dragon', 'wither', 'elder_guardian', 'ghast'])

// What the player probably means -> blocks that drop it.
const DROP_SOURCES = {
  cobblestone: ['stone', 'cobblestone'],
  cobbled_deepslate: ['deepslate', 'cobbled_deepslate'],
  dirt: ['dirt', 'grass_block', 'coarse_dirt'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  flint: ['gravel'],
  clay_ball: ['clay'],
  sugar_cane: ['sugar_cane'],
  wheat_seeds: ['short_grass', 'tall_grass', 'grass']
}

const WORD_ALIASES = {
  wood: 'log',
  logs: 'log',
  cobble: 'cobblestone',
  plank: 'planks',
  iron: 'iron_ore',
  gold: 'gold_ore',
  copper: 'copper_ore',
  diamonds: 'diamond',
  stones: 'stone',
  rock: 'stone'
}

function clean (name) {
  let n = String(name || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')
  if (WORD_ALIASES[n]) n = WORD_ALIASES[n]
  return n
}

function singular (n) {
  if (n.endsWith('ies')) return n.slice(0, -3) + 'y'
  if (n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1)
  return n
}

// Returns block names (strings) that match what the user asked to mine/collect.
function resolveBlockNames (registry, query) {
  const q = clean(query)
  const byName = registry.blocksByName
  // Planks only exist in the world as parts of builds; never dismantle those. Craft them from logs.
  if (/plank/.test(q)) return []
  const candidates = [q, singular(q)]
  const out = new Set()

  for (const c of candidates) {
    if (DROP_SOURCES[c]) DROP_SOURCES[c].forEach(n => byName[n] && out.add(n))
    if (byName[c]) {
      out.add(c)
      if (c.endsWith('_ore') && byName['deepslate_' + c]) out.add('deepslate_' + c)
    }
  }
  if (out.size) return [...out]

  const q2 = singular(q)
  if (q2 === 'log') return Object.keys(byName).filter(n => n.endsWith('_log') && !n.startsWith('stripped_'))
  if (q2 === 'leave' || q2 === 'leaves') return Object.keys(byName).filter(n => n.endsWith('_leaves'))

  // "oak" -> oak_log, "iron" handled above, otherwise suffix/prefix matches.
  const suffix = Object.keys(byName).filter(n => n.endsWith('_' + q2) || n.startsWith(q2 + '_log'))
  if (suffix.length && suffix.length <= 12) return suffix
  const contains = Object.keys(byName).filter(n => n.includes(q2))
  if (contains.length && contains.length <= 8) return contains
  return []
}

// Returns the best matching item name, preferring things the bot already has.
function resolveItemName (bot, query) {
  const q = clean(query)
  const byName = bot.registry.itemsByName
  for (const c of [q, singular(q)]) if (byName[c]) return c

  const have = bot.inventory.items().map(i => i.name)
  const s = singular(q)
  const matchHave = have.find(n => n === s || n.endsWith('_' + s) || n.includes(s))
  if (matchHave) return matchHave

  if (s === 'planks' || s === 'plank') return 'oak_planks'
  if (s === 'log') return 'oak_log'
  const suffix = Object.keys(byName).filter(n => n.endsWith('_' + s))
  if (suffix.length) return suffix.sort((a, b) => a.length - b.length)[0]
  const contains = Object.keys(byName).filter(n => n.includes(s))
  if (contains.length) return contains.sort((a, b) => a.length - b.length)[0]
  return null
}

// For crafting: "planks" should mean whichever planks we can make from the logs we hold.
function resolveCraftTarget (bot, query) {
  const q = singular(clean(query))
  // "oak_planks" while holding only birch logs -> make birch planks instead.
  const full = clean(query)
  const askedPlanks = full.endsWith('_planks') && bot.registry.itemsByName[full]
  const haveMatchingLog = askedPlanks && bot.inventory.items().some(i => i.name.replace(/^stripped_/, '').replace(/_(log|stem|wood|hyphae)$/, '_planks') === full)
  if (q === 'planks' || q === 'plank' || q === 'wood_plank' || (askedPlanks && !haveMatchingLog)) {
    const log = bot.inventory.items().find(i => i.name.endsWith('_log') || i.name.endsWith('_stem'))
    if (log) {
      const base = log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '')
      if (bot.registry.itemsByName[base + '_planks']) return base + '_planks'
    }
    return 'oak_planks'
  }
  if (q === 'stick') return 'stick'
  return resolveItemName(bot, query)
}

function findInventoryItem (bot, query) {
  const q = clean(query)
  const items = bot.inventory.items()
  return items.find(i => i.name === q) ||
    items.find(i => i.name === singular(q)) ||
    items.find(i => i.name.endsWith('_' + singular(q))) ||
    items.find(i => i.name.includes(singular(q))) ||
    null
}

function countItem (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// Living creatures (as opposed to arrows, items, boats, item frames...).
const LIVING_TYPES = new Set(['hostile', 'passive', 'animal', 'water_creature', 'ambient', 'mob', 'living'])
function isMob (entity) {
  if (!entity || entity.type === 'player') return false
  return LIVING_TYPES.has(entity.type) || HOSTILE_MOBS.has(entity.name) || NEUTRAL_MOBS.has(entity.name)
}

function isHostile (entity) {
  if (!entity || entity.type === 'player') return false
  const name = entity.name || ''
  if (HOSTILE_MOBS.has(name)) return true
  return entity.type === 'hostile' && !NEUTRAL_MOBS.has(name)
}

function entityLabel (entity) {
  if (!entity) return 'unknown'
  if (entity.type === 'player') return entity.username
  return entity.name || entity.displayName || 'entity'
}

function nearestHostile (bot, maxDistance, filter = () => true) {
  return bot.nearestEntity(e =>
    isHostile(e) &&
    e.position.distanceTo(bot.entity.position) <= maxDistance &&
    Math.abs(e.position.y - bot.entity.position.y) < 5 &&
    filter(e)
  )
}

function playerEntity (bot, username) {
  if (!username) return null
  const exact = bot.players[username]
  if (exact?.entity) return exact.entity
  const lower = username.toLowerCase()
  const match = Object.values(bot.players).find(p => p.username.toLowerCase() === lower)
  return match?.entity || null
}

// Best melee weapon in inventory.
function bestWeapon (bot) {
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  const score = (name) => {
    let s = 0
    if (name.endsWith('_sword')) s += 100
    else if (name.endsWith('_axe')) s += 80
    else if (name === 'mace' || name === 'trident') s += 95
    else return -1
    const tier = order.findIndex(t => name.startsWith(t + '_'))
    return s + (tier === -1 ? 0 : (order.length - tier) * 3)
  }
  return bot.inventory.items()
    .filter(i => score(i.name) >= 0)
    .sort((a, b) => score(b.name) - score(a.name))[0] || null
}

// Blocks you can see through (for line-of-sight checks: aiming, and "is anyone watching?").
const SEE_THROUGH = /^(air|cave_air|void_air|water|glass|.*_glass|.*_glass_pane|glass_pane|.*_leaves|iron_bars|.*_fence|.*_fence_gate|ladder|vine|torch|wall_torch|.*_torch|short_grass|tall_grass|fern|.*_carpet|.*_sign|.*_wall_sign|.*_button|lever|rail|.*_rail|.*_door|.*_trapdoor|snow|flower_pot|.*_slab|cobweb|scaffolding|chain|lantern|soul_lantern)$/

// Can something at `from` see the point `to`? Walks the line in small steps and stops at the
// first block you can't see through. Unloaded blocks count as clear (we can't know better).
function lineOfSight (bot, from, to, step = 0.3) {
  const dx = to.x - from.x; const dy = to.y - from.y; const dz = to.z - from.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 0.5) return true
  const n = Math.ceil(len / step)
  // The blocks you look from and at don't hide themselves (a chest, a mob's feet).
  const endKey = `${Math.floor(to.x)},${Math.floor(to.y)},${Math.floor(to.z)}`
  const startKey = `${Math.floor(from.x)},${Math.floor(from.y)},${Math.floor(from.z)}`
  let lastKey = ''
  for (let i = 1; i < n; i++) {
    const t = i / n
    const p = { x: Math.floor(from.x + dx * t), y: Math.floor(from.y + dy * t), z: Math.floor(from.z + dz * t) }
    const key = `${p.x},${p.y},${p.z}`
    if (key === lastKey || key === endKey || key === startKey) continue
    lastKey = key
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!b) continue
    if (b.boundingBox === 'block' && !SEE_THROUGH.test(b.name)) return false
  }
  return true
}

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])

function bestFood (bot, { allowBad = false } = {}) {
  const foods = bot.registry.foodsByName || {}
  const options = bot.inventory.items().filter(i => foods[i.name] && (allowBad || !BAD_FOOD.has(i.name)))
  options.sort((a, b) => (foods[b.name].foodPoints + foods[b.name].saturation) - (foods[a.name].foodPoints + foods[a.name].saturation))
  return options[0] || null
}

module.exports = {
  HOSTILE_MOBS,
  NEUTRAL_MOBS,
  NEVER_AUTO_ATTACK,
  clean,
  resolveBlockNames,
  resolveItemName,
  resolveCraftTarget,
  findInventoryItem,
  countItem,
  isHostile,
  isMob,
  entityLabel,
  nearestHostile,
  playerEntity,
  bestWeapon,
  bestFood,
  lineOfSight
}
