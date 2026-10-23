'use strict'

// The bot's "body": every action the LLM can choose, written as plain code.
// Each action: { description, params, persistent?, timeoutSeconds?, run(ctx, args) -> string }
// - run() returns a short result string the brain reads ("collected 5 oak_log").
// - Throw an Error with a helpful message when something fails; the brain will re-plan.
// - Long waits go through ctx.race()/ctx.sleep() so stop/replace cancels them instantly.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const T = require('./terrain')
const { CancelledError } = require('./executor')
const { goto, placeAt, SOLID, REPLACEABLE } = require('./motion')
const B = require('./builder')
const PL = require('./placement')
const H = require('./homes')
const Z = require('./zones')

// ------------------------------------------------------------------ shared helpers

function num (v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clamp (v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function fmtPos (p) {
  return `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`
}

function findNearestBlock (bot, names, maxDistance = 32) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  if (!ids.length) return null
  return bot.findBlock({ matching: ids, maxDistance })
}

// Does this block touch air (visible from a cave, cliff or the surface)?
function exposed (bot, p) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(p.offset(...d))
    if (b && (b.name === 'air' || b.name === 'cave_air')) return true
  }
  return false
}

function itemNames (bot, ids) {
  return ids.map(id => bot.registry.items[id]?.name).filter(Boolean)
}

// Walk over and pick up dropped items near the bot.
async function pickupNearbyItems (ctx, radius = 6) {
  const { bot } = ctx
  for (let i = 0; i < 8; i++) {
    const drop = bot.nearestEntity(e => (e.name === 'item' || e.displayName === 'Item') &&
      e.position.distanceTo(bot.entity.position) <= radius)
    if (!drop) return
    try {
      await goto(ctx, new goals.GoalFollow(drop, 0), 5000)
      await ctx.sleep(250)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      return
    }
  }
}

// Place an item on a free spot right next to the bot. Returns the placed block.
async function placeNextToBot (ctx, itemName) {
  const { bot } = ctx
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) throw new Error(`I don't have a ${itemName}`)
  const base = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of offsets) {
      const pos = base.offset(dx, dy, dz)
      const target = bot.blockAt(pos)
      const below = bot.blockAt(pos.offset(0, -1, 0))
      const above = bot.blockAt(pos.offset(0, 1, 0))
      if (!target || !REPLACEABLE.has(target.name) || target.name === 'water' || target.name === 'lava') continue
      if (!SOLID(below) || !above || SOLID(above)) continue
      try {
        await bot.equip(item, 'hand')
        await ctx.race(bot.placeBlock(below, new Vec3(0, 1, 0)), 6000)
      } catch (err) {
        if (err instanceof CancelledError) throw err
      }
      const placed = bot.blockAt(pos)
      if (placed && placed.name === itemName) return placed
    }
  }
  throw new Error(`couldn't find a free spot to place the ${itemName}`)
}

// Put a utility block (crafting table, furnace, chest...) somewhere sensible:
// against a wall, out of walkways, chests joined into double chests. Falls back to "next to me".
async function placeUtilityBlock (ctx, itemName) {
  const placed = await PL.placeUtility(ctx, itemName, { memory: ctx.memory })
  return placed || placeNextToBot(ctx, itemName)
}

// Out in the wild, a table or furnace placed just for one job is picked back up afterwards,
// like a tidy player would. Inside a base it stays.
function isTemporarySpot (ctx, pos) {
  return !Z.zoneAt(ctx.memory, pos)
}

async function pickBackUp (ctx, block) {
  const { bot } = ctx
  const b = bot.blockAt(block.position)
  if (!b || b.name !== block.name) return false
  if (b.name === 'furnace' && !bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) return false
  try {
    await goto(ctx, new goals.GoalLookAtBlock(b.position, bot.world), 20000)
    if (bot.tool?.equipForBlock) { try { await bot.tool.equipForBlock(b, {}) } catch {} }
    await ctx.race(bot.dig(b, true), 10000)
    await ctx.sleep(300)
    await pickupNearbyItems(ctx, 4)
    return true
  } catch (err) {
    if (err instanceof CancelledError) throw err
    return false
  }
}

async function ensureCraftingTable (ctx) {
  const { bot } = ctx
  const near = findNearestBlock(bot, ['crafting_table'], 32)
  if (near) return { block: near, temporary: false }
  if (!bot.inventory.items().find(i => i.name === 'crafting_table')) {
    const tableId = bot.registry.itemsByName.crafting_table.id
    const recipe = bot.recipesFor(tableId, null, 1, null)[0]
    if (!recipe) throw new Error('I need a crafting table, and I need 4 planks to make one')
    await ctx.race(bot.craft(recipe, 1, null), 15000)
  }
  const block = await placeUtilityBlock(ctx, 'crafting_table')
  return { block, temporary: isTemporarySpot(ctx, block.position) }
}

function describeMissing (bot, recipes, count) {
  let best = null
  for (const r of recipes) {
    const times = Math.ceil(count / r.result.count)
    const missing = []
    let total = 0
    for (const d of r.delta) {
      if (d.count >= 0) continue
      const need = -d.count * times - bot.inventory.count(d.id, null)
      if (need > 0) {
        missing.push(`${need} ${bot.registry.items[d.id]?.name}`)
        total += need
      }
    }
    if (!best || total < best.total) best = { total, missing }
  }
  return best?.missing.join(', ') || 'unknown ingredients'
}

