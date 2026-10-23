'use strict'
// Shared simulated-world harness: a fake in-memory Minecraft world and helpers to run actions in it.
// Requiring this file first also swaps mineflayer-pathfinder for a tiny stub (sim/pathfinder-stub.js)
// that "teleports" the bot, so no server or real pathfinding is needed.
const Module = require('module')
const path = require('path')
const STUB = require.resolve('./pathfinder-stub')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'mineflayer-pathfinder') return STUB
  return origResolve.call(this, request, ...rest)
}
const P = path.join(__dirname, '..') + '/'
const { Vec3 } = require('vec3')
const { fakeBot, until } = require(P + 'test/helpers')
const { actions } = require(P + 'src/body/actions')
const { Executor } = require(P + 'src/body/executor')

function registry () {
  const blocks = ['air', 'stone', 'cobblestone', 'dirt', 'grass_block', 'oak_log', 'birch_log', 'stripped_oak_log', 'iron_ore',
    'deepslate_iron_ore', 'crafting_table', 'furnace', 'chest', 'red_bed', 'oak_leaves', 'water', 'poppy', 'short_grass', 'coal_ore', 'oak_planks', 'birch_planks', 'glass', 'oak_door', 'torch', 'wall_torch', 'lava', 'bedrock', 'oak_slab', 'rail', 'powered_rail', 'redstone_torch', 'oak_button', 'ladder',
    'bookshelf', 'enchanting_table', 'farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'oak_fence', 'obsidian', 'nether_portal', 'netherrack', 'nether_quartz_ore', 'stone_bricks', 'smoker', 'blast_furnace', 'barrel', 'composter', 'anvil', 'smithing_table', 'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table', 'lectern', 'ender_chest', 'brewing_stand', 'cauldron', 'lantern',
    'bell', 'spawner', 'mossy_cobblestone', 'cave_air', 'trapped_chest', 'crying_obsidian', 'chiseled_sandstone', 'sandstone', 'sand']
  const items = ['cobblestone', 'dirt', 'oak_log', 'birch_log', 'oak_planks', 'birch_planks', 'stick', 'crafting_table', 'wooden_pickaxe',
    'stone_pickaxe', 'iron_ingot', 'raw_iron', 'coal', 'furnace', 'bread', 'rotten_flesh', 'iron_sword', 'wooden_axe', 'stone_sword', 'glass', 'oak_door', 'torch', 'chest', 'red_bed', 'rail', 'powered_rail', 'redstone_torch', 'oak_button', 'gold_ingot', 'redstone', 'minecart', 'ladder',
    'bookshelf', 'enchanting_table', 'wheat_seeds', 'wheat', 'carrot', 'potato', 'beetroot_seeds', 'beetroot', 'wooden_hoe', 'water_bucket', 'bucket', 'oak_fence', 'obsidian', 'flint_and_steel', 'bone_meal', 'netherrack', 'quartz', 'stone_bricks', 'smoker', 'blast_furnace', 'barrel', 'composter', 'anvil', 'smithing_table', 'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table', 'lectern', 'ender_chest', 'brewing_stand', 'cauldron', 'lantern',
    'bow', 'arrow', 'shield', 'golden_apple', 'diamond', 'emerald', 'cooked_beef', 'diamond_sword', 'sand']
  const r = { blocksByName: {}, itemsByName: {}, items: {}, blocks: {}, foodsByName: {
    bread: { foodPoints: 5, saturation: 6 }, rotten_flesh: { foodPoints: 4, saturation: 0.8 }, golden_apple: { foodPoints: 4, saturation: 9.6 }, cooked_beef: { foodPoints: 8, saturation: 12.8 } } }
  blocks.forEach((n, i) => { r.blocksByName[n] = { id: i, name: n }; r.blocks[i] = r.blocksByName[n] })
  items.forEach((n, i) => { r.itemsByName[n] = { id: 1000 + i, name: n }; r.items[1000 + i] = r.itemsByName[n] })
  return r
}

