'use strict'

// The base builder: blueprints + a resumable engine that turns them into blocks.
//
// A blueprint is a list of cells, each with a position and a ROLE:
//   air       must be empty (dug out if needed)
//   doortop   upper half of a door (kept empty)
//   floor / wall / roof / frame   structural blocks (material picked from inventory)
//   support   fill only if it's a hole (keeps things from floating; uses cheap blocks)
//   shell     fill only if it's not solid (seals caves, water and lava around tunnels)
//   window / door / light   optional details (glass, doors, torches)
//   furniture placed if the bot carries it (crafting_table, furnace, chest, bed)
//
// The engine always compares the blueprint with the world as it is now, so running it
// again simply continues where it stopped (after a fight, at night, or after gathering).

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const T = require('./terrain')
const { goto, placeAt } = require('./motion')
const { placeFacing } = require('./placement')
const { CancelledError } = require('./executor')

// ------------------------------------------------------------------ materials

const PALETTE = {
  wall: [/_planks$/, 'cobblestone', 'stone_bricks', 'bricks', 'mud_bricks', 'cobbled_deepslate', 'deepslate_bricks', 'stone', 'sandstone', 'andesite', 'diorite', 'granite', 'tuff', 'dirt'],
  floor: ['cobblestone', 'stone_bricks', 'stone', 'cobbled_deepslate', /_planks$/, 'bricks', 'deepslate_bricks', 'sandstone', 'andesite', 'diorite', 'granite', 'tuff', 'dirt'],
  roof: [/_planks$/, 'cobblestone', 'stone_bricks', 'bricks', 'cobbled_deepslate', 'stone', 'sandstone', 'andesite', 'diorite', 'granite', 'tuff', 'dirt'],
  frame: [/^(?!stripped_).*_log$/, /^stripped_.*_log$/, /_wood$/, 'stone_bricks', 'cobblestone', /_planks$/, 'cobbled_deepslate', 'stone', 'dirt'],
  fill: ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', /_planks$/],
  window: ['glass', /_stained_glass$/, 'glass_pane', /_stained_glass_pane$/, 'tinted_glass'],
  door: [/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_door$/],
  light: ['torch', 'lantern', 'soul_torch']
}
PALETTE.support = PALETTE.fill
PALETTE.shell = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'netherrack', 'coarse_dirt']

const STRUCT = new Set(['floor', 'wall', 'roof', 'frame'])
const FILLERS = new Set(['support', 'shell'])
const OPTIONAL = new Set(['window', 'door', 'light', 'furniture', 'ladder'])
const EMPTY = new Set(['air', 'doortop'])

// Natural terrain the builder may dig away (never player-made blocks).
const NATURAL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|mud|sand|red_sand|gravel|clay|stone|andesite|diorite|granite|tuff|calcite|deepslate|cobblestone|cobbled_deepslate|netherrack|snow|snow_block|moss_block|moss_carpet|.*_ore|.*terracotta|sandstone|red_sandstone|dripstone_block|pointed_dripstone|smooth_basalt|blackstone|basalt|soul_sand|soul_soil|ice|packed_ice|.*_log|.*_wood|.*_leaves|.*_sapling|short_grass|grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|sweet_berry_bush|.*_mushroom|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|bush|firefly_bush|leaf_litter|cave_vines|cave_vines_plant|hanging_roots|spore_blossom|amethyst_block|budding_amethyst|.*amethyst_bud|amethyst_cluster|cobweb|bone_block|obsidian|magma_block|infested_.*|seagrass|tall_seagrass|kelp|kelp_plant|sugar_cane|cactus|bamboo|pumpkin|melon|big_dripleaf|big_dripleaf_stem|small_dripleaf|azalea|flowering_azalea|mossy_cobblestone)$/

function matches (name, entry) {
  return typeof entry === 'string' ? name === entry : entry.test(name)
}

function inventoryCounts (bot) {
  const counts = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
  return counts
}

