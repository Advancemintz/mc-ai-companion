'use strict'

// Everyday survival habits every player picks up: getting out of lava and fire, not suffocating,
// cutting free of cobwebs, cooking food, keeping gear up to date (and replacing it before it
// breaks), putting loot away at home, and sleeping at night.
//
// The hazard checks run as a reflex (src/body/reflexes.js); the rest are actions and helpers
// the brain, needs and autopilot use.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const T = require('./terrain')
const { CancelledError } = require('./executor')

const sleepMs = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const countMatch = (bot, re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)

// ------------------------------------------------------------------ hazards

const FIRE = /^(fire|soul_fire|lava|magma_block|campfire|soul_campfire)$/
const DANGER_FLOOR = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow|pointed_dripstone)$/

// A whole block (sand or gravel that fell on you), not a slab, stair or fence you're standing under.
function fullCube (b) {
  if (!b.shapes) return true
  return b.shapes.length === 1 && b.shapes[0].every((v, i) => v === (i < 3 ? 0 : 1))
}

function isBurning (bot) {
  const flags = bot.entity?.metadata?.[0]
  return typeof flags === 'number' && (flags & 0x01) === 0x01
}

// What's wrong right now, if anything: { kind: 'lava'|'fire'|'suffocating'|'cobweb', ... } or null.
function hazard (bot) {
  if (!bot.entity) return null
  const feetPos = bot.entity.position.floored()
  const feet = bot.blockAt(feetPos)
  const head = bot.blockAt(feetPos.offset(0, 1, 0))
  if (!feet || !head) return null
  if (feet.name === 'lava' || head.name === 'lava') return { kind: 'lava', at: feetPos }
  if (/^(fire|soul_fire)$/.test(feet.name) || isBurning(bot)) return { kind: 'fire', at: feetPos }
  if (feet.name === 'cobweb' || head.name === 'cobweb') return { kind: 'cobweb', block: feet.name === 'cobweb' ? feet : head }
  if (head.boundingBox === 'block' && fullCube(head) && !/(_leaves|glass|scaffolding|_slab|_stairs)$/.test(head.name)) return { kind: 'suffocating', block: head }
  return null
}

// A nearby spot where you can stand safely: firm floor, room for your head, no lava next to it.
function safeSpot (bot, from, radius = 5) {
  const out = []
  const ok = (p) => {
    const floor = bot.blockAt(p.offset(0, -1, 0))
    const feet = bot.blockAt(p)
    const head = bot.blockAt(p.offset(0, 1, 0))
    if (!floor || !feet || !head) return false
    if (!T.isFirm(floor) || DANGER_FLOOR.test(floor.name)) return false
    if (feet.boundingBox === 'block' || head.boundingBox === 'block') return false
    if (FIRE.test(feet.name) || FIRE.test(head.name) || feet.name === 'cobweb') return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (bot.blockAt(p.offset(dx, 0, dz))?.name === 'lava' || bot.blockAt(p.offset(dx, -1, dz))?.name === 'lava') return false
    }
    return true
  }
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (const dy of [0, 1, -1, 2]) {
          const p = from.offset(dx, dy, dz)
          if (ok(p)) out.push(p)
        }
      }
    }
    if (out.length) break
  }
  return out.sort((a, b) => a.distanceTo(from) - b.distanceTo(from))[0] || null
}

// Push toward a spot with plain controls (pathfinding doesn't work well from inside lava).
async function scramble (bot, spot, ms = 3000) {
  const target = spot.offset(0.5, 0, 0.5)
  const started = Date.now()
  try {
    while (Date.now() - started < ms) {
      await bot.lookAt(target.offset(0, 1.2, 0), true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.setControlState('jump', true)
      await sleepMs(100)
      if (bot.entity.position.distanceTo(target) < 0.8) break
      const h = hazard(bot)
      if (!h || h.kind !== 'lava') { await sleepMs(250); break }
    }
  } finally {
    for (const k of ['forward', 'sprint', 'jump']) { try { bot.setControlState(k, false) } catch {} }
  }
}

// Put out flames with a water bucket at your feet, then scoop the water back up.
async function douse (bot) {
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!bucket) return false
  try {
    await bot.equip(bucket, 'hand')
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.activateItem()
    await sleepMs(700)
    const empty = bot.inventory.items().find(i => i.name === 'bucket')
    if (empty) { await bot.equip(empty, 'hand'); bot.activateItem(); await sleepMs(200) }
    return true
  } catch { return false }
}

