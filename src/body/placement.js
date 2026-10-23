'use strict'

// Placing furniture and utility blocks like a tidy player would:
//   - against a wall, never in the middle of a room or a walkway
//   - never right next to a door
//   - chests next to existing single chests so they join into double chests
//   - crafting tables, furnaces and chests grouped together
//   - facing into the room (the bot stands in front when it places them)
//   - beds against a wall with room to walk up to them

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const { goto } = require('./motion')
const { CancelledError } = require('./executor')

const UTILITY = /^(chest|trapped_chest|barrel|crafting_table|furnace|blast_furnace|smoker|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|smithing_table|cartography_table|fletching_table|loom|stonecutter|grindstone|composter|lectern|.*_bed|jukebox|ender_chest)$/
const HORIZONTAL = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const DIR_BY_NAME = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) }

const isAir = (b) => !!b && (b.name === 'air' || b.name === 'cave_air' || (b.boundingBox === 'empty' && !T.isLiquid(b) && !/door|torch|rail|sign|button|lever|pressure_plate/.test(b.name)))
const isDoor = (b) => !!b && /_door$|_gate$/.test(b.name)

function isUtility (name) {
  return UTILITY.test(name)
}

// Can a player stand at p? (floor below, two free blocks)
function walkable (bot, p) {
  return T.isFirm(bot.blockAt(p.offset(0, -1, 0))) && isAir(bot.blockAt(p)) && isAir(bot.blockAt(p.offset(0, 1, 0)))
}

function nearDoor (bot, p, radius = 2) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.abs(dx) + Math.abs(dz) > radius) continue
      for (let dy = -1; dy <= 1; dy++) if (isDoor(bot.blockAt(p.offset(dx, dy, dz)))) return true
    }
  }
  return false
}

function props (b) {
  try { return b.getProperties ? b.getProperties() : {} } catch { return {} }
}

// Score a spot for a utility block. Lower is better; null = unusable.
// Returns { pos, front, score }.
function evaluateSpot (bot, p, { origin, inZone, memory }) {
  if (!isAir(bot.blockAt(p)) || !T.isFirm(bot.blockAt(p.offset(0, -1, 0)))) return null
  if (!isAir(bot.blockAt(p.offset(0, 1, 0)))) return null // chests need room to open; keeps headroom
  if (nearDoor(bot, p)) return null
  const walls = HORIZONTAL.filter(d => T.isFirm(bot.blockAt(p.plus(d))))
  if (!walls.length) return null // middle of the room or the open field
  // A one-wide corridor (walls on opposite sides) is a walkway: don't block it.
  if (walls.some(a => walls.some(b => a.x === -b.x && a.z === -b.z && (a.x !== 0 || a.z !== 0)))) return null
  // Need a free spot in front to stand on and use it.
  const fronts = walls.map(w => w.scaled(-1)).filter(d => walkable(bot, p.plus(d)))
  if (!fronts.length) return null
  const front = fronts[0]
  // Don't wall off the only way past: the cells beside the spot (along the wall) should stay walkable
  // or be walls/furniture themselves.
  let score = p.distanceTo(origin)
  if (walls.length === 2) score -= 2 // corners are nice
  if (inZone && !Z.zoneAt(memory, p)) score += 50 // stay inside the base if we're in one
  return { pos: p, front, score }
}

// Utility neighbours that make a nice "work area".
const GROUP = /^(crafting_table|furnace|blast_furnace|smoker|chest|barrel|anvil|smithing_table|stonecutter)$/

function findSpots (bot, itemName, { memory, radius = 7 } = {}) {
  const me = bot.entity.position.floored()
  const inZone = !!Z.zoneAt(memory, me)
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = me.offset(dx, dy, dz)
        if (p.equals(me) || p.equals(me.offset(0, 1, 0))) continue
        const spot = evaluateSpot(bot, p, { origin: me, inZone, memory })
        if (!spot) continue
        // Bonus for joining the existing work area.
        let near = 0
        for (let ex = -2; ex <= 2; ex++) {
          for (let ez = -2; ez <= 2; ez++) {
            const b = bot.blockAt(p.offset(ex, 0, ez))
            if (b && GROUP.test(b.name)) near++
          }
        }
        spot.score -= Math.min(near, 3) * 2
        out.push(spot)
      }
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