function pickMaterial (bot, role, counts = inventoryCounts(bot)) {
  for (const entry of PALETTE[role] || []) {
    const name = Object.keys(counts).find(n => counts[n] > 0 && matches(n, entry))
    if (name) return name
  }
  return null
}

function isAirLike (b) {
  return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
}

// prefer: a design's preferred materials; raw natural rock in such a spot gets dressed (replaced).
function acceptable (b, role, prefer = null) {
  if (!b) return false
  if (prefer && STRUCT.has(role) && NATURAL.test(b.name) && !prefer.some(e => matches(b.name, e))) return false
  if (EMPTY.has(role)) return isAirLike(b) || /_door$|torch$|rail$|_button$|^lever$/.test(b.name)
  if (STRUCT.has(role)) return T.isFirm(b) && !(NATURAL.test(b.name) && !(PALETTE[role] || []).some(e => matches(b.name, e)))
  if (FILLERS.has(role)) return T.isFirm(b)
  if (role === 'window') return /glass/.test(b.name)
  if (role === 'door') return /_door$/.test(b.name)
  if (role === 'light') return /torch|lantern/.test(b.name)
  if (role === 'ladder') return b.name === 'ladder'
  if (role === 'furniture') return !isAirLike(b) && !T.isLiquid(b) && !NATURAL.test(b.name)
  return true
}

// Plain building blocks the bot may remove from ITS OWN base when upgrading it (a doorway into a
// new room, the hole for a ladder, an old roof). Never containers, beds or other furniture.
const OWN_REMOVABLE = /(_planks|_log|_wood|^cobblestone|^cobbled_deepslate|^stone|stone_bricks|^bricks|glass|glass_pane|^dirt|sandstone|_slab|_stairs|^torch|wall_torch)$/
const ownRemovable = (b) => !!b && OWN_REMOVABLE.test(b.name) && !/chest|barrel|furnace|table|bed|anvil|bookshelf|shulker/.test(b.name)

// Natural blocks in the way of a structural cell (dirt where the floor goes) get dug out first.
function needsDigging (b, role, allowOwn = false, prefer = null) {
  if (isAirLike(b) || T.isLiquid(b)) return false
  if ((EMPTY.has(role) || OPTIONAL.has(role)) && acceptable(b, role)) return false // e.g. a torch we placed
  if (EMPTY.has(role) || OPTIONAL.has(role)) return NATURAL.test(b.name) || (b.boundingBox === 'empty' && b.diggable) || (allowOwn && ownRemovable(b))
  if (STRUCT.has(role)) return !acceptable(b, role, prefer) && (NATURAL.test(b.name) || b.boundingBox === 'empty')
  return false
}

// ------------------------------------------------------------------ blueprints

const SIZES = {
  small: { E: 7, H: 3 },
  medium: { E: 9, H: 4 },
  large: { E: 11, H: 4 }
}