const FUEL_VALUE = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20 }
function fuelValue (name) {
  if (FUEL_VALUE[name]) return FUEL_VALUE[name]
  if (name.endsWith('_planks') || name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem')) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

// What "build" places, relative to the bot: [right, up, forward] offsets.
function structureOffsets (structure, { length, width, height, size, variant }) {
  const out = []
  const s = String(structure || '').toLowerCase()
  if (['wall', 'fence_wall'].includes(s)) {
    const L = clamp(num(length, 5), 1, 32); const H = clamp(num(height, 3), 1, 8)
    for (let h = 0; h < H; h++) for (let i = 0; i < L; i++) out.push([i - Math.floor(L / 2), h, 0])
  } else if (['tower', 'pillar', 'column'].includes(s)) {
    const H = clamp(num(height, 5), 1, 12)
    for (let h = 0; h < H; h++) out.push([0, h, 0])
  } else if (['platform', 'floor', 'bridge'].includes(s)) {
    const L = clamp(num(length, 5), 1, 24); const Wd = clamp(num(width, 5), 1, 16)
    const up = s === 'platform' ? 0 : -1 // floor/bridge fills at ground level (holes, water)
    for (let f = 0; f < L; f++) for (let r = 0; r < Wd; r++) out.push([r - Math.floor(Wd / 2), up, f])
  } else if (['hut', 'house', 'shelter', 'cabin'].includes(s) && variant === 'peaked') {
    // Peaked hut: low walls and a pitched roof running front to back.
    const S = clamp(num(size ?? width ?? length, 3), 2, 7)
    const H = 2
    const half = Math.floor((S + 2) / 2)
    const r0 = -half; const r1 = -half + S + 1
    for (let f = 0; f < S + 2; f++) {
      for (let r = r0; r <= r1; r++) {
        const edgeR = r === r0 || r === r1
        const edgeF = f === 0 || f === S + 1
        const k = Math.min(r - r0, r1 - r)
        for (let h = 0; h < H; h++) {
          if (!(edgeR || edgeF)) continue
          if (f === 0 && r === 0 && h < 2) continue // doorway
          out.push([r, h, f])
        }
        out.push([r, H + k, f]) // roof
        if (edgeF) for (let h = H; h < H + k; h++) if (!(f === 0 && r === 0 && h < 2)) out.push([r, h, f]) // gable ends
      }
    }
  } else if (['hut', 'house', 'shelter', 'cabin'].includes(s)) {
    const S = clamp(num(size ?? width ?? length, 3), 2, 7) // interior size
    const H = clamp(num(height, 3), 2, 5)
    const half = Math.floor((S + 2) / 2)
    for (let h = 0; h < H; h++) {
      for (let f = 0; f < S + 2; f++) {
        for (let r = -half; r < -half + S + 2; r++) {
          const edge = f === 0 || f === S + 1 || r === -half || r === -half + S + 1
          if (!edge) continue
          if (f === 0 && r === 0 && h < 2) continue // doorway
          out.push([r, h, f])
        }
      }
    }
    for (let f = 0; f < S + 2; f++) for (let r = -half; r < -half + S + 2; r++) out.push([r, H, f]) // roof
  } else {
    return null
  }
  return out
}

const BUILD_MATERIAL_PREFERENCE = ['cobblestone', 'cobbled_deepslate', 'stone', 'oak_planks', 'spruce_planks',
  'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'pale_oak_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks', 'stone_bricks', 'bricks', 'sandstone',
  'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'dirt', 'coarse_dirt']

// Returns { list: material names in the order to use them, total: how many blocks that is }.
function pickBuildMaterials (bot, needed, preferred) {
  const counts = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
  if (preferred) {
    const it = W.findInventoryItem(bot, preferred)
    if (!it) throw new Error(`I don't have any ${preferred}`)
    return { list: [it.name], total: counts[it.name] }
  }
  const usable = BUILD_MATERIAL_PREFERENCE.filter(n => counts[n])
  const single = usable.find(n => counts[n] >= needed)
  // Prefer one material for looks; otherwise use the biggest stacks first.
  const list = single ? [single, ...usable.filter(n => n !== single)] : usable.sort((a, b) => counts[b] - counts[a])
  return { list, total: list.reduce((n, m) => n + counts[m], 0) }
}

function facingName (v) {
  if (v.x > 0) return 'east'
  if (v.x < 0) return 'west'
  if (v.z > 0) return 'south'
  return 'north'
}

// Dig out a block that is in the way of a build (leaves, dirt bumps, stone...).
async function clearBlock (ctx, pos) {
  const { bot } = ctx
  const b = bot.blockAt(pos)
  if (!b || b.name === 'air' || b.name === 'cave_air' || T.isLiquid(b)) return
  if (!T.canClear(b)) throw new Error(`a ${b.name} is in the way`)
  await goto(ctx, new goals.GoalLookAtBlock(pos, bot.world), 30000)
  if (bot.tool?.equipForBlock) {
    try { await bot.tool.equipForBlock(b, {}) } catch {}
  }
  await ctx.race(bot.dig(b, true), 15000)
}

function facingVectors (bot) {
  const yaw = bot.entity.yaw
  const fx = -Math.sin(yaw); const fz = -Math.cos(yaw)
  const f = Math.abs(fx) > Math.abs(fz) ? new Vec3(Math.sign(fx), 0, 0) : new Vec3(0, 0, Math.sign(fz))
  const r = new Vec3(-f.z, 0, f.x)
  return { f, r }
}

// ------------------------------------------------------------------ the action catalog

const actions = {}

actions.stop = {
  description: 'Stop everything you are doing and stand still.',
  params: {},
  run: async () => 'stopped'
}

actions.follow_player = {
  description: 'Keep following a player until told otherwise.',
  params: { player: 'player name', distance: 'how close to stay (default 3)' },
  persistent: true,
  run: async (ctx, { player, distance }) => {
    const { bot } = ctx
    let target = W.playerEntity(bot, player)
    if (!target) throw new Error(`I can't see ${player} (too far away or offline)`)
    const dist = clamp(num(distance, 3), 1, 12)
    bot.pathfinder.setGoal(new goals.GoalFollow(target, dist), true)
    ctx.setStatus(`following ${target.username}`)
    let lost = 0
    for (;;) {
      await ctx.sleep(1000)
      const e = W.playerEntity(bot, player)
      if (!e) {
        if (++lost > 20) throw new Error(`lost track of ${player}`)
        continue
      }
      lost = 0
      if (e !== target || !bot.pathfinder.goal) {
        target = e
        bot.pathfinder.setGoal(new goals.GoalFollow(target, dist), true)
      }
    }
  }
}

actions.go_to_player = {
  description: 'Walk to a player once.',
  params: { player: 'player name', distance: 'stop this close (default 2)' },
  run: async (ctx, { player, distance }) => {
    const target = W.playerEntity(ctx.bot, player)
    if (!target) throw new Error(`I can't see ${player} (too far away or offline)`)
    const p = target.position
    await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, clamp(num(distance, 2), 1, 10)))
    return `reached ${target.username}`
  }
}

actions.go_to = {
  description: 'Walk to coordinates. y is optional.',
  params: { x: 'number', y: 'number (optional)', z: 'number', range: 'how close is close enough (default 1)' },
  run: async (ctx, { x, y, z, range }) => {
    x = num(x); y = num(y, null); z = num(z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('go_to needs numeric x and z')
    const r = clamp(num(range, 1), 0, 20)
    const goal = y === null ? new goals.GoalNearXZ(x, z, Math.max(r, 1)) : new goals.GoalNear(x, y, z, r)
    await goto(ctx, goal, 240000)
    return `arrived at ${fmtPos(ctx.bot.entity.position)}`
  },
  timeoutSeconds: 300
}

actions.collect_block = {
  description: 'Find and harvest blocks you can see nearby, picking up the drops: logs ("log" = any), sand, dirt, gravel, clay, and stone or ores that are exposed on the surface or in caves. Never takes blocks from bases. For buried ores use mine instead.',
  params: { block: 'block name', count: 'how many (default 1)' },
  timeoutSeconds: 600,
  run: async (ctx, { block, count }) => {
    const { bot } = ctx
    const names = W.resolveBlockNames(bot.registry, block)
    if (!names.length) throw new Error(`"${block}" isn't a block I know how to mine (planks/tools must be crafted)`)
    const ids = names.map(n => bot.registry.blocksByName[n].id)
    const wanted = clamp(Math.round(num(count, 1)), 1, 256)
    const skip = new Set()
    let mined = 0
    let failures = 0
    const undergroundMaterial = names.some(n => /_ore$|^(stone|deepslate|tuff|andesite|diorite|granite|ancient_debris)$/.test(n))

    while (mined < wanted) {
      ctx.check()
      const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 80 })
        .filter(p => !skip.has(p.toString()) && !Z.zoneAt(ctx.memory, p)) // never harvest a base
      // Ores and stone: only take ones you can see (touching air), so the bot doesn't
      // tunnel random holes everywhere. Hidden ones are for the mine action.
      const usable = undergroundMaterial ? positions.filter(p => exposed(bot, p)) : positions
      const pos = usable[0]
      if (!pos) {
        if (mined) return `collected ${mined}/${wanted} ${block}; no more within reach`
        if (undergroundMaterial && positions.length) throw new Error(`no exposed ${block} nearby (the ones I can sense are buried). Use the mine action to dig a proper mine for it`)
        throw new Error(`no ${block} found within 64 blocks` + (undergroundMaterial ? ' (try the mine action)' : ''))
      }
      const target = bot.blockAt(pos)
      if (target?.harvestTools) {
        const toolIds = Object.keys(target.harvestTools).map(Number)
        if (!bot.inventory.items().some(i => toolIds.includes(i.type))) {
          const options = itemNames(bot, toolIds).filter(n => !n.startsWith('golden')).slice(0, 3)
          throw new Error(`I need a tool to mine ${target.name}: ${options.join(' or ')}` + (mined ? ` (collected ${mined} so far)` : ''))
        }
      }
      try {
        await ctx.race(bot.collectBlock.collect(target, { ignoreNoPath: true }), 60000)
        mined++
        if (undergroundMaterial) ctx.skills?.award('mining', /_ore$/.test(target.name) ? 2 : 0.3)
        failures = 0
        ctx.setStatus(`${mined}/${wanted}`)
        ctx.resumeArgs = { block, count: wanted - mined }
      } catch (err) {
        if (err instanceof CancelledError) throw err
        skip.add(pos.toString())
        if (++failures >= 5) {
          throw new Error(`kept failing to reach ${block} (${err.message})` + (mined ? `; collected ${mined} first` : ''))
        }
      }
      if (bot.inventory.emptySlotCount() === 0) return `inventory full after collecting ${mined} ${block}`
    }
    return `collected ${mined} ${block}`
  }
}

actions.attack = {
  description: 'Fight and kill a mob or player. target can be a mob type (zombie, cow, skeleton), "hostile" for the nearest monster, or a player name. count = how many to kill.',
  params: { target: 'mob type, "hostile", or player name', count: 'how many (default 1)' },
  timeoutSeconds: 240,
  run: async (ctx, { target, count }) => {
    const { bot } = ctx
    const wanted = clamp(Math.round(num(count, 1)), 1, 20)
    const q = W.clean(target || 'hostile')
    let killed = 0
    for (let i = 0; i < wanted; i++) {
      ctx.check()
      let entity = null
      const player = W.playerEntity(bot, target)
      if (player) entity = player
      else if (['hostile', 'monster', 'monsters', 'mob', 'mobs', 'nearest', 'enemy'].includes(q)) {
        entity = W.nearestHostile(bot, 32)
      } else {
        const name = q.endsWith('s') && !bot.registry.entitiesByName?.[q] ? q.slice(0, -1) : q
        entity = bot.nearestEntity(e => e.name === name && e.position.distanceTo(bot.entity.position) < 32)
      }
      if (!entity) {
        if (killed) return `killed ${killed} ${target}; no more nearby`
        throw new Error(`no ${target} within 32 blocks`)
      }
      const weapon = W.bestWeapon(bot)
      if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand')
      await bot.pvp.attack(entity)
      ctx.setStatus(`fighting ${W.entityLabel(entity)}`)
      const started = Date.now()
      while (entity.isValid && bot.pvp.target === entity && Date.now() - started < 60000) {
        await ctx.sleep(250)
      }
      const dead = !entity.isValid
      try { bot.pvp.forceStop ? bot.pvp.forceStop() : await bot.pvp.stop() } catch {}
      if (!dead) {
        if (killed) return `killed ${killed} ${target}, then the next one got away`
        throw new Error(`${W.entityLabel(entity)} got away`)
      }
      killed++
      ctx.skills?.award('combat', W.isHostile(entity) ? 8 : entity.type === 'player' ? 10 : 2, `killed a ${W.entityLabel(entity)}`)
      ctx.resumeArgs = { target, count: wanted - killed }
      await pickupNearbyItems(ctx, 5)
    }
    return `killed ${killed} ${target}`
  }
}