// Deal with a hazard. Returns a short description of what was done.
async function escape (bot, h) {
  try { bot.pathfinder?.setGoal(null) } catch {}
  if (h.kind === 'lava') {
    const spot = safeSpot(bot, h.at, 6)
    if (spot) await scramble(bot, spot, 3500)
    else { bot.setControlState('jump', true); await sleepMs(1200); bot.setControlState('jump', false) }
    if (isBurning(bot)) await douse(bot)
    return spot ? 'scrambled out of lava' : 'tried to swim up out of lava'
  }
  if (h.kind === 'fire') {
    if (await douse(bot)) return 'put the flames out with a water bucket'
    const ids = ['water'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
    const water = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 10, count: 8 }).find(p => bot.blockAt(p.offset(0, 1, 0))?.boundingBox !== 'block') : null
    if (water) {
      try { await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(water.x, water.y, water.z)), sleepMs(5000)]) } catch {}
      return 'ran into water to put out the flames'
    }
    const spot = safeSpot(bot, h.at, 4)
    if (spot) await scramble(bot, spot, 1500)
    return 'got off the fire'
  }
  if (h.kind === 'cobweb') {
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name)) || bot.inventory.items().find(i => i.name === 'shears')
    if (sword) { try { await bot.equip(sword, 'hand') } catch {} }
    try { await Promise.race([bot.dig(h.block, true), sleepMs(4000)]) } catch {}
    return 'cut free of a cobweb'
  }
  if (h.kind === 'suffocating') {
    try {
      if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(h.block, {})
      await Promise.race([bot.dig(h.block, true), sleepMs(4000)])
      return `dug out of a ${h.block.name} that was smothering it`
    } catch {
      return 'was stuck in a block'
    }
  }
  return 'dealt with a hazard'
}

// ------------------------------------------------------------------ food

const RAW_FOOD = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp'
}

function rawFood (bot) {
  const out = {}
  for (const i of bot.inventory.items()) if (RAW_FOOD[i.name]) out[i.name] = (out[i.name] || 0) + i.count
  // Keep a few potatoes for planting.
  if (out.potato) { out.potato = Math.max(0, out.potato - 4); if (!out.potato) delete out.potato }
  return out
}

// Hunger points in pockets from cooked / ready-to-eat food (raw meat doesn't count).
function readyFood (bot) {
  const foods = bot.registry.foodsByName || {}
  return bot.inventory.items().filter(i => foods[i.name] && !RAW_FOOD[i.name] && !W.BAD_FOOD.has(i.name))
    .reduce((n, i) => n + foods[i.name].foodPoints * i.count, 0)
}

// ------------------------------------------------------------------ gear

const TOOL_KINDS = ['pickaxe', 'sword', 'axe', 'shovel']
const ARMOR_KINDS = ['helmet', 'chestplate', 'leggings', 'boots']
const RANK = { wooden: 1, golden: 1, leather: 1, stone: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 }
const COST = { pickaxe: 3, axe: 3, sword: 2, shovel: 1, helmet: 5, chestplate: 8, leggings: 7, boots: 4 }
const STICKS = { pickaxe: 2, axe: 2, sword: 1, shovel: 2 }
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

const materialOf = (name) => (name.match(/^(netherite|diamond|iron|stone|golden|wooden|leather|chainmail)_/) || [])[1] || null
const kindOf = (name) => [...TOOL_KINDS, ...ARMOR_KINDS].find(k => name.endsWith('_' + k)) || null

function durability (bot, item) {
  const max = bot.registry.items[item.type]?.maxDurability
  if (!max) return null
  const used = item.durabilityUsed ?? 0
  return { left: max - used, max, share: (max - used) / max }
}

// Tools and armour that are about to break.
function wornGear (bot) {
  const all = [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots?.[s]).filter(Boolean)]
  const out = []
  for (const it of all) {
    if (!kindOf(it.name) && it.name !== 'shield' && it.name !== 'bow') continue
    const d = durability(bot, it)
    if (d && (d.share < 0.12 || d.left < 12)) out.push({ name: it.name, left: d.left, item: it })
  }
  return out
}