// Coordinates: [right, up, forward] relative to the origin. The front wall is at forward=0,
// the house extends forward (away from where the bot stood). up=0 is the ground layer.
// storeys=2 adds an upper floor (with a ladder up from the ground floor) and puts the bed upstairs.
function surfaceBaseCells (size, storeys = 1) {
  const { E, H } = SIZES[size] || SIZES.medium
  const two = storeys >= 2
  const h = (E - 1) / 2
  const top = two ? 2 * H + 1 : H // highest wall layer
  const cells = []
  const add = (ri, up, fi, role, extra = {}) => cells.push({ rel: [ri, up, fi], role, ...extra })
  const mid = Math.floor(E / 2)
  const windowUps = two ? [2, H + 3] : [2]
  const isWindow = (ri, fi) =>
    ((ri === -h || ri === h) && (fi === mid || (E >= 11 && (fi === 2 || fi === E - 3)))) ||
    (fi === E - 1 && (ri === 0 || (E >= 9 && Math.abs(ri) === 2))) ||
    (fi === 0 && Math.abs(ri) === 2)
  const ladderAt = (ri, fi) => two && ri === -h + 1 && fi === 1

  for (let fi = 0; fi < E; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const edgeF = fi === 0 || fi === E - 1
      const edgeR = ri === -h || ri === h
      const edge = edgeF || edgeR
      const corner = edgeF && edgeR
      add(ri, 0, fi, edge ? (corner ? 'frame' : 'wall') : 'floor')
      for (let up = 1; up <= top; up++) {
        const upperFloor = two && up === H + 1
        if (!edge) {
          if (ladderAt(ri, fi) && up <= H + 1) add(ri, up, fi, 'ladder', { item: 'ladder', wall: [-1, 0, 0] })
          else add(ri, up, fi, upperFloor ? 'floor' : 'air')
        } else if (corner || upperFloor) add(ri, up, fi, 'frame') // log corners, and a log band between floors
        else if (fi === 0 && ri === 0 && up === 1) add(ri, up, fi, 'door')
        else if (fi === 0 && ri === 0 && up === 2) add(ri, up, fi, 'doortop')
        else if (windowUps.includes(up) && isWindow(ri, fi)) add(ri, up, fi, 'window')
        else add(ri, up, fi, 'wall')
      }
      add(ri, top + 1, fi, edge ? 'frame' : 'roof') // roof with a log trim around the edge
      for (let d = 1; d <= 3; d++) add(ri, -d, fi, 'support')
    }
  }
  // A cleared, levelled walkway around the house.
  for (let fi = -1; fi <= E; fi++) {
    for (let ri = -h - 1; ri <= h + 1; ri++) {
      if (fi >= 0 && fi < E && ri >= -h && ri <= h) continue
      add(ri, 0, fi, 'support')
      for (let d = 1; d <= 2; d++) add(ri, -d, fi, 'support')
      for (let up = 1; up <= top + 2; up++) add(ri, up, fi, 'air')
    }
  }
  // Clear anything right above the roof (overhanging leaves etc.).
  for (let fi = 0; fi < E; fi++) for (let ri = -h; ri <= h; ri++) add(ri, top + 2, fi, 'air')

  // Torches: inside on the side and back walls, outside next to the door (and upstairs).
  const lights = [[-h + 1, 2, mid], [h - 1, 2, mid], [0, 2, E - 2], [-1, 2, -1], [1, 2, -1]]
  if (E >= 9) lights.push([h - 1, 2, 1])
  if (E >= 9 && !two) lights.push([-h + 1, 2, 1])
  if (two) lights.push([-h + 1, H + 3, mid], [h - 1, H + 3, mid], [0, H + 3, E - 2])
  for (const [ri, up, fi] of lights) setRole(cells, [ri, up, fi], 'light')
  // Furniture along the back wall, facing into the room; the two chests join into a double chest.
  const toFront = [0, 0, -1]
  setRole(cells, [-h + 1, 1, E - 2], 'furniture', { item: 'crafting_table', front: toFront })
  setRole(cells, [-h + 2, 1, E - 2], 'furniture', { item: 'furnace', front: toFront })
  setRole(cells, [h - 1, 1, E - 2], 'furniture', { item: 'chest', front: toFront })
  setRole(cells, [h - 2, 1, E - 2], 'furniture', { item: 'chest', front: toFront })
  // Bed: head against the right wall, foot pointing into the room (upstairs in a two-storey house).
  setRole(cells, [h - 2, two ? H + 2 : 1, 2], 'furniture', { item: /_bed$/, front: [-1, 0, 0] })
  const inside = [0, 1, mid]
  return { cells, inside, entrance: [0, 1, -1], footprint: { E, H, storeys: two ? 2 : 1 } }
}