actions.guard = {
  description: 'Stay here (or next to a player) and kill any monsters that come close, until told otherwise.',
  params: { player: 'optional player to protect', radius: 'default 10' },
  persistent: true,
  run: async (ctx, { player, radius }) => {
    const { bot } = ctx
    const r = clamp(num(radius, 10), 3, 24)
    const home = bot.entity.position.clone()
    ctx.setStatus(player ? `guarding ${player}` : `guarding ${fmtPos(home)}`)
    for (;;) {
      ctx.check()
      const protectee = player ? W.playerEntity(bot, player) : null
      const center = protectee ? protectee.position : home
      const threat = W.nearestHostile(bot, r + 8, e => e.position.distanceTo(center) <= r && !W.NEVER_AUTO_ATTACK.has(e.name))
      if (threat) {
        const weapon = W.bestWeapon(bot)
        if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand')
        await bot.pvp.attack(threat)
        const started = Date.now()
        while (threat.isValid && bot.pvp.target === threat && Date.now() - started < 30000) await ctx.sleep(250)
        try { bot.pvp.forceStop ? bot.pvp.forceStop() : await bot.pvp.stop() } catch {}
        continue
      }
      if (bot.entity.position.distanceTo(center) > 4) {
        bot.pathfinder.setGoal(new goals.GoalNear(center.x, center.y, center.z, 2))
      }
      await ctx.sleep(500)
    }
  }
}

actions.craft = {
  description: 'Craft items. Uses or places a crafting table automatically when needed. Examples: oak_planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace, torch, chest.',
  params: { item: 'item name', count: 'how many (default 1)' },
  run: async (ctx, { item, count }) => {
    const { bot } = ctx
    const name = W.resolveCraftTarget(bot, item)
    if (!name) throw new Error(`I don't know an item called "${item}"`)
    const itemId = bot.registry.itemsByName[name].id
    const wanted = clamp(Math.round(num(count, 1)), 1, 256)

    const anyRecipe = bot.recipesAll(itemId, null, true)
    if (!anyRecipe.length) throw new Error(`${name} can't be crafted` + (/^(iron|gold|copper)_ingot$|glass|charcoal|smooth_stone|brick$/.test(name) ? ' (smelt it instead)' : ''))

    let table = null
    let tempTable = false
    let recipes = bot.recipesFor(itemId, null, wanted, null)
    if (!recipes.length) {
      const tableRecipes = bot.recipesFor(itemId, null, wanted, true)
      if (!tableRecipes.length) {
        throw new Error(`missing ingredients for ${wanted} ${name}: need ${describeMissing(bot, anyRecipe, wanted)}`)
      }
      const got = await ensureCraftingTable(ctx)
      table = got.block
      tempTable = got.temporary
      await goto(ctx, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 60000)
      recipes = bot.recipesFor(itemId, null, wanted, table)
      if (!recipes.length) throw new Error(`missing ingredients for ${wanted} ${name}: need ${describeMissing(bot, anyRecipe, wanted)}`)
    }
    const recipe = recipes[0]
    const times = Math.ceil(wanted / recipe.result.count)
    await ctx.race(bot.craft(recipe, times, recipe.requiresTable ? table : null), 30000)
    let note = ''
    if (tempTable && table && await pickBackUp(ctx, table)) note = ' (picked the crafting table back up)'
    return `crafted ${times * recipe.result.count} ${name} (now have ${W.countItem(bot, name)})${note}`
  }
}

actions.smelt = {
  description: 'Smelt or cook items in a furnace (places one if you carry it). Example: raw_iron -> iron_ingot, sand -> glass, beef -> cooked_beef. Uses coal, charcoal, planks or logs as fuel.',
  params: { item: 'item to smelt', count: 'how many (default: all you have, max 64)' },
  timeoutSeconds: 900,
  run: async (ctx, { item, count }) => {
    const { bot } = ctx
    const input = W.findInventoryItem(bot, item)
    if (!input) throw new Error(`I don't have any ${item}`)
    const have = W.countItem(bot, input.name)
    const wanted = clamp(Math.round(num(count, have)), 1, Math.min(have, 64))

    let tempFurnace = false
    let furnaceBlock = findNearestBlock(bot, ['furnace'], 32)
    if (!furnaceBlock) {
      if (!bot.inventory.items().find(i => i.name === 'furnace')) {
        throw new Error('there is no furnace nearby and I am not carrying one (craft one from 8 cobblestone)')
      }
      furnaceBlock = await placeUtilityBlock(ctx, 'furnace')
      tempFurnace = isTemporarySpot(ctx, furnaceBlock.position)
    }

    const fuels = bot.inventory.items().filter(i => i.name !== input.name && fuelValue(i.name) > 0)
      .sort((a, b) => fuelValue(b.name) - fuelValue(a.name))
    const fuel = fuels[0]

    await goto(ctx, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 60000)
    const furnace = await ctx.race(bot.openFurnace(furnaceBlock), 10000)
    let got = 0
    let outName = '?'
    try {
      if (furnace.outputItem()) {
        const it = await furnace.takeOutput()
        outName = it?.name || outName
      }
      const existingFuel = furnace.fuelItem()
      if (!fuel && !existingFuel && !(furnace.fuel > 0)) throw new Error('I have no fuel (coal, charcoal, planks or logs)')
      if (fuel && (!existingFuel || existingFuel.name === fuel.name)) {
        const fuelNeeded = Math.ceil(wanted / fuelValue(fuel.name))
        const fuelCount = Math.min(fuelNeeded, W.countItem(bot, fuel.name), 64 - (existingFuel?.count || 0))
        if (fuelCount > 0) await furnace.putFuel(fuel.type, null, fuelCount)
      }
      const existingInput = furnace.inputItem()
      if (existingInput && existingInput.name !== input.name) await furnace.takeInput()
      await furnace.putInput(input.type, null, wanted)

      const deadline = Date.now() + wanted * 11000 + 15000
      let lastProgress = Date.now()
      while (got < wanted && Date.now() < deadline) {
        await ctx.sleep(1000)
        const out = furnace.outputItem()
        if (out) {
          const taken = await furnace.takeOutput()
          got += taken?.count || out.count
          outName = taken?.name || out.name
          lastProgress = Date.now()
          ctx.setStatus(`${got}/${wanted} ${outName}`)
        } else if (!furnace.inputItem() && !furnace.outputItem()) {
          break
        } else if (Date.now() - lastProgress > 25000 && !(furnace.fuel > 0)) {
          break // ran out of fuel
        }
      }
    } finally {
      try { furnace.close() } catch {}
    }
    if (!got) throw new Error('nothing came out of the furnace (out of fuel, or that item cannot be smelted)')
    let note = ''
    if (tempFurnace && got >= wanted && await pickBackUp(ctx, furnaceBlock)) note = ' (picked the furnace back up)'
    return `smelted ${got} ${outName}` + (got < wanted ? ` (${wanted - got} left in the furnace)` : '') + note
  }
}

actions.place_block = {
  description: 'Place one block from inventory, at coordinates or (if omitted) somewhere sensible near you. Chests, crafting tables, furnaces, beds etc. go against a wall out of the way (chests join existing chests into double chests).',
  params: { block: 'block/item name', x: 'optional', y: 'optional', z: 'optional' },
  run: async (ctx, { block, x, y, z }) => {
    const { bot } = ctx
    const item = W.findInventoryItem(bot, block)
    if (!item) throw new Error(`I don't have any ${block}`)
    if ([x, y, z].every(v => Number.isFinite(num(v)))) {
      const pos = new Vec3(Math.floor(num(x)), Math.floor(num(y)), Math.floor(num(z)))
      const res = await placeAt(ctx, pos, item.name)
      if (res === 'placed' || res === 'exists') return `${item.name} ${res === 'exists' ? 'spot already filled' : 'placed'} at ${fmtPos(pos)}`
      throw new Error(res === 'no-support' ? 'nothing to place it against there' : 'something is in the way')
    }
    const placed = PL.isUtility(item.name) ? await placeUtilityBlock(ctx, item.name) : await placeNextToBot(ctx, item.name)
    return `placed ${item.name} at ${fmtPos(placed.position)}`
  }
}