// Spots next to an existing single chest that would turn it into a double chest.
function chestPartnerSpots (bot, { memory, radius = 10 } = {}) {
  const ids = ['chest', 'trapped_chest'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 30 })
  const out = []
  for (const cp of found) {
    const chest = bot.blockAt(cp)
    const pr = props(chest)
    if (pr.type && pr.type !== 'single') continue
    const facing = DIR_BY_NAME[pr.facing]
    if (!facing) continue
    const side = new Vec3(-facing.z, 0, facing.x) // either side along the chest's "width"
    for (const s of [side, side.scaled(-1)]) {
      const p = cp.plus(s)
      if (!isAir(bot.blockAt(p)) || !T.isFirm(bot.blockAt(p.offset(0, -1, 0)))) continue
      if (!isAir(bot.blockAt(p.offset(0, 1, 0)))) continue
      // Another single chest on the far side would join the wrong way; skip.
      const beyond = bot.blockAt(p.plus(s))
      if (beyond && /chest$/.test(beyond.name) && chest.name === beyond.name) continue
      if (!walkable(bot, p.plus(facing))) continue
      out.push({ pos: p, front: facing, score: p.distanceTo(bot.entity.position) - 10, partnerOf: cp, chestName: chest.name })
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

// Bed spots: foot cell + head cell (head against a wall), with room to stand at the foot.
function bedSpots (bot, { memory, radius = 7 } = {}) {
  const me = bot.entity.position.floored()
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const head = me.offset(dx, dy, dz)
        for (const d of HORIZONTAL) { // d = direction the bed points (foot -> head)
          if (!T.isFirm(bot.blockAt(head.plus(d)))) continue // head against a wall
          const foot = head.minus(d)
          const stand = foot.minus(d)
          const ok = [head, foot].every(p => isAir(bot.blockAt(p)) && isAir(bot.blockAt(p.offset(0, 1, 0))) && T.isFirm(bot.blockAt(p.offset(0, -1, 0))))
          if (!ok || !walkable(bot, stand) || nearDoor(bot, foot) || nearDoor(bot, head)) continue
          if (head.equals(me) || foot.equals(me)) continue
          out.push({ pos: foot, head, dir: d, stand, score: foot.distanceTo(me) })
        }
      }
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

// Place a block at pos so it faces `front` (the bot stands in front of it, looking at it).
async function placeFacing (ctx, pos, itemName, front) {
  const { bot } = ctx
  const below = bot.blockAt(pos.offset(0, -1, 0))
  if (!T.isFirm(below)) return false
  let stand = pos.plus(front)
  if (!walkable(bot, stand) && walkable(bot, pos.plus(front.scaled(2)))) stand = pos.plus(front.scaled(2))
  await goto(ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), 45000)
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) throw new Error(`I don't have a ${itemName}`)
  await bot.equip(item, 'hand')
  // Look at the spot from the front so the block faces us (into the room).
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
  try {
    await ctx.race(bot.placeBlock(below, new Vec3(0, 1, 0)), 6000)
  } catch (err) {
    if (err instanceof CancelledError) throw err
  }
  await ctx.sleep(80)
  const after = bot.blockAt(pos)
  return !!after && after.name !== 'air' && !T.isLiquid(after)
}

// Main entry: place a utility block somewhere sensible near the bot. Returns the placed block.
async function placeUtility (ctx, itemName, { memory } = {}) {
  const { bot } = ctx
  let candidates
  if (/_bed$/.test(itemName)) {
    candidates = bedSpots(bot, { memory }).slice(0, 6).map(s => ({ pos: s.pos, front: s.dir.scaled(-1), stand: s.stand }))
  } else if (/^(chest|trapped_chest)$/.test(itemName)) {
    candidates = [...chestPartnerSpots(bot, { memory }).filter(s => s.chestName === itemName), ...findSpots(bot, itemName, { memory })].slice(0, 8)
  } else {
    candidates = findSpots(bot, itemName, { memory }).slice(0, 8)
  }
  for (const c of candidates) {
    ctx.check()
    try {
      if (await placeFacing(ctx, c.pos, itemName, c.front)) return bot.blockAt(c.pos)
    } catch (err) {
      if (err instanceof CancelledError || /don't have/.test(err.message)) throw err
    }
  }
  return null
}

module.exports = { placeUtility, placeFacing, findSpots, chestPartnerSpots, bedSpots, isUtility, walkable, evaluateSpot, DIR_BY_NAME }