// A covered two-wide staircase down to a room carved out of the rock.
function undergroundBaseCells (size, depth) {
  const { E } = SIZES[size] || SIZES.medium
  const Hr = size === 'small' ? 3 : 4
  const D = Math.max(5, Math.min(24, depth))
  const h = (E - 1) / 2
  const map = new Map()
  const key = (r, u, f) => `${r},${u},${f}`
  const add = (ri, up, fi, role, extra = {}) => map.set(key(ri, up, fi), { rel: [ri, up, fi], role, ...extra })

  // Stairs: step i stands at up = 1 - i, with 3 blocks of headroom.
  for (let i = 0; i < D; i++) {
    const s = 1 - i
    for (const ri of [0, 1]) {
      for (let up = s; up <= s + 2; up++) add(ri, up, i, 'air')
      add(ri, s - 1, i, 'support')
    }
  }
  // Doors at the top of the stairs.
  add(0, 1, 0, 'door'); add(1, 1, 0, 'door')
  add(0, 2, 0, 'doortop'); add(1, 2, 0, 'doortop')
  // Torches every few steps on the left wall.
  for (let i = 2; i < D; i += 3) add(0, 2 - i, i, 'light')

  // The room.
  const L = 1 - D // standing level at the bottom
  for (let fi = D; fi < D + E; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      for (let up = L; up < L + Hr; up++) add(ri, up, fi, 'air')
      add(ri, L - 1, fi, 'support')
    }
  }
  const back = D + E - 1
  const midF = D + Math.floor(E / 2)
  for (const [ri, fi] of [[-h, midF], [h, midF], [0, back], [-h, D + 1], [h, D + 1], [-h, back - 1], [h, back - 1]]) {
    add(ri, L + 1, fi, 'light')
  }
  const toFront = [0, 0, -1]
  add(-h, L, back, 'furniture', { item: 'crafting_table', front: toFront })
  add(-h + 1, L, back, 'furniture', { item: 'furnace', front: toFront })
  add(h, L, back, 'furniture', { item: 'chest', front: toFront })
  add(h - 1, L, back, 'furniture', { item: 'chest', front: toFront })
  add(h - 1, L, back - 3, 'furniture', { item: /_bed$/, front: [-1, 0, 0] })

  // Shell: every neighbor of the open space must be solid (seals caves, water, lava),
  // except the open front of the entrance.
  const open = [...map.values()].filter(c => c.role !== 'support')
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const c of open) {
    for (const [dr, du, df] of dirs) {
      const [r, u, f] = [c.rel[0] + dr, c.rel[1] + du, c.rel[2] + df]
      if (f < 0) continue
      if (!map.has(key(r, u, f))) add(r, u, f, 'shell')
    }
  }
  // Where the stairwell sticks out above the ground, run the side walls up one more block
  // so the roof over the entrance has something to rest on.
  for (let i = 0; i < D; i++) {
    const roofUp = 4 - i
    if (roofUp < 1) break
    for (const ri of [-1, 2]) if (!map.has(key(ri, roofUp, i))) add(ri, roofUp, i, 'shell')
  }
  return { cells: [...map.values()], inside: [0, L, midF], entrance: [0, 1, -1], footprint: { E, H: Hr, D } }
}

function setRole (cells, rel, role, extra = {}) {
  const c = cells.find(x => x.rel[0] === rel[0] && x.rel[1] === rel[1] && x.rel[2] === rel[2])
  if (c) Object.assign(c, { role }, extra)
  else cells.push({ rel, role, ...extra })
}

function toWorld (plan, origin, f, r) {
  const at = ([ri, up, fi]) => origin.plus(r.scaled(ri)).plus(f.scaled(fi)).offset(0, up, 0)
  const dir = ([ri, up, fi]) => r.scaled(ri).plus(f.scaled(fi)).offset(0, up, 0)
  return {
    cells: plan.cells.map(c => ({ ...c, pos: at(c.rel), ...(c.front ? { frontVec: dir(c.front) } : {}), ...(c.wall ? { wallVec: dir(c.wall) } : {}) })),
    inside: at(plan.inside),
    entrance: at(plan.entrance),
    at
  }
}

// ------------------------------------------------------------------ choosing a spot

const CARDINALS = [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)]
const rightOf = (f) => new Vec3(-f.z, 0, f.x)