actions.build = {
  description: 'Quick simple structure (for a real home use build_base). It automatically picks a nearby flat, open spot on the surface, clears plants/leaves and levels small bumps. structure: hut (walls + flat roof + doorway; size 2 needs ~50 blocks, size 3 ~71), wall, tower, platform, floor (fills holes/water where you stand). Can mix materials (dirt, cobblestone, planks...). Optional: block, size, length, width, height, or x,y,z.',
  params: { structure: 'hut | wall | tower | platform | floor', block: 'optional material', size: 'hut interior size 2-7 (default 3)', variant: 'hut design: box or peaked (default: random)', length: 'optional', height: 'optional' },
  timeoutSeconds: 1200,
  run: async (ctx, args) => {
    const { bot } = ctx
    const kind = String(args.structure || '').toLowerCase()
    // Building skill: beginners only manage small huts and miss the odd block.
    const skill = ctx.skills?.params('building') || { missChance: 0, hutMaxSize: 7 }
    const isHut = ['hut', 'house', 'shelter', 'cabin'].includes(kind)
    let shrunk = false
    if (isHut && num(args.size ?? args.width ?? args.length, 3) > skill.hutMaxSize) {
      args = { ...args, size: skill.hutMaxSize, width: undefined, length: undefined }
      shrunk = true
    }
    // Pick a hut design: the one asked for, or a random one the bot knows.
    if (isHut && !args.variant) {
      const known = skill.hutVariants || ['box']
      args = { ...args, variant: known[Math.floor(Math.random() * known.length)] }
    }
    const offsets = structureOffsets(kind, args)
    if (!offsets) throw new Error(`I don't know how to build "${args.structure}". Options: hut, wall, tower, platform, floor`)
    const groundLevel = ['floor', 'bridge'].includes(kind)
    const { f, r } = facingVectors(bot)
    const key = (p) => `${p.x},${p.y},${p.z}`

    // ---- choose where
    let origin
    if ([args.x, args.y, args.z].every(v => Number.isFinite(num(v)))) {
      origin = new Vec3(Math.floor(num(args.x)), Math.floor(num(args.y)), Math.floor(num(args.z)))
    } else if (groundLevel) {
      origin = bot.entity.position.floored().plus(f.scaled(2))
    } else {
      const cells = [...new Map(offsets.map(([ri, , fi]) => [`${ri},${fi}`, [ri, fi]])).values()]
      const height = Math.max(...offsets.map(o => o[1])) + 2
      const site = T.findBuildSite(bot, { cells, f, r, height, radius: 16 })
      if (!site) {
        const c = T.cover(bot)
        if (c.kind === 'underground' || c.kind === 'indoors') {
          throw new Error("I'm underground/under a roof, so there's no open space to build here. Use go_to_surface first")
        }
        throw new Error('no flat, open, dry spot within 16 blocks (too many trees, water or hills). Move somewhere flatter and try again')
      }
      origin = site.origin
    }
    const at = (ri, up, fi) => origin.plus(r.scaled(ri)).plus(f.scaled(fi)).offset(0, up, 0)
    const targets = offsets.map(([ri, up, fi]) => at(ri, up, fi))
    const targetKeys = new Set(targets.map(key))

    // ---- prepare: level the ground and clear the volume
    const fills = []
    const clears = []
    if (!groundLevel) {
      const cells = [...new Map(offsets.map(([ri, , fi]) => [`${ri},${fi}`, [ri, fi]])).values()]
      const maxUp = Math.max(...offsets.map(o => o[1]))
      for (const [ri, fi] of cells) {
        const base = at(ri, 0, fi)
        // Fill dips so every column stands on solid ground.
        for (let y = base.y - 1; y >= base.y - 3; y--) {
          const p = new Vec3(base.x, y, base.z)
          if (T.isFirm(bot.blockAt(p))) break
          fills.push(p)
        }
        // Remove anything solid inside the structure that isn't part of it (interior, doorway),
        // plus leaves anywhere in the volume.
        for (let up = 0; up <= maxUp; up++) {
          const p = at(ri, up, fi)
          const b = bot.blockAt(p)
          if (!b || b.name === 'air' || b.name === 'cave_air') continue
          if (T.isLeaves(b) || (b.boundingBox === 'block' && !targetKeys.has(key(p)))) clears.push(p)
        }
      }
      fills.sort((a, b) => a.y - b.y)
      clears.sort((a, b) => b.y - a.y)
    }

    const todo = targets.filter(p => !T.isFirm(bot.blockAt(p)))
    const needed = todo.length + fills.length
    if (!needed && !clears.length) return `that ${kind} is already there`

    const mats = pickBuildMaterials(bot, needed, args.block)
    if (mats.total < needed) {
      const haveList = mats.list.length ? ` (${mats.list.map(n => `${n} x${W.countItem(bot, n)}`).join(', ')})` : ''
      throw new Error(`I need ${needed} building blocks for that ${kind} but only have ${mats.total}${haveList}. Gather about ${needed - mats.total} more (dirt or cobblestone is quickest), or build something smaller`)
    }
    const nextMaterial = () => {
      const name = mats.list.find(n => W.countItem(bot, n) > 0)
      if (!name) throw new Error('ran out of building blocks')
      return name
    }

    // Don't let the pathfinder dig through what we build or burn our material as scaffolding.
    const restore = bot.pathfinder.movements
    if (bot._buildMovements) {
      const matIds = new Set(mats.list.map(n => bot.registry.itemsByName[n]?.id))
      bot._buildMovements.scafoldingBlocks = (restore?.scafoldingBlocks || []).filter(id => !matIds.has(id))
      bot.pathfinder.setMovements(bot._buildMovements)
    }
    let placed = 0
    const used = {}
    const placeOne = async (pos) => {
      const mat = nextMaterial()
      const res = await placeAt(ctx, pos, mat)
      if (res === 'placed') { placed++; used[mat] = (used[mat] || 0) + 1 }
      return res
    }
    try {
      ctx.setStatus(`preparing site at ${fmtPos(origin)}`)
      for (const p of clears) {
        ctx.check()
        try { await clearBlock(ctx, p) } catch (err) { if (err instanceof CancelledError) throw err }
      }
      for (const p of fills) {
        ctx.check()
        try { await placeOne(p) } catch (err) { if (err instanceof CancelledError || /ran out/.test(err.message)) throw err }
      }
      let pending = todo.slice().sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      let missed = 0
      for (let pass = 0; pass < 12 && pending.length; pass++) {
        const next = []
        for (const pos of pending) {
          ctx.check()
          if (pass === 0 && skill.missChance && Math.random() < skill.missChance) { missed++; continue } // still learning
          let res
          try {
            res = await placeOne(pos)
          } catch (err) {
            if (err instanceof CancelledError || /ran out/.test(err.message)) throw err
            res = 'blocked'
          }
          if (res === 'placed') ctx.setStatus(`${placed}/${needed} blocks`)
          else if (res !== 'exists') next.push(pos)
        }
        if (next.length === pending.length) break // no progress this pass
        pending = next
      }
      const left = pending.filter(p => !T.isFirm(bot.blockAt(p))).length
      if (left && !placed) throw new Error(`couldn't place any blocks for the ${kind} at ${fmtPos(origin)} (no support or something in the way)`)
      const usedText = Object.entries(used).map(([n, c]) => `${c} ${n}`).join(', ') || 'no new blocks'
      let result = `built ${kind} at ${fmtPos(origin)} using ${usedText}` + (left ? ` (${left} spots couldn't be filled)` : '')
      if (isHut) result = result.replace(`built ${kind}`, `built a ${args.variant || 'box'} ${kind}`)
      if (missed) result += ` (I missed ${missed} spots - still learning; build it again to patch the gaps)`
      if (shrunk) result += ` (kept it small: size ${skill.hutMaxSize} is the biggest I can manage so far)`
      ctx.skills?.award('building', Math.min(25, placed * 0.4) + (left || missed ? 0 : 5), `built a ${kind}`)
      if (isHut) {
        const S = clamp(num(args.size ?? args.width ?? args.length, 3), 2, 7)
        const inside = at(0, 0, 1 + Math.floor(S / 2))
        result += `; the doorway faces ${facingName(f.scaled(-1))}, inside is ${fmtPos(inside)}`
        if (ctx.memory && !ctx.memory.getPlace('home')) {
          ctx.memory.setPlace('home', inside, bot.game?.dimension, `${kind} built by me`)
          result += '; saved it as your home'
        }
      }
      return result
    } finally {
      if (bot._buildMovements && restore) bot.pathfinder.setMovements(restore)
    }
  }
}

