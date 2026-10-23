'use strict'

// Reading the shape of the land: am I underground? where is the surface?
// where is a flat, open spot to build on?

const { Vec3 } = require('vec3')

const isLeaves = (b) => b && (b.name.endsWith('_leaves') || b.name === 'mangrove_roots')
const isLog = (b) => b && (/_(log|wood|stem|hyphae)$/.test(b.name))
const isLiquid = (b) => b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column')
// "Firm" ground or wall: a full block that isn't foliage.
const isFirm = (b) => !!b && b.boundingBox === 'block' && !isLeaves(b)

// Blocks the bot may dig away to clear a building site.
const CLEARABLE = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|sweet_berry_bush|.*_leaves|.*_sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|moss_carpet|dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|sand|red_sand|gravel|clay|stone|andesite|diorite|granite|tuff|deepslate|cobblestone|moss_block|mud|snow_block|.*_log|.*_mushroom|brown_mushroom|red_mushroom)$/

function canClear (b) {
  return !b || b.name === 'air' || b.name === 'cave_air' || CLEARABLE.test(b.name)
}

// How much is above the bot's head? Returns { kind, rockAbove, y }.
//   kind: 'outdoors' | 'under trees' | 'indoors' | 'underground'
function cover (bot, pos = bot.entity.position) {
  const base = pos.floored()
  let solid = 0
  let leaves = 0
  let firstSolid = null
  for (let dy = 2; dy <= 64; dy++) {
    const b = bot.blockAt(base.offset(0, dy, 0))
    if (!b) break // above the world or not loaded
    if (isLeaves(b)) { leaves++; continue }
    if (b.boundingBox === 'block') {
      solid++
      if (firstSolid === null) firstSolid = dy
    }
  }
  let kind = 'outdoors'
  if (solid === 0) kind = leaves ? 'under trees' : 'outdoors'
  else if (solid <= 2 && firstSolid <= 6) kind = 'indoors'
  else kind = 'underground'
  return { kind, rockAbove: solid, y: base.y }
}

function describeCover (bot) {
  const c = cover(bot)
  const depth = c.y < 0 ? ' (deep: diamond level)' : c.y < 50 ? ' (below sea level)' : ''
  if (c.kind === 'underground') return `underground, about ${c.rockAbove} blocks of rock/earth overhead, y=${c.y}${depth}`
  if (c.kind === 'indoors') return `under a roof (indoors or under an overhang), y=${c.y}`
  if (c.kind === 'under trees') return `outdoors under tree leaves, y=${c.y}`
  return `outdoors under open sky, y=${c.y}${depth}`
}

// Ground info for one column near a reference height.
// Returns null if there is no usable open-sky ground within +-range of refY.
function columnInfo (bot, x, z, refY, range = 10) {
  let ground = null
  for (let y = refY + range; y >= refY - range; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) continue
    if (isFirm(b) && !isLog(b)) { ground = b; break }
    if (isLiquid(b)) return { water: true, y }
  }
  if (!ground) return null
  const gy = ground.position.y
  // Sky check: nothing firm (other than leaves/logs of trees) above the ground.
  let roofed = false
  let trees = 0
  for (let y = gy + 1; y <= gy + 40; y++) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) break
    if (isLeaves(b) || isLog(b)) { trees++; continue }
    if (isFirm(b)) { roofed = true; break }
  }
  return { y: gy, block: ground.name, roofed, trees }
}

// Find the nearest column within radius that has open sky above its ground.
function findSurface (bot, radius = 16) {
  const p = bot.entity.position.floored()
  let best = null
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const info = columnInfo(bot, p.x + dx, p.z + dz, p.y + 40, 80)
        if (!info || info.water || info.roofed) continue
        const cost = Math.hypot(dx, dz) + Math.max(0, info.y - p.y) * 0.5
        if (!best || cost < best.cost) best = { pos: new Vec3(p.x + dx, info.y + 1, p.z + dz), cost }
      }
    }
    if (best && r >= 3) break // good enough, stop widening
  }
  return best?.pos || null
}

// Find a flat, open, dry spot for a structure footprint.
// cells: [[right, forward], ...] relative to the origin; f/r: facing unit vectors.
// height: how many blocks of clearance the structure needs above the ground.
// Returns { origin (first building layer), groundY, fills, digs, score } or null.
function findBuildSite (bot, { cells, f, r, height, radius = 16 }) {
  const me = bot.entity.position.floored()
  const cache = new Map()
  const col = (x, z) => {
    const k = x + ',' + z
    if (!cache.has(k)) cache.set(k, columnInfo(bot, x, z, me.y, 12))
    return cache.get(k)
  }
  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))

  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const ox = me.x + dx
      const oz = me.z + dz
      const center = col(ox, oz)
      if (!center || center.water || center.roofed) continue
      const gy = center.y
      if (Math.abs(gy - (me.y - 1)) > 8) continue

      let fills = 0; let digs = 0; let trees = 0; let ok = true
      for (const [ri, fi] of cells) {
        const x = ox + r.x * ri + f.x * fi
        const z = oz + r.z * ri + f.z * fi
        const c = col(x, z)
        if (!c || c.water || c.roofed) { ok = false; break }
        const diff = c.y - gy
        if (diff < -2 || diff > 1) { ok = false; break }
        if (diff < 0) fills += -diff
        if (diff > 0) digs += diff
        // Clearance above the base level.
        for (let h = 1; h <= height; h++) {
          const b = blockAt(x, gy + h, z)
          if (!b) { ok = false; break }
          if (b.name === 'air' || b.name === 'cave_air') continue
          if (isLiquid(b) || !canClear(b)) { ok = false; break }
          if (isLog(b)) trees += 3
          else if (b.boundingBox === 'block') digs++
          else trees += 0.2 // plants: cheap
        }
        if (!ok) break
      }
      if (!ok) continue
      // Prefer spots a little way off, so the bot isn't standing inside its own walls.
      const dist = Math.hypot(dx, dz)
      const onTop = cells.some(([ri, fi]) => ox + r.x * ri + f.x * fi === me.x && oz + r.z * ri + f.z * fi === me.z)
      const score = dist * 0.6 + fills * 1.5 + digs * 2 + trees + (onTop ? 4 : 0)
      if (!best || score < best.score) {
        best = { origin: new Vec3(ox, gy + 1, oz), groundY: gy, fills, digs, score }
      }
    }
  }
  return best
}

module.exports = { cover, describeCover, columnInfo, findSurface, findBuildSite, isFirm, isLeaves, isLog, isLiquid, canClear }