function owned (bot, kind) {
  const all = [...bot.inventory.items(), ...[5, 6, 7, 8].map(s => bot.inventory.slots?.[s]).filter(Boolean)]
  let best = null
  for (const it of all) {
    if (kindOf(it.name) !== kind) continue
    const r = RANK[materialOf(it.name)] || 0
    const d = durability(bot, it)
    if (!best || r > best.rank) best = { name: it.name, rank: r, worn: d ? (d.share < 0.12 || d.left < 12) : false }
  }
  return best
}

// Raw materials on hand for each tier.
function materials (bot) {
  return {
    diamond: count(bot, 'diamond'),
    iron: count(bot, 'iron_ingot'),
    stone: count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate') + count(bot, 'blackstone'),
    wooden: countMatch(bot, /_planks$/) + countMatch(bot, /_log$|_stem$/) * 4,
    leather: count(bot, 'leather'),
    sticks: count(bot, 'stick')
  }
}

// What to craft: better than what you have, or a fresh copy of something about to break.
// Returns [{ item, why }] in a sensible order (pickaxe first, then weapon, then armour).
function gearPlan (bot) {
  const mats = materials(bot)
  let sticks = mats.sticks + Math.floor(mats.wooden / 2) * 4 // planks can become sticks
  const plan = []
  const spend = (mat, n) => { mats[mat] -= n; if (mat === 'wooden') sticks = mats.sticks + Math.floor(mats.wooden / 2) * 4 }
  const tierFor = (kind, list) => list.find(m => mats[m] >= COST[kind] + (m === 'wooden' && STICKS[kind] ? 1 : 0))
  // The order a player cares about: something to dig with, something to fight with, then the
  // armour that protects most, then the rest.
  for (const kind of ['pickaxe', 'sword', 'chestplate', 'leggings', 'axe', 'helmet', 'boots', 'shovel']) {
    const have = owned(bot, kind)
    const armour = ARMOR_KINDS.includes(kind)
    const mat = tierFor(kind, armour ? ['diamond', 'iron', 'leather'] : ['diamond', 'iron', 'stone', 'wooden'])
    if (!mat || (!armour && sticks < (STICKS[kind] || 0))) continue
    const r = RANK[mat]
    if (kind === 'shovel' && !have && r < 2) continue // a wooden shovel isn't worth it
    if (kind === 'axe' && !have && r < 3 && owned(bot, 'sword')) continue
    if (!have || r > have.rank || (have.worn && r >= have.rank)) {
      plan.push({ item: `${mat}_${kind}`, why: !have ? (armour ? 'no armour there yet' : 'none yet') : r > have.rank ? `better than ${have.name}` : `${have.name} is nearly broken` })
      spend(mat, COST[kind])
      if (!armour) sticks -= STICKS[kind] || 0
    }
  }
  if (!bot.inventory.items().some(i => i.name === 'shield') && bot.inventory.slots?.[45]?.name !== 'shield' && mats.iron >= 1 && mats.wooden >= 6) {
    plan.push({ item: 'shield', why: 'blocks arrows and hits' })
  }
  return plan
}

// What would come next if the bot had a bit more (for the needs list).
function nextGearHint (bot) {
  const pick = owned(bot, 'pickaxe')
  const mats = materials(bot)
  if (!pick) return 'a pickaxe (3 planks + 2 sticks)'
  if (pick.rank < 2) return `a stone pickaxe (${Math.max(0, 3 - mats.stone)} more cobblestone)`
  if (pick.rank < 3) return `an iron pickaxe (${Math.max(0, 3 - mats.iron)} more iron ingots)`
  const chest = owned(bot, 'chestplate')
  if (!chest || chest.rank < 3) return `iron armour (${Math.max(0, 24 - mats.iron)} more iron ingots for a full set)`
  if (pick.rank < 4) return `a diamond pickaxe (${Math.max(0, 3 - mats.diamond)} more diamonds)`
  return null
}

async function equipBestArmour (bot) {
  const done = []
  for (const kind of ARMOR_KINDS) {
    const slot = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 }[kind]
    const cur = bot.inventory.slots?.[slot]
    const best = bot.inventory.items().filter(i => kindOf(i.name) === kind)
      .sort((a, b) => (RANK[materialOf(b.name)] || 0) - (RANK[materialOf(a.name)] || 0))[0]
    if (best && (!cur || (RANK[materialOf(best.name)] || 0) > (RANK[materialOf(cur.name)] || 0))) {
      try { await bot.equip(best, ARMOR_SLOT[kind]); done.push(best.name) } catch {}
    }
  }
  const shield = bot.inventory.items().find(i => i.name === 'shield')
  if (shield && bot.inventory.slots?.[45]?.name !== 'shield') { try { await bot.equip(shield, 'off-hand'); done.push('shield') } catch {} }
  return done
}