actions.build_base = {
  description: 'Build a proper base (a big project, may take several minutes; calling it again continues an unfinished one). style "surface": finds the flattest nearby area, clears trees and levels it, then builds a log-framed house with floor, windows, door, roof, torches and any crafting_table/furnace/chest/bed you carry. Sizes: small (7x7, ~150 blocks), medium (9x9, ~260), large (11x11, ~370), mostly planks/cobblestone plus ~20-30 logs. style "underground": digs a covered 2-wide staircase with doors down to a carved room (size small/medium/large), seals caves/water/lava, adds torches and furniture; needs a pickaxe and produces lots of cobblestone. Use plan_only first to check materials.',
  params: { style: 'surface | underground', variant: 'optional design: cottage or longhouse (surface), cellar or hall (underground); default: random among the ones you know', size: 'small | medium | large (default: the biggest you can manage)', storeys: 'surface only: 1 or 2 (two storeys needs building tier 4)', depth: 'underground: how deep, default 10', name: 'project name (default "base")', plan_only: 'true = only choose the spot and list needed materials', restart: 'true = abandon the old one and start a new one here' },
  timeoutSeconds: 2400,
  run: async (ctx, args) => {
    const { bot } = ctx
    const mem = ctx.memory
    const name = String(args.name || 'base').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v))
    let proj = mem?.getProject(name) || ctx.bot._localProjects?.[name] || null
    if (proj && truthy(args.restart)) proj = null
    if (proj && proj.status === 'done' && !truthy(args.plan_only)) {
      const allowed = (ctx.skills?.params('building')?.upgrades || Object.keys(H.UPGRADES))
        .filter(u => H.UPGRADES[u].styles.includes(proj.style) && !(proj.upgrades || []).includes(u) && !(u === 'second_storey' && (proj.storeys || 1) > 1))
      return `"${name}" is already finished at ${proj.origin.x} ${proj.origin.y} ${proj.origin.z}. ` +
        (allowed.length ? `Improve it instead with upgrade_base: ${allowed.join(', ')}.` : 'There are no upgrades you know for it yet.') +
        ' (Or use a different name / restart:true for a whole new base.)'
    }

    if (!proj) {
      const style = /under/i.test(String(args.style || '')) ? 'underground' : 'surface'
      // Building skill decides which bases the bot knows how to make.
      const skill = ctx.skills?.params('building') || { bases: ['surface', 'underground'], baseSizes: ['small', 'medium', 'large'], storeys: 2 }
      if (!skill.bases.includes(style)) ctx.skills.require('building', 2, `${style} bases`)
      const asked = String(args.size || '').toLowerCase()
      let size = B.SIZES[asked] ? asked : skill.baseSizes[skill.baseSizes.length - 1] || 'small'
      if (!skill.baseSizes.includes(size)) {
        throw new Error(`a ${size} base is beyond me for now; I can manage: ${skill.baseSizes.join(', ')}. (Building more bases will improve that.)`)
      }
      const storeys = style === 'surface' && Math.round(num(args.storeys, 1)) >= 2 ? 2 : 1
      if (storeys > skill.storeys) ctx.skills.require('building', 4, 'two-storey houses')
      // Which design: the one asked for if the bot knows it, otherwise a random one it knows.
      const known = (ctx.skills ? skill.variants : null) || null
      const askedVariant = String(args.variant || '').toLowerCase()
      let variant
      if (H.VARIANTS[askedVariant] && H.VARIANTS[askedVariant].style === style) {
        if (known && !known.includes(askedVariant)) throw new Error(`I don't know how to build a ${askedVariant} yet; I know: ${known.filter(v => H.VARIANTS[v].style === style).join(', ')}`)
        variant = askedVariant
      } else {
        variant = known ? H.pickVariant(style, known) : (style === 'surface' ? 'cottage' : 'cellar')
      }
      const depth = clamp(Math.round(num(args.depth, 10)), 6, 24)
      let site
      if (style === 'surface') {
        const c = T.cover(bot)
        if (c.kind === 'underground' || c.kind === 'indoors') {
          throw new Error("I'm underground/under a roof. Use go_to_surface first, or build an underground base instead")
        }
        site = B.chooseSurfaceSite(bot, size)
        if (!site) throw new Error('no spot within 20 blocks is flat and dry enough (too much water, steep hills or other people\'s builds). Move somewhere more open and try again, or try a smaller size')
      } else {
        if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) throw new Error('digging a base needs a pickaxe (stone or better)')
        site = B.chooseUndergroundSite(bot, size, depth)
        if (!site) throw new Error("can't dig a base from here (unloaded area, bedrock, or someone's blocks in the way). Move a bit and try again")
        if (site.lava > 8) throw new Error('there is a lot of lava down there in every direction. Move somewhere else first')
      }
      proj = {
        style, size, depth, storeys, variant, upgrades: [],
        origin: { x: site.origin.x, y: site.origin.y, z: site.origin.z },
        f: { x: site.f.x, z: site.f.z },
        status: 'in progress',
        progress: 0,
        createdAt: new Date().toISOString()
      }
      if (mem) mem.saveProject(name, proj)
      else (ctx.bot._localProjects = ctx.bot._localProjects || {})[name] = proj
    }

    const origin = new Vec3(proj.origin.x, proj.origin.y, proj.origin.z)
    const f = new Vec3(proj.f.x, 0, proj.f.z)
    const r = B.rightOf(f)
    const layout = H.baseLayout(proj)
    const detailSkip = ctx.skills?.params('building')?.detailSkip || 0
    const plan = B.toWorld(layout, origin, f, r)
    if (proj.style === 'underground') plan.digOrder = (a, b) => a.rel[2] - b.rel[2]
    const storeysNow = (proj.storeys || 1) > 1 || (proj.upgrades || []).includes('second_storey')
    const extras = [proj.variant, ...(proj.upgrades || []).map(u => u.replace(/_/g, ' '))].filter(Boolean).join(' + ')
    const label = `${storeysNow ? 'two-storey ' : ''}${proj.size} ${proj.style} base "${name}"${extras ? ` (${extras})` : ''} at ${fmtPos(origin)}`

    const describeNeeds = (missing) => Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(', ')
    if (truthy(args.plan_only)) {
      const s = B.survey(bot, plan.cells)
      const counts = B.inventoryCounts(bot)
      const usable = (roles) => Object.entries(counts).filter(([n]) => roles.some(role => (B.PALETTE[role] || []).some(e => typeof e === 'string' ? e === n : e.test(n)))).reduce((a, [, c]) => a + c, 0)
      const dist = Math.round(origin.distanceTo(bot.entity.position))
      return `${label} (${dist} blocks away, ${s.progress}% done). Still needs about: ${describeNeeds(s.missing) || 'nothing'}. ` +
        `You carry ~${usable(['wall', 'floor', 'roof'])} wall/floor blocks, ${usable(['frame']) - usable(['wall'])} logs, ${usable(['fill'])} filler blocks. ` +
        'Call build_base again without plan_only to start (it digs and levels first, so you can start before you have everything).'
    }

    const stats = await B.runBlueprint(ctx, plan, { onStatus: (t) => ctx.setStatus(`${name}: ${t}`), detailSkip, allowOwn: true })
    const after = B.survey(bot, plan.cells)
    const essential = Object.entries(after.missing).filter(([g]) => !/optional/.test(g))
    const essentialCount = essential.reduce((n, [, c]) => n + c, 0)
    const optional = Object.entries(after.missing).filter(([g]) => /optional/.test(g))
    proj.progress = after.progress
    proj.needs = essential.length ? describeNeeds(Object.fromEntries(essential)) : ''
    const work = `dug ${stats.dug}, placed ${stats.placed}${stats.sealed ? `, sealed ${stats.sealed} water/lava spots` : ''}`
    const warn = stats.warnings.size ? ` Notes: ${[...stats.warnings].join('; ')}.` : ''

    if (essentialCount > 4) {
      ctx.skills?.award('building', stats.placed * 0.1, 'worked on a base')
      if (mem) mem.saveProject(name, proj)
      return `worked on the ${label}: ${work}. Now ${after.progress}% done. Still need: ${proj.needs}. Gather those, then call build_base (name "${name}") again to continue.${warn}`
    }

    proj.status = 'done'
    proj.needs = ''
    const baseXp = { small: 40, medium: 70, large: 100 }[proj.size] * ((proj.storeys || 1) > 1 ? 1.5 : 1) + stats.placed * 0.05
    ctx.skills?.award('building', baseXp, `finished a ${proj.size} ${proj.style} base`)
    let result = `finished the ${label}: ${work}.`
    if (mem) {
      mem.saveProject(name, proj)
      const oldHome = mem.getPlace('home')
      if (oldHome) mem.setPlace('old_home', new Vec3(oldHome.x, oldHome.y, oldHome.z), oldHome.dimension, oldHome.note)
      mem.setPlace('home', plan.inside, bot.game?.dimension, `${proj.size} ${proj.style} base`)
      mem.setPlace(`${name}_entrance`, plan.entrance, bot.game?.dimension, `entrance of ${name}`)
      mem.addJournal(`Finished building my ${proj.size} ${proj.style} base "${name}".`)
      result += ` Saved as home (inside: ${fmtPos(plan.inside)}, entrance: ${fmtPos(plan.entrance)}).`
    }
    if (optional.length) result += ` Optional extras still missing: ${describeNeeds(Object.fromEntries(optional))}; add them later by running build_base again.`
    return result + warn
  }
}

