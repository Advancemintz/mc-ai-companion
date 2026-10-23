'use strict'

// Low-level movement and placement helpers shared by actions and the base builder.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const T = require('./terrain')
const { CancelledError } = require('./executor')

async function goto (ctx, goal, timeoutMs = 120000) {
  const { bot } = ctx
  try {
    await ctx.race(bot.pathfinder.goto(goal), timeoutMs)
  } catch (err) {
    if (err instanceof CancelledError) throw err
    try { bot.pathfinder.stop() } catch {}
    const tag = `${err.name} ${err.message}`
    if (/NoPath|No path/i.test(tag)) throw new Error('no path to the destination')
    if (/Timeout|too long|timed out/i.test(tag)) throw new Error('could not get there in time (probably unreachable)')
    if (/GoalChanged|PathStopped/i.test(tag)) throw new Error('movement was interrupted')
    throw err
  }
}

const SOLID = (b) => b && b.boundingBox === 'block'

const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern',
  'large_fern', 'dead_bush', 'snow', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'fire'
])

// Place one item at pos, walking into range if needed.
// solid=false is for torches, doors, beds, chests: anything that isn't a plain full block.
// Returns 'placed' | 'exists' | 'no-support' | 'blocked'.
async function placeAt (ctx, pos, itemName, { solid = true, refDirs = null } = {}) {
  const { bot } = ctx
  const cur = bot.blockAt(pos)
  if (!cur) throw new Error('that location is not loaded')
  if (T.isFirm(cur)) return 'exists'
  if (!solid && cur.name !== 'air' && cur.name !== 'cave_air' && !REPLACEABLE.has(cur.name) && !T.isLeaves(cur)) return 'exists'

  // Clear flowers, torches, leaves etc. that would block placement.
  if (!REPLACEABLE.has(cur.name) && (cur.boundingBox === 'empty' || T.isLeaves(cur)) && cur.diggable) {
    await goto(ctx, new goals.GoalLookAtBlock(pos, bot.world), 30000)
    await ctx.race(bot.dig(cur), 10000)
  }

  // refDirs: which neighbour(s) to attach to (ladders and wall torches need a wall, not the floor).
  const dirs = refDirs || [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
  let ref = null
  for (const d of dirs) {
    const b = bot.blockAt(pos.plus(d))
    if (SOLID(b)) { ref = b; break }
  }
  if (!ref) return 'no-support'

  const feet = bot.entity.position.floored()
  const standingIn = feet.x === pos.x && feet.z === pos.z && (feet.y === pos.y || feet.y === pos.y - 1)
  const eyes = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
  const far = eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3
  if (standingIn || far) {
    await goto(ctx, new goals.GoalPlaceBlock(pos, bot.world, { range: 4.3, LOS: false }), 45000)
  }

  // Something (a mob, the player) standing in the spot blocks placement.
  const occupied = Object.values(bot.entities).some(e => e !== bot.entity && (W.isMob(e) || e.type === 'player') &&
    Math.floor(e.position.x) === pos.x && Math.floor(e.position.z) === pos.z &&
    Math.abs(e.position.y - pos.y) < 2)
  if (occupied) return 'blocked'

  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) throw new Error(`ran out of ${itemName}`)
  if (bot.heldItem?.name !== itemName) await bot.equip(item, 'hand')
  try {
    await ctx.race(bot.placeBlock(ref, pos.minus(ref.position)), 6000)
  } catch (err) {
    if (err instanceof CancelledError) throw err
  }
  await ctx.sleep(60)
  const after = bot.blockAt(pos)
  if (solid) return T.isFirm(after) ? 'placed' : 'blocked'
  return after && after.name !== 'air' && after.name !== 'cave_air' && !T.isLiquid(after) ? 'placed' : 'blocked'
}

module.exports = { goto, placeAt, SOLID, REPLACEABLE }