// Surface: the flattest, driest open area nearby (cost = digging + filling + trees).
// box: the area (and height) the design needs, relative to the origin; default is a square house.
function chooseSurfaceSite (bot, size, { radius = 20, facing, box } = {}) {
  const { E, H } = SIZES[size] || SIZES.medium
  const h = (E - 1) / 2
  const bx = box || { riMin: -h - 1, riMax: h + 1, fiMin: -1, fiMax: E, height: H + 2 }
  const me = bot.entity.position.floored()
  const cols = new Map()
  const col = (x, z) => {
    const k = x + ',' + z
    if (!cols.has(k)) cols.set(k, T.columnInfo(bot, x, z, me.y, 14))
    return cols.get(k)
  }
  const clearCache = new Map()
  const clearCost = (x, z, gy) => {
    const k = `${x},${z},${gy}`
    if (clearCache.has(k)) return clearCache.get(k)
    let cost = 0
    for (let y = gy + 1; y <= gy + bx.height; y++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) { cost = Infinity; break }
      if (isAirLike(b)) continue
      if (T.isLiquid(b)) { cost = Infinity; break }
      if (!NATURAL.test(b.name)) { cost = Infinity; break } // never build through someone's stuff
      cost += T.isLeaves(b) ? 0.3 : b.boundingBox === 'block' ? 1 : 0.1
    }
    clearCache.set(k, cost)
    return cost
  }

  const f = facing || null
  let best = null
  for (const fv of f ? [f] : [facingFromYaw(bot)]) {
    const r = rightOf(fv)
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        const ox = me.x + dx; const oz = me.z + dz
        const heights = []
        let ok = true
        const pts = []
        for (let fi = bx.fiMin; fi <= bx.fiMax && ok; fi++) {
          for (let ri = bx.riMin; ri <= bx.riMax; ri++) {
            const x = ox + r.x * ri + fv.x * fi
            const z = oz + r.z * ri + fv.z * fi
            const c = col(x, z)
            if (!c || c.water || c.roofed) { ok = false; break }
            heights.push(c.y)
            pts.push([x, z, c.y])
          }
        }
        if (!ok) continue
        heights.sort((a, b) => a - b)
        const gy = heights[Math.floor(heights.length / 2)]
        if (Math.abs(gy - (me.y - 1)) > 10) continue
        let cost = 0
        for (const [x, z, y] of pts) {
          const diff = y - gy
          if (diff < -3 || diff > 4) { ok = false; break }
          if (diff < 0) cost += -diff * 1.2
          const cc = clearCost(x, z, gy)
          if (cc === Infinity) { ok = false; break }
          cost += cc
        }
        if (!ok) continue
        cost += Math.hypot(dx, dz) * 0.8
        if (!best || cost < best.cost) best = { origin: new Vec3(ox, gy, oz), f: fv, r, cost }
      }
    }
  }
  return best
}

// Underground: dig in from in front of the bot, trying all four directions, avoiding liquids.
function chooseUndergroundSite (bot, size, depth, layout = null) {
  const me = bot.entity.position.floored()
  let best = null
  for (const f of CARDINALS) {
    const r = rightOf(f)
    const start = me.plus(f.scaled(1))
    const c = T.columnInfo(bot, start.x, start.z, me.y, 6)
    if (!c || c.water) continue
    // Stand at ground level: when underground already, dig on from the current floor.
    const gy = Math.min(c.y, me.y - 1)
    const origin = new Vec3(start.x, gy, start.z)
    const plan = toWorld(layout || undergroundBaseCells(size, depth), origin, f, r)
    let liquids = 0; let lava = 0; let unloaded = 0; let bedrock = 0; let foreign = 0
    for (const cell of plan.cells) {
      const b = bot.blockAt(cell.pos)
      if (!b) { unloaded++; continue }
      if (b.name === 'lava') lava++
      else if (b.name === 'water') liquids++
      else if (b.name === 'bedrock') bedrock++
      else if (!isAirLike(b) && !NATURAL.test(b.name) && cell.role !== 'shell') foreign++
    }
    if (unloaded || bedrock || foreign) continue
    const cost = lava * 20 + liquids * 3
    if (!best || cost < best.cost) best = { origin, f, r, cost, lava, liquids }
  }
  return best
}