actions.upgrade_base = {
  description: 'Improve your existing base instead of building a new one. upgrade: storage_room (side room of chests), bunker (safe room under a surface house, ladder down), second_storey (upper floor + ladder + upstairs bedroom, surface), enchanting_room (enchanting table with 15 bookshelves). Which ones you know depends on your building tier. Bring the materials (blocks, ladders, chests, bookshelves...). Resumable like build_base.',
  params: { upgrade: 'storage_room | bunker | second_storey | enchanting_room', name: 'base project name (default "base")' },
  timeoutSeconds: 2400,
  run: async (ctx, { upgrade, name }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const baseName = String(name || 'base').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const proj = mem?.getProject(baseName)
    if (!proj || !['surface', 'underground'].includes(proj.style)) throw new Error(`there is no base called "${baseName}" yet; build one with build_base first`)
    const up = String(upgrade || '').toLowerCase().replace(/[\s-]+/g, '_').replace(/^second_story$/, 'second_storey').replace(/^storage$/, 'storage_room').replace(/^enchanting$/, 'enchanting_room')
    const def = H.UPGRADES[up]
    if (!def) throw new Error(`I don't know an upgrade called "${upgrade}". Options: ${Object.keys(H.UPGRADES).join(', ')}`)
    if (!def.styles.includes(proj.style)) throw new Error(`a ${up.replace(/_/g, ' ')} only works for a ${def.styles.join(' or ')} base`)
    const known = ctx.skills ? (ctx.skills.params('building')?.upgrades || []) : Object.keys(H.UPGRADES)
    if (!known.includes(up)) {
      const tiers = require('../skills/registry').SKILLS.building.tiers
      const need = tiers.findIndex(t => (t.params.upgrades || []).includes(up)) + 1
      ctx.skills.require('building', need || tiers.length, `building a ${up.replace(/_/g, ' ')}`)
    }
    proj.upgrades = proj.upgrades || []
    if (up === 'second_storey' && (proj.storeys || 1) > 1 && !proj.upgrades.includes(up)) return 'that base already has two storeys'
    if (!proj.upgrades.includes(up)) {
      // Never build an extension through someone else's things.
      const before = new Set(H.baseLayout(proj).cells.map(c => c.rel.join(',')))
      const after = H.baseLayout({ ...proj, upgrades: [...proj.upgrades, up] })
      const origin = new Vec3(proj.origin.x, proj.origin.y, proj.origin.z)
      const f = new Vec3(proj.f.x, 0, proj.f.z)
      const plan = B.toWorld(after, origin, f, B.rightOf(f))
      const blocked = plan.cells.filter(c => !before.has(c.rel.join(','))).map(c => bot.blockAt(c.pos))
        .find(b => b && !B.isAirLike(b) && !B.NATURAL.test(b.name) && !T.isLiquid(b))
      if (blocked) throw new Error(`there's a ${blocked.name} in the way of the ${up.replace(/_/g, ' ')} (not mine to remove). Clear it or pick another upgrade`)
      proj.upgrades.push(up)
    }
    proj.status = 'in progress'
    mem.saveProject(baseName, proj)
    Z.invalidate()
    const res = await actions.build_base.run(ctx, { name: baseName })
    if (/^finished/.test(res)) ctx.skills?.award('building', 50, `added a ${up.replace(/_/g, ' ')}`)
    return res.replace(/^finished the/, `added the ${up.replace(/_/g, ' ')} to the`)
  }
}

actions.equip = {
  description: 'Hold or wear an item. slot: hand (default), off-hand, head, torso, legs, feet. Armor goes to the right slot automatically.',
  params: { item: 'item name', slot: 'optional' },
  run: async (ctx, { item, slot }) => {
    const { bot } = ctx
    const it = W.findInventoryItem(bot, item)
    if (!it) throw new Error(`I don't have ${item}`)
    let dest = slot ? String(slot).toLowerCase().replace('offhand', 'off-hand') : 'hand'
    if (!slot) {
      if (/_helmet$|turtle_helmet|carved_pumpkin/.test(it.name)) dest = 'head'
      else if (/_chestplate$|elytra/.test(it.name)) dest = 'torso'
      else if (/_leggings$/.test(it.name)) dest = 'legs'
      else if (/_boots$/.test(it.name)) dest = 'feet'
      else if (it.name === 'shield') dest = 'off-hand'
    }
    await bot.equip(it, dest)
    return `equipped ${it.name} (${dest})`
  }
}

actions.give = {
  description: 'Walk to a player and toss them items.',
  params: { player: 'player name', item: 'item name', count: 'how many (default all)' },
  run: async (ctx, { player, item, count }) => {
    const { bot } = ctx
    const target = W.playerEntity(bot, player)
    if (!target) throw new Error(`I can't see ${player}`)
    const it = W.findInventoryItem(bot, item)
    if (!it) throw new Error(`I don't have any ${item}`)
    const have = W.countItem(bot, it.name)
    const n = clamp(Math.round(num(count, have)), 1, have)
    await goto(ctx, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 60000)
    await bot.lookAt(target.position.offset(0, target.height || 1.6, 0))
    await bot.toss(it.type, null, n)
    return `gave ${n} ${it.name} to ${target.username}`
  }
}

actions.drop = {
  description: 'Drop items on the ground.',
  params: { item: 'item name', count: 'how many (default all)' },
  run: async (ctx, { item, count }) => {
    const { bot } = ctx
    const it = W.findInventoryItem(bot, item)
    if (!it) throw new Error(`I don't have any ${item}`)
    const have = W.countItem(bot, it.name)
    const n = clamp(Math.round(num(count, have)), 1, have)
    await bot.toss(it.type, null, n)
    return `dropped ${n} ${it.name}`
  }
}

actions.eat = {
  description: 'Eat food (best available if not specified).',
  params: { item: 'optional food name' },
  run: async (ctx, { item }) => {
    const { bot } = ctx
    if (bot.food >= 20) return "I'm not hungry"
    const food = item ? W.findInventoryItem(bot, item) : W.bestFood(bot, { allowBad: bot.food < 6 })
    if (!food) throw new Error('I have no food')
    await bot.equip(food, 'hand')
    await ctx.race(bot.consume(), 10000)
    return `ate ${food.name} (food ${bot.food}/20)`
  }
}

actions.sleep = {
  description: 'Sleep in a nearby bed (only works at night or in a thunderstorm).',
  params: {},
  noWatchdog: true,
  timeoutSeconds: 180,
  run: async (ctx) => {
    const { bot } = ctx
    const bedNames = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'))
    const bed = findNearestBlock(bot, bedNames, 48)
    if (!bed) throw new Error('no bed within 48 blocks')
    await goto(ctx, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 60000)
    await bot.sleep(bed)
    ctx.setStatus('sleeping')
    while (bot.isSleeping) await ctx.sleep(1000)
    return 'slept and woke up'
  }
}

actions.deposit = {
  description: 'Put items into the nearest chest or barrel. Without an item, stores everything except tools, weapons, armor and food.',
  params: { item: 'optional item name', count: 'optional (default all)' },
  run: async (ctx, { item, count }) => {
    const { bot } = ctx
    let chest = findNearestBlock(bot, ['chest', 'trapped_chest', 'barrel'], 32)
    if (!chest && bot.inventory.items().some(i => i.name === 'chest')) chest = await placeUtilityBlock(ctx, 'chest')
    if (!chest) throw new Error('no chest or barrel within 32 blocks (and I have no chest to place)')
    await goto(ctx, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 60000)
    const container = await ctx.race(bot.openContainer(chest), 10000)
    const stored = {}
    try {
      let items
      if (item) {
        const it = W.findInventoryItem(bot, item)
        if (!it) throw new Error(`I don't have any ${item}`)
        items = [{ type: it.type, name: it.name, count: clamp(Math.round(num(count, W.countItem(bot, it.name))), 1, W.countItem(bot, it.name)) }]
      } else {
        const keep = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|mace|torch)$/
        const foods = bot.registry.foodsByName || {}
        const totals = {}
        for (const i of bot.inventory.items()) {
          if (keep.test(i.name) || foods[i.name]) continue
          totals[i.name] = totals[i.name] || { type: i.type, name: i.name, count: 0 }
          totals[i.name].count += i.count
        }
        items = Object.values(totals)
      }
      for (const it of items) {
        try {
          await container.deposit(it.type, null, it.count)
          stored[it.name] = it.count
        } catch (err) {
          if (/full/i.test(err.message)) break
        }
      }
    } finally {
      try { container.close() } catch {}
    }
    const list = Object.entries(stored).map(([n, c]) => `${c} ${n}`).join(', ')
    if (!list) throw new Error('could not store anything (chest full?)')
    return `stored ${list}`
  }
}

actions.withdraw = {
  description: 'Take items out of the nearest chest or barrel.',
  params: { item: 'item name', count: 'how many (default all)' },
  run: async (ctx, { item, count }) => {
    const { bot } = ctx
    const chest = findNearestBlock(bot, ['chest', 'trapped_chest', 'barrel'], 32)
    if (!chest) throw new Error('no chest or barrel within 32 blocks')
    await goto(ctx, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 60000)
    const container = await ctx.race(bot.openContainer(chest), 10000)
    try {
      const q = W.clean(item)
      const items = container.containerItems()
      const match = items.find(i => i.name === q) || items.find(i => i.name.includes(q))
      if (!match) {
        const summary = [...new Set(items.map(i => i.name))].slice(0, 15).join(', ') || 'nothing'
        throw new Error(`no ${item} in that chest (it has: ${summary})`)
      }
      const available = items.filter(i => i.name === match.name).reduce((n, i) => n + i.count, 0)
      const n = clamp(Math.round(num(count, available)), 1, available)
      await container.withdraw(match.type, null, n)
      return `took ${n} ${match.name}`
    } finally {
      try { container.close() } catch {}
    }
  }
}