function worldBot () {
  const bot = fakeBot()
  bot.registry = registry()
  const world = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  const propsMap = new Map()
  bot._props = propsMap
  const mk = (name, p) => ({ name, type: bot.registry.blocksByName[name].id, position: p.clone(), getProperties: () => propsMap.get(key(p)) || {},
    boundingBox: ['air', 'water', 'lava', 'poppy', 'short_grass', 'torch', 'wall_torch', 'oak_door', 'rail', 'powered_rail', 'redstone_torch', 'oak_button', 'ladder', 'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_portal', 'lantern'].includes(name) ? 'empty' : 'block', diggable: name !== 'air' && name !== 'water' })
  bot.setBlock = (p, name) => world.set(key(p), name)
  bot.blockAt = (p) => { p = p.floored(); return mk(world.get(key(p)) || (p.y < 64 ? 'stone' : 'air'), p) }
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) bot.setBlock(new Vec3(x, 63, z), 'grass_block')
  bot.findBlocks = ({ matching, maxDistance, count, point }) => {
    const ids = new Set([].concat(matching))
    const center = point || bot.entity.position
    const out = []
    for (const [k, n] of world) {
      if (!ids.has(bot.registry.blocksByName[n].id)) continue
      const [x, y, z] = k.split(',').map(Number)
      const p = new Vec3(x, y, z)
      if (p.distanceTo(center) <= maxDistance) out.push(p)
    }
    return out.sort((a, b) => a.distanceTo(center) - b.distanceTo(center)).slice(0, count)
  }
  bot.findBlock = (o) => { const p = bot.findBlocks({ ...o, count: 1 })[0]; return p ? bot.blockAt(p) : null }
  bot.world = {}
  const give = (name, count) => {
    const it = bot._items.find(i => i.name === name)
    if (it) it.count += count
    else bot._items.push({ name, count, type: bot.registry.itemsByName[name].id })
  }
  bot.give = give
  bot.equip = async (item) => { bot.heldItem = item }
  bot.lookAt = async () => {}
  bot.look = async () => {}
  bot.pathfinder.goto = async (goal) => {
    if (goal.kind === 'GoalBlock') { bot.entity.position = new Vec3(goal.args[0] + 0.5, goal.args[1], goal.args[2] + 0.5); return }
    // teleport next to the target so placement range checks pass
    const a = goal.args[0]
    if (a && a.x !== undefined && goal.kind === 'GoalPlaceBlock') {
      const spot = [new Vec3(2, 0, 0), new Vec3(-2, 0, 0), new Vec3(0, 0, 2), new Vec3(0, 0, -2)]
        .map(d => a.plus(d)).find(p => bot.blockAt(p).boundingBox === 'empty') || a.offset(0, 2, 2)
      bot.entity.position = new Vec3(spot.x + 0.5, Math.max(64, a.y - 1), spot.z + 0.5)
    }
  }
  bot.pathfinder.movements = { scafoldingBlocks: [] }
  bot.pathfinder.setMovements = () => {}
  bot._buildMovements = { scafoldingBlocks: [] }
  bot.placeBlock = async (ref, face) => {
    const held = bot.heldItem
    const dest = ref.position.plus(face)
    const CROP = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' }
    if (CROP[held.name]) {
      if (world.get(key(ref.position)) !== 'farmland') throw new Error('seeds need farmland')
      bot.setBlock(dest, CROP[held.name]); propsMap.set(key(dest), { age: 0 })
    } else bot.setBlock(dest, held.name)
    if (held.name === 'chest') {
      // Vanilla: a chest faces the player; it joins a same-facing single chest beside it.
      const d = bot.entity.position.floored().minus(dest)
      const facing = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 'east' : 'west') : (d.z > 0 ? 'south' : 'north')
      propsMap.set(key(dest), { facing, type: 'single' })
      for (const n of [dest.offset(1, 0, 0), dest.offset(-1, 0, 0), dest.offset(0, 0, 1), dest.offset(0, 0, -1)]) {
        const np = propsMap.get(key(n))
        const sideways = (facing === 'north' || facing === 'south') ? n.z === dest.z : n.x === dest.x
        if (np && np.type === 'single' && np.facing === facing && sideways && world.get(key(n)) === 'chest') {
          np.type = 'left'; propsMap.get(key(dest)).type = 'right'; break
        }
      }
    }
    held.count--
    if (held.count <= 0) { const ix = bot._items.indexOf(held); if (ix >= 0) bot._items.splice(ix, 1); bot.heldItem = null }
  }
  bot.dig = async (block) => { bot.setBlock(block.position, 'air') }
  const use = (name) => {
    const it = bot._items.find(i => i.name === name)
    if (!it) return
    it.count--
    if (it.count <= 0) { bot._items.splice(bot._items.indexOf(it), 1); if (bot.heldItem === it) bot.heldItem = null }
  }
  bot._use = use
  // Right-clicking: hoes till, flint and steel lights a portal frame, bone meal ripens crops.
  bot.activateBlock = async (block) => {
    const held = bot.heldItem?.name || ''
    const p = block.position
    if (/_hoe$/.test(held) && /^(grass_block|dirt)$/.test(block.name) && bot.blockAt(p.offset(0, 1, 0)).name === 'air') bot.setBlock(p, 'farmland')
    else if (held === 'bone_meal' && /^(wheat|carrots|potatoes|beetroots)$/.test(block.name)) { propsMap.set(key(p), { age: 7 }); use('bone_meal') }
    else if (held === 'flint_and_steel' && block.name === 'obsidian') {
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        if (world.get(key(p.plus(d))) !== 'obsidian' || world.get(key(p.plus(d).offset(0, 3, 0)))) continue
        for (let y = 1; y <= 3; y++) { bot.setBlock(p.offset(0, y, 0), 'nether_portal'); bot.setBlock(p.plus(d).offset(0, y, 0), 'nether_portal') }
        break
      }
    }
  }
  bot.lookAt = async (pt) => { bot._lookAt = pt }
  bot.activateItem = () => {
    if (bot.heldItem?.name === 'water_bucket' && bot._lookAt) {
      const p = bot._lookAt.floored()
      if (bot.blockAt(p).boundingBox === 'empty') { bot.setBlock(p, 'water'); use('water_bucket'); give('bucket', 1) }
    }
  }
  bot.deactivateItem = () => {}
  bot.fed = []
  bot.activateEntity = async (e) => { bot.fed.push(e.id); if (bot.heldItem) use(bot.heldItem.name) }
  // Chests and barrels: contents per block position. setChest(pos, { item: count }) fills one.
  const chests = new Map()
  bot._chests = chests
  const stackOf = (name, count) => ({ name, count, type: bot.registry.itemsByName[name].id })
  bot.setChest = (p, contents) => chests.set(key(p.floored()), Object.entries(contents).map(([n, c]) => stackOf(n, c)))
  bot.chestContents = (p) => {
    const out = {}
    for (const i of chests.get(key(p.floored())) || []) out[i.name] = (out[i.name] || 0) + i.count
    return out
  }
  bot.openContainer = async (block) => {
    const k = key(block.position)
    if (!chests.has(k)) chests.set(k, [])
    const items = chests.get(k)
    bot.currentWindow = { block }
    return {
      containerItems: () => items.filter(i => i.count > 0),
      deposit: async (type, meta, count) => {
        const name = bot.registry.items[type].name
        const have = bot._items.find(i => i.name === name)
        if (!have || have.count < count) throw new Error('not enough items')
        have.count -= count
        if (!have.count) bot._items.splice(bot._items.indexOf(have), 1)
        const slot = items.find(i => i.name === name)
        if (slot) slot.count += count; else items.push(stackOf(name, count))
      },
      withdraw: async (type, meta, count) => {
        const slot = items.find(i => i.type === type && i.count >= count)
        if (!slot) throw new Error('not enough in the chest')
        slot.count -= count
        if (!slot.count) items.splice(items.indexOf(slot), 1)
        give(slot.name, count)
      },
      close: () => { bot.currentWindow = null }
    }
  }
  bot.collectBlock.collect = async (block) => {
    bot.setBlock(block.position, 'air')
    give(block.name === 'stone' ? 'cobblestone' : block.name === 'iron_ore' ? 'raw_iron' : block.name, 1)
  }
  return bot
}

function ctxFor (bot) {
  const ex = new Executor(bot, actions)
  return { ex }
}

async function run (bot, name, args) {
  const ex = new Executor(bot, actions)
  let out = null
  ex.on('planFinished', e => { out = { ok: true, text: e.results[0] } })
  ex.on('actionFailed', e => { out = { ok: false, text: e.error } })
  ex.setPlan([{ name, args }])
  await until(() => out, 5000)
  return out
}

module.exports = { worldBot, registry, run, ctxFor }