function facingFromYaw (bot) {
  const yaw = bot.entity.yaw
  const fx = -Math.sin(yaw); const fz = -Math.cos(yaw)
  return Math.abs(fx) > Math.abs(fz) ? new Vec3(Math.sign(fx), 0, 0) : new Vec3(0, 0, Math.sign(fz))
}

// ------------------------------------------------------------------ the engine

function groupOf (role) {
  if (role === 'wall' || role === 'roof' || role === 'floor') return 'walls/floor/roof (planks or cobblestone)'
  if (role === 'frame') return 'frame (logs, or more planks/cobblestone)'
  if (role === 'support' || role === 'shell') return 'filler (dirt or cobblestone)'
  if (role === 'window') return 'glass (optional)'
  if (role === 'door') return 'doors (optional)'
  if (role === 'light') return 'torches (optional)'
  if (role === 'ladder') return 'ladders (7 sticks make 3)'
  return null
}

// What is still missing, grouped, plus a progress percentage.
function survey (bot, cells) {
  const missing = {}
  let done = 0
  let total = 0
  for (const c of cells) {
    if (c.role === 'support' || c.role === 'shell') {
      const b = bot.blockAt(c.pos)
      if (b && (T.isFirm(b) || (!isAirLike(b) && !T.isLiquid(b)))) continue // only holes count
      total++
      const g = groupOf(c.role); missing[g] = (missing[g] || 0) + 1
      continue
    }
    total++
    const b = bot.blockAt(c.pos)
    if (acceptable(b, c.role, c.prefer)) { done++; continue }
    if (c.role === 'furniture') continue
    const g = groupOf(c.role)
    if (g) missing[g] = (missing[g] || 0) + 1
  }
  return { missing, progress: total ? Math.round((done / total) * 100) : 100 }
}

// Furniture spots that are still empty, by item, so the bot knows what to bring.
function missingFurniture (bot, cells) {
  const out = {}
  for (const c of cells) {
    if (c.role !== 'furniture' || acceptable(bot.blockAt(c.pos), 'furniture')) continue
    const name = typeof c.item === 'string' ? c.item : String(c.item.source).replace(/[\^$\\]/g, '').replace(/^_/, '')
    out[name] = (out[name] || 0) + 1
  }
  return out
}

async function reach (ctx, pos) {
  const { bot } = ctx
  const eyes = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
  if (eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.2) return
  await goto(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 60000)
}

const LIQUID_DIRS = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]