actions.find_block = {
  description: 'Look for the nearest block of a type (up to 64 blocks away) and report where it is, without going there.',
  params: { block: 'block name' },
  run: async (ctx, { block }) => {
    const { bot } = ctx
    const names = W.resolveBlockNames(bot.registry, block)
    if (!names.length) throw new Error(`unknown block "${block}"`)
    const found = findNearestBlock(bot, names, 64)
    if (!found) return `no ${block} within 64 blocks`
    const d = Math.round(found.position.distanceTo(bot.entity.position))
    return `nearest ${found.name} is at ${fmtPos(found.position)} (${d} blocks away)`
  }
}

actions.wait = {
  description: 'Wait a number of seconds.',
  params: { seconds: 'number (max 60)' },
  noWatchdog: true,
  run: async (ctx, { seconds }) => {
    const s = clamp(num(seconds, 5), 1, 60)
    await ctx.sleep(s * 1000)
    return `waited ${s}s`
  }
}

actions.go_to_surface = {
  description: 'If you are underground or in a cave, find the nearest open sky and get up there (digging or climbing if needed).',
  params: {},
  timeoutSeconds: 300,
  run: async (ctx) => {
    const { bot } = ctx
    const before = T.cover(bot)
    if (before.kind === 'outdoors' || before.kind === 'under trees') return 'already on the surface'
    const target = T.findSurface(bot, 16)
    if (!target) throw new Error("can't find open sky within 16 blocks; try walking along the cave or digging up with a pickaxe")
    await goto(ctx, new goals.GoalNear(target.x, target.y, target.z, 1), 240000)
    return `reached the surface at ${fmtPos(bot.entity.position)}`
  }
}

// ---- memory and goals (instant: they don't move the body)

function requireMemory (ctx) {
  if (!ctx.memory) throw new Error('memory is not available')
  return ctx.memory
}

actions.remember_place = {
  description: 'Save a named place in your long-term memory (your current spot unless x,y,z given). Use "home" for your base. Names like mine, iron_cave, village, farm. When it is a player\'s base, set owner to their name (e.g. name "steve_base", owner "Steve"); their base then becomes protected and you can offer them a railway.',
  params: { name: 'short name', note: 'optional note', owner: 'optional: the player it belongs to', x: 'optional', y: 'optional', z: 'optional' },
  instant: true,
  run: async (ctx, { name, note, owner, x, y, z }) => {
    const mem = requireMemory(ctx)
    if (!name) throw new Error('remember_place needs a name')
    const pos = [x, y, z].every(v => Number.isFinite(num(v))) ? new Vec3(num(x), num(y), num(z)) : ctx.bot.entity.position
    const key = mem.setPlace(name, pos, ctx.bot.game?.dimension, note, owner && owner !== ctx.bot.username ? owner : '')
    let extra = ''
    if (owner && owner !== ctx.bot.username) {
      mem.addZone(key, pos, 12) // respect other people's bases
      Z.invalidate()
      extra = ` (${owner}'s; protected radius 12)`
    }
    return `remembered "${key}" at ${fmtPos(pos)}${extra}`
  }
}

actions.forget_place = {
  description: 'Remove a saved place from memory.',
  params: { name: 'place name' },
  instant: true,
  run: async (ctx, { name }) => (requireMemory(ctx).removePlace(name) ? `forgot ${name}` : `no place called ${name}`)
}

actions.go_to_place = {
  description: 'Walk to a place you saved (e.g. home).',
  params: { name: 'place name' },
  timeoutSeconds: 600,
  run: async (ctx, { name }) => {
    const mem = requireMemory(ctx)
    const p = mem.getPlace(name)
    if (!p) throw new Error(`I don't remember a place called "${name}". Known: ${Object.keys(mem.data.places).join(', ') || 'none'}`)
    const dim = String(ctx.bot.game?.dimension || 'overworld').replace('minecraft:', '')
    if (p.dimension !== dim) throw new Error(`${name} is in the ${p.dimension}, but I'm in the ${dim}`)
    await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 2), 540000)
    return `arrived at ${name}`
  }
}

actions.set_goal = {
  description: 'Give yourself a long-term goal you will keep working on across many plans (and restarts). Example: "build a cozy home", "get full iron gear", "find diamonds".',
  params: { goal: 'what you want to achieve', why: 'optional reason' },
  instant: true,
  run: async (ctx, { goal, why }) => {
    const g = requireMemory(ctx).addGoal(goal, why)
    return `goal #${g.id} set: ${g.text}`
  }
}

actions.complete_goal = {
  description: 'Mark one of your goals as done, or abandoned if it is no longer worth it.',
  params: { goal: 'goal number or text', outcome: '"done" (default) or "abandoned"', note: 'optional' },
  instant: true,
  run: async (ctx, { goal, outcome, note }) => {
    const g = requireMemory(ctx).finishGoal(goal, outcome === 'abandoned' ? 'abandoned' : 'done', note)
    if (!g) throw new Error(`no active goal matching "${goal}"`)
    return `goal #${g.id} ${g.status}: ${g.text}`
  }
}

actions.note_player = {
  description: 'Remember something about a player (what they like, what they gave you, how they treat you).',
  params: { player: 'player name', note: 'short note' },
  instant: true,
  run: async (ctx, { player, note }) => {
    requireMemory(ctx).notePlayer(player, note)
    return `noted about ${player}: ${note}`
  }
}

actions.mine = require('./mining').mineAction

const FARM = require('./farming')
actions.farm = FARM.farmAction
actions.breed_animals = FARM.breedAction
const NETHER = require('./nether')
actions.build_portal = NETHER.portalAction
actions.nether_trip = NETHER.tripAction

actions.protect_area = {
  description: 'Mark an area as protected (a friend\'s house, a farm, a build): you will never dig, pillar or harvest inside it. Centered on you unless x,y,z given.',
  params: { name: 'short name', radius: 'blocks (default 10)', x: 'optional', y: 'optional', z: 'optional' },
  instant: true,
  run: async (ctx, { name, radius, x, y, z }) => {
    if (!ctx.memory) throw new Error('memory is not available')
    if (!name) throw new Error('protect_area needs a name')
    const pos = [x, y, z].every(v => Number.isFinite(num(v))) ? new Vec3(num(x), num(y), num(z)) : ctx.bot.entity.position
    const rad = clamp(Math.round(num(radius, 10)), 2, 64)
    ctx.memory.addZone(name, pos, rad)
    Z.invalidate()
    return `protected "${name}" (radius ${rad}) around ${fmtPos(pos)}`
  }
}

actions.unprotect_area = {
  description: 'Remove a protected area you marked earlier.',
  params: { name: 'area name' },
  instant: true,
  run: async (ctx, { name }) => {
    const ok = ctx.memory?.removeZone(name)
    Z.invalidate()
    return ok ? `"${name}" is no longer protected` : `no protected area called "${name}"`
  }
}

// What a tidy player throws away (or stores) when the inventory fills up.
const JUNK = /^(rotten_flesh|poisonous_potato|spider_eye|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|dead_bush|short_grass|tall_grass|fern|seagrass)$/
const BULK = /^(dirt|coarse_dirt|gravel|sand|red_sand|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|calcite|dripstone_block|pointed_dripstone|flint)$/

actions.clean_inventory = {
  description: 'Tidy your inventory: store everything except gear and food in a nearby chest (if there is one within 16 blocks), otherwise drop junk (rotten flesh, seeds...) and keep only one stack of bulk blocks (dirt, gravel, granite...).',
  params: {},
  run: async (ctx) => {
    const { bot } = ctx
    const chest = findNearestBlock(bot, ['chest', 'trapped_chest', 'barrel'], 16)
    if (chest) return actions.deposit.run(ctx, {})
    const totals = {}
    for (const i of bot.inventory.items()) totals[i.name] = (totals[i.name] || 0) + i.count
    const dropped = []
    for (const [name, count] of Object.entries(totals)) {
      ctx.check()
      let n = 0
      if (JUNK.test(name)) n = count
      else if (BULK.test(name) && count > 64) n = count - 64
      if (!n) continue
      const item = bot.inventory.items().find(i => i.name === name)
      try { await bot.toss(item.type, null, n); dropped.push(`${n} ${name}`) } catch {}
    }
    return dropped.length ? `dropped ${dropped.join(', ')} (${bot.inventory.emptySlotCount()} free slots now)` : `nothing to throw away (${bot.inventory.emptySlotCount()} free slots)`
  }
}

actions.note_lesson = {
  description: 'Write down a one-line lesson for one of your skills after something went wrong (or right), so you do better next time. Example: skill building, lesson "gather 80 blocks before starting a medium base".',
  params: { skill: 'building | mining | combat | railways | farming | nether', lesson: 'one short sentence' },
  instant: true,
  run: async (ctx, { skill, lesson }) => {
    if (!ctx.skills) throw new Error('skills are not available')
    ctx.skills.addLesson(String(skill || '').toLowerCase(), lesson)
    return `noted for ${skill}: ${lesson}`
  }
}

// ---- railways

const R = require('./railway')