// ------------------------------------------------------------------ loot and home

const KEEP = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|arrow|torch|water_bucket|bucket|flint_and_steel|shears|fishing_rod|.*_bed|crafting_table|furnace)$/

// How much stuff in pockets would go into a chest (not gear, food, or a few building blocks).
function lootCount (bot) {
  const foods = bot.registry.foodsByName || {}
  return bot.inventory.items().filter(i => !KEEP.test(i.name) && !foods[i.name]).reduce((n, i) => n + i.count, 0)
}

// ------------------------------------------------------------------ actions

function act () { return require('./actions').actions }

const cookAction = {
  description: 'Cook the raw food you carry (beef, pork, chicken, mutton, rabbit, fish, potatoes, kelp) so it fills you up properly. Uses a smoker if there is one (twice as fast), otherwise a furnace; places one you carry if needed.',
  params: {},
  timeoutSeconds: 900,
  run: async (ctx) => {
    const raw = rawFood(ctx.bot)
    const kinds = Object.keys(raw)
    if (!kinds.length) throw new Error('I have nothing raw to cook')
    const done = []
    for (const k of kinds) {
      ctx.check()
      try {
        const res = await act().smelt.run(ctx, { item: k, count: Math.min(64, raw[k]) })
        done.push(res.replace(/^smelted /, ''))
      } catch (err) {
        if (err instanceof CancelledError) throw err
        if (!done.length) throw err
        done.push(`couldn't cook the ${k}: ${err.message}`)
        break
      }
    }
    return `cooked ${done.join('; ')}`
  }
}

const upgradeGearAction = {
  description: 'Look over your tools and armour and craft better ones from the materials you carry (stone, iron, diamond), replace anything about to break, make a shield, and put on the best armour. Reports what you would need for the next upgrade.',
  params: {},
  timeoutSeconds: 300,
  run: async (ctx) => {
    const { bot } = ctx
    const made = []
    const failed = []
    for (let pass = 0; pass < 2; pass++) {
      const plan = gearPlan(bot).filter(p => !made.includes(p.item) && !failed.includes(p.item))
      if (!plan.length) break
      for (const p of plan) {
        ctx.check()
        // Sticks and planks first, like anyone would.
        const kind = kindOf(p.item)
        const needSticks = STICKS[kind] || 0
        try {
          if (needSticks && count(bot, 'stick') < needSticks) {
            if (!countMatch(bot, /_planks$/)) await act().craft.run(ctx, { item: 'planks', count: 4 })
            await act().craft.run(ctx, { item: 'stick', count: 4 })
          }
          if ((/^wooden_/.test(p.item) || p.item === 'shield') && countMatch(bot, /_planks$/) < 6 && countMatch(bot, /_log$|_stem$/)) {
            await act().craft.run(ctx, { item: 'planks', count: 8 })
          }
          await act().craft.run(ctx, { item: p.item, count: 1 })
          made.push(p.item)
          ctx.skills?.award(/sword|helmet|chestplate|leggings|boots|shield/.test(p.item) ? 'combat' : 'mining', 1)
        } catch (err) {
          if (err instanceof CancelledError) throw err
          failed.push(p.item)
        }
      }
    }
    const worn = await equipBestArmour(bot)
    const hint = nextGearHint(bot)
    if (!made.length && !worn.length) {
      return `nothing to upgrade right now${hint ? `; next up: ${hint}` : ''}${failed.length ? ` (tried ${failed.join(', ')} but was missing something)` : ''}`
    }
    return `${made.length ? `crafted ${made.join(', ')}` : 'crafted nothing new'}${worn.length ? `; now wearing ${worn.join(', ')}` : ''}${hint ? `. Next up: ${hint}` : ''}`
  }
}

module.exports = {
  hazard,
  isBurning,
  safeSpot,
  escape,
  douse,
  RAW_FOOD,
  rawFood,
  readyFood,
  durability,
  wornGear,
  owned,
  materials,
  gearPlan,
  nextGearHint,
  equipBestArmour,
  lootCount,
  KEEP,
  cookAction,
  upgradeGearAction
}