async function sealAround (ctx, pos, openKeys, stats) {
  const { bot } = ctx
  for (const d of [new Vec3(0, 0, 0), ...LIQUID_DIRS]) {
    const p = pos.plus(d)
    const b = bot.blockAt(p)
    if (!b || !T.isLiquid(b)) continue
    const mat = pickMaterial(bot, 'shell') || pickMaterial(bot, 'fill')
    if (!mat) { stats.warnings.add('ran into water/lava and had no blocks to seal it'); continue }
    try {
      const res = await placeAt(ctx, p, mat)
      if (res === 'placed') {
        stats.sealed++
        if (openKeys.has(p.toString())) stats.flooded.add(p.toString()) // keep it sealed, don't re-dig
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err
    }
  }
}

async function digCell (ctx, pos, openKeys, stats, { allowOwn = false } = {}) {
  const { bot } = ctx
  for (let tries = 0; tries < 6; tries++) {
    ctx.check()
    const b = bot.blockAt(pos)
    if (!b) throw new Error('part of the site is not loaded')
    if (isAirLike(b) || T.isLiquid(b)) return
    if (b.name === 'bedrock' || !b.diggable) return
    if (!NATURAL.test(b.name) && b.boundingBox === 'block' && !(allowOwn && ownRemovable(b))) { stats.warnings.add(`left a ${b.name} in place (not natural, maybe someone's)`); return }
    if (b.harvestTools && !bot.inventory.items().some(i => b.harvestTools[i.type])) {
      // Can't harvest it, but digging still removes it; only refuse things that need a pickaxe badly.
      if (/obsidian/.test(b.name)) { stats.warnings.add('hit obsidian (needs a diamond pickaxe)'); return }
    }
    await reach(ctx, pos)
    if (bot.tool?.equipForBlock) {
      try { await bot.tool.equipForBlock(b, {}) } catch {}
    }
    try {
      await ctx.race(bot.dig(b, true), 20000)
      stats.dug++
    } catch (err) {
      if (err instanceof CancelledError) throw err
      return
    }
    await ctx.sleep(80) // let gravel/sand fall and liquids flow
    await sealAround(ctx, pos, openKeys, stats)
  }
}

async function placeCell (ctx, cell, stats) {
  const { bot } = ctx
  let mat
  if (cell.role === 'furniture') {
    mat = bot.inventory.items().find(i => matches(i.name, cell.item))?.name
    if (!mat) return 'skip'
    if (cell.frontVec) {
      // Stand in front so it faces into the room (and chests pair up into double chests).
      try {
        const ok = await placeFacing(ctx, cell.pos, mat, cell.frontVec)
        if (ok) { stats.placed++; return 'placed' }
      } catch (err) {
        if (err instanceof CancelledError) throw err
      }
      return 'blocked'
    }
  } else if (cell.role === 'ladder') {
    mat = bot.inventory.items().find(i => i.name === 'ladder')?.name
  } else {
    // A design can prefer some materials (stone for a tower); the normal palette is the fallback.
    if (cell.prefer && (STRUCT.has(cell.role) || FILLERS.has(cell.role))) {
      const counts = inventoryCounts(bot)
      for (const entry of cell.prefer) { mat = Object.keys(counts).find(n => counts[n] > 0 && matches(n, entry)); if (mat) break }
    }
    mat = mat || pickMaterial(bot, cell.role)
    if (!mat && cell.role === 'frame') mat = pickMaterial(bot, 'wall')
    if (!mat && FILLERS.has(cell.role)) mat = pickMaterial(bot, 'wall')
  }
  if (!mat) {
    const g = groupOf(cell.role)
    if (g) stats.missing[g] = (stats.missing[g] || 0) + 1
    return 'missing'
  }
  const solid = STRUCT.has(cell.role) || FILLERS.has(cell.role) || cell.role === 'window'
  let res
  try {
    res = await placeAt(ctx, cell.pos, mat, { solid: solid && !/pane/.test(mat), ...(cell.wallVec ? { refDirs: [cell.wallVec] } : {}) })
  } catch (err) {
    if (err instanceof CancelledError) throw err
    if (/ran out/.test(err.message)) return 'missing'
    res = 'blocked'
  }
  if (res === 'placed') stats.placed++
  return res
}

// Runs (or resumes) a blueprint. Returns stats; never throws for missing materials.
// detailSkip: chance (0-1) that a less skilled builder forgets a window or torch.
// allowOwn: the blueprint is the bot's own base, so its own plain blocks may be removed (upgrades).
async function runBlueprint (ctx, plan, { onStatus = () => {}, detailSkip = 0, allowOwn = false } = {}) {
  const { bot } = ctx
  const stats = { dug: 0, placed: 0, sealed: 0, missing: {}, warnings: new Set(), flooded: new Set() }
  const cells = plan.cells
  const openKeys = new Set(cells.filter(c => EMPTY.has(c.role) || OPTIONAL.has(c.role)).map(c => c.pos.toString()))

  const restore = bot.pathfinder.movements
  if (bot._buildMovements) bot.pathfinder.setMovements(bot._buildMovements)
  try {
    // 1. Dig: open space first (nearest first, top to bottom), then natural blocks where structure goes.
    for (let pass = 0; pass < 3; pass++) {
      // Spots we plugged because water/lava poured in: dig them out again once no liquid is next to them.
      for (const k of [...stats.flooded]) {
        const [x, y, z] = k.replace(/[()]/g, '').split(',').map(Number)
        const p = new Vec3(x, y, z)
        if (!LIQUID_DIRS.some(d => T.isLiquid(bot.blockAt(p.plus(d))))) stats.flooded.delete(k)
      }
      const toDig = cells.filter(c => !stats.flooded.has(c.pos.toString()) && needsDigging(bot.blockAt(c.pos), c.role, allowOwn, c.prefer))
      if (!toDig.length) break
      toDig.sort((a, b) => (plan.digOrder ? plan.digOrder(a, b) : 0) ||
        (b.pos.y - a.pos.y) || (a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position)))
      let i = 0
      for (const c of toDig) {
        onStatus(`digging ${++i}/${toDig.length}`)
        await digCell(ctx, c.pos, openKeys, stats, { allowOwn })
      }
    }

    // 2. Fill holes and seal the shell, bottom up.
    // Several passes: a block with nothing to rest on yet gets another try once its neighbours exist.
    let fillers = cells.filter(c => FILLERS.has(c.role)).sort((a, b) => a.pos.y - b.pos.y)
    for (let pass = 0; pass < 5 && fillers.length; pass++) {
      const retry = []
      for (const c of fillers) {
        ctx.check()
        const b = bot.blockAt(c.pos)
        if (b && (T.isFirm(b) || (!isAirLike(b) && !T.isLiquid(b)))) continue
        onStatus('levelling and sealing')
        const res = await placeCell(ctx, c, stats)
        if (res === 'no-support' || res === 'blocked') retry.push(c)
      }
      if (retry.length === fillers.length) break
      fillers = retry
    }

    // 3. Structure, bottom up, in a few passes (some blocks need neighbours first).
    let pending = cells.filter(c => STRUCT.has(c.role) && !acceptable(bot.blockAt(c.pos), c.role, c.prefer))
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      pending.sort((a, b) => a.pos.y - b.pos.y || (a.role === 'frame' ? -1 : 0) - (b.role === 'frame' ? -1 : 0) ||
        a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
      const next = []
      let i = 0
      for (const c of pending) {
        ctx.check()
        onStatus(`building ${++i}/${pending.length}`)
        const res = await placeCell(ctx, c, stats)
        if (res === 'missing') continue
        if (res !== 'placed' && res !== 'exists') next.push(c)
      }
      if (next.length === pending.length) break
      pending = next
      if (Object.keys(stats.missing).length) break
    }

    // 4. Details: windows, lights, doors, furniture.
    const order = { window: 0, ladder: 1, light: 2, furniture: 3, door: 4 }
    const details = cells.filter(c => OPTIONAL.has(c.role) && !acceptable(bot.blockAt(c.pos), c.role))
      .sort((a, b) => order[a.role] - order[b.role] || a.pos.y - b.pos.y)
    for (const c of details) {
      ctx.check()
      if (detailSkip && (c.role === 'window' || c.role === 'light') && Math.random() < detailSkip) continue
      onStatus(`adding ${c.role}s`)
      await placeCell(ctx, c, stats)
    }
  } finally {
    if (bot._buildMovements && restore) bot.pathfinder.setMovements(restore)
  }
  return stats
}

module.exports = {
  PALETTE,
  NATURAL,
  SIZES,
  surfaceBaseCells,
  undergroundBaseCells,
  toWorld,
  chooseSurfaceSite,
  chooseUndergroundSite,
  runBlueprint,
  survey,
  missingFurniture,
  CARDINALS,
  pickMaterial,
  inventoryCounts,
  acceptable,
  rightOf,
  facingFromYaw,
  digCell,
  isAirLike,
  matches
}