// Resolve "home", a saved place, a player's name (their base) or "x z" into a position + label.
function resolveDestination (ctx, ref) {
  const { bot } = ctx
  const mem = ctx.memory
  if (ref && typeof ref === 'object' && Number.isFinite(num(ref.x)) && Number.isFinite(num(ref.z))) {
    return { pos: new Vec3(num(ref.x), num(ref.y, bot.entity.position.y), num(ref.z)), label: `${num(ref.x)} ${num(ref.z)}` }
  }
  const s = String(ref || '').trim()
  const coords = s.match(/^(-?\d+)[ ,]+(?:(-?\d+)[ ,]+)?(-?\d+)$/)
  if (coords) {
    const [x, y, z] = coords[2] !== undefined ? [coords[1], coords[2], coords[3]] : [coords[1], bot.entity.position.y, coords[3]]
    return { pos: new Vec3(num(x), num(y), num(z)), label: `${x} ${z}` }
  }
  if (mem) {
    const place = mem.getPlace(s)
    if (place) return { pos: new Vec3(place.x, place.y, place.z), label: s }
    const base = mem.playerBase(s)
    if (base) return { pos: new Vec3(base.x, base.y, base.z), label: `${base.owner || s}'s base`, owner: base.owner || s }
  }
  return null
}

function railName (label) {
  return 'rail_' + String(label).toLowerCase().replace(/'s base$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

actions.plan_railway = {
  description: 'Work out a powered minecart railway from your base (or "from") to a place, a player\'s base (player name) or "x z": route length, materials needed (rails, powered rails, redstone torches, support blocks), what you have, and whether you can easily get the rest. Does not build anything.',
  params: { to: 'place name, player name, or "x z"', from: 'optional, default home' },
  instant: true,
  run: async (ctx, { to, from }) => {
    const { bot } = ctx
    const dest = resolveDestination(ctx, to)
    if (!dest) throw new Error(`I don't know where "${to}" is. Save it with remember_place first (with owner for a player's base)`)
    const start = resolveDestination(ctx, from || 'home') || { pos: bot.entity.position.floored(), label: 'here' }
    const route = R.planRoute(ctx.memory, start.pos, dest.pos)
    const need = R.estimate(route.cols.length)
    const check = R.materialCheck(bot, need)
    return `railway ${start.label} -> ${dest.label}: about ${route.cols.length} blocks (${route.cols.length > 1 && route.cols.some((c, i) => i && (c.dir.x !== route.cols[i - 1].dir.x)) ? 'one corner' : 'straight'}). ` +
      `Needs ~${need.rails} rails (${need.iron} iron), ${need.powered} powered rails (${need.gold} gold), ${need.torches} redstone torches, ~${need.redstone} redstone, ${need.sticks} sticks, 2 buttons, and up to ~${need.supportBlocks} cobblestone/dirt for bridges. ` +
      (check.hasAll ? 'You have enough metal and redstone.' : `Still missing: ${check.missing.join(', ')}. ${check.easy ? 'That should be easy to mine.' : 'That would take real effort to gather.'}`)
  }
}

actions.build_railway = {
  description: 'Build (or continue) a powered minecart railway from your base (or "from") to a place, a player\'s base or "x z". Follows the land, tunnels through hills, bridges dips and water, adds powered rails with redstone torches, and a station with a buffer and launch button at each end. Crafts rails from iron/gold/redstone/sticks as needed. Long project: it pauses when out of materials and continues on the next call.',
  params: { to: 'place name, player name, or "x z"', from: 'optional, default home' },
  timeoutSeconds: 3600,
  run: async (ctx, { to, from }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const dest = resolveDestination(ctx, to)
    if (!dest) throw new Error(`I don't know where "${to}" is. Save it with remember_place first (with owner for a player's base)`)
    const name = railName(dest.label)
    let proj = mem?.getProject(name) || bot._railProjects?.[name] || null
    if (proj && proj.status === 'done') return `the railway to ${dest.label} is already finished`
    const save = () => { if (mem) mem.saveProject(name, proj); else (bot._railProjects = bot._railProjects || {})[name] = proj }
    if (!proj) {
      const start = resolveDestination(ctx, from || 'home') || { pos: bot.entity.position.floored(), label: 'here' }
      const route = R.planRoute(mem, start.pos, dest.pos)
      if (route.cols.length < 6) throw new Error('that is too close for a railway; just walk!')
      if (route.blocked > 0) throw new Error('every straight route there crosses someone\'s base. Pick a different destination or ask an operator to unprotect the area')
      const maxLength = ctx.skills?.params('railways')?.maxLength ?? Infinity
      if (route.cols.length > maxLength) throw new Error(`that line would be ${route.cols.length} blocks; so far I can only manage railways up to ${maxLength} blocks. (Building shorter lines first will improve that.)`)
      const startInfo = T.columnInfo(bot, route.start.x, route.start.z, Math.floor(start.pos.y), 20)
      proj = {
        style: 'rail', toName: dest.label, owner: dest.owner || '',
        cols: route.cols.map(c => ({ x: c.x, z: c.z, dx: c.dir.x, dz: c.dir.z })),
        startY: startInfo ? startInfo.y + 1 : Math.floor(start.pos.y),
        rails: [], built: 0, status: 'in progress', createdAt: new Date().toISOString()
      }
      save()
    }
    // Walk to where work continues.
    const resumeAt = proj.cols[Math.min(proj.built, proj.cols.length - 1)]
    await goto(ctx, new goals.GoalNearXZ(resumeAt.x, resumeAt.z, 6), 300000)
    const res = await R.buildSection(ctx, proj, { onStatus: (t) => ctx.setStatus(t), save })
    ctx.skills?.award('railways', res.laid * 0.5, 'laid track')
    const total = proj.cols.length
    if (res.done) {
      proj.status = 'done'
      proj.needs = ''
      save()
      if (mem) {
        const first = proj.rails[0]; const last = proj.rails[proj.rails.length - 1]
        mem.setPlace(`${name}_station_a`, new Vec3(first.x, first.y, first.z), bot.game?.dimension, `railway station to ${dest.label}`)
        mem.setPlace(`${name}_station_b`, new Vec3(last.x, last.y, last.z), bot.game?.dimension, `railway station (${dest.label} end)`)
        mem.addJournal(`Finished a ${total}-block railway to ${dest.label}.`)
      }
      ctx.skills?.award('railways', 30, `finished a railway to ${dest.label}`)
      return `finished the railway to ${dest.label}: ${total} blocks. Stations saved as ${name}_station_a / _b (put a minecart on the end rail, get in, press the button).`
    }
    const missingText = Object.entries(res.missing).map(([k, n]) => `${n} ${k}`).join(', ')
    proj.needs = missingText
    save()
    return `railway to ${dest.label}: ${proj.built}/${total} blocks done. Paused, still need: ${missingText || 'materials'}. Get them (iron for rails, gold + redstone for powered rails, cobblestone for bridges), then call build_railway again.`
  }
}

actions.ride_railway = {
  description: 'Ride one of your finished railways: go to its station, put down a minecart (you need one), get in, press the launch button and get off at the other end.',
  params: { to: 'destination of the railway (place or player name)' },
  timeoutSeconds: 900,
  run: async (ctx, { to }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const dest = resolveDestination(ctx, to)
    const proj = dest && mem?.getProject(railName(dest.label))
    if (!proj || proj.status !== 'done') throw new Error(`there is no finished railway to ${to}`)
    const cart = bot.inventory.items().find(i => i.name === 'minecart')
    if (!cart) throw new Error('I need a minecart (5 iron ingots)')
    const a = proj.rails[0]; const b = proj.rails[proj.rails.length - 1]
    const me = bot.entity.position
    const [startR, endR] = me.distanceTo(new Vec3(a.x, a.y, a.z)) <= me.distanceTo(new Vec3(b.x, b.y, b.z)) ? [a, b] : [b, a]
    const startPos = new Vec3(startR.x, startR.y, startR.z)
    await goto(ctx, new goals.GoalNear(startPos.x, startPos.y, startPos.z, 2), 300000)
    await bot.equip(cart, 'hand')
    const entity = await ctx.race(bot.placeEntity(bot.blockAt(startPos), new Vec3(0, 1, 0)), 8000)
    await ctx.sleep(300)
    bot.mount(entity)
    await ctx.sleep(500)
    const dir = new Vec3(startR.dx, 0, startR.dz)
    const button = bot.blockAt(startPos.plus(R.sideOf(startR === a ? dir : dir.scaled(-1)))) || bot.findBlock({ matching: (blk) => /_button$/.test(blk.name), maxDistance: 3 })
    if (button && /_button$/.test(button.name)) await bot.activateBlock(button)
    const endPos = new Vec3(endR.x, endR.y, endR.z)
    const started = Date.now()
    while (bot.entity.position.distanceTo(endPos) > 2.5 && Date.now() - started < 600000) {
      ctx.setStatus(`riding: ${Math.round(bot.entity.position.distanceTo(endPos))} blocks to go`)
      await ctx.sleep(1000)
    }
    bot.dismount()
    return bot.entity.position.distanceTo(endPos) <= 3 ? `rode the railway to ${dest.label}` : 'the cart stopped before the end of the line'
  }
}

module.exports = { actions, helpers: { goto, placeAt, placeNextToBot, pickupNearbyItems, structureOffsets, facingVectors, pickBuildMaterials } }
