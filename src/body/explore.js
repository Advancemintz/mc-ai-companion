'use strict'

// The explore action: head out in a direction the bot hasn't been, look around every few
// dozen blocks, remember what it finds (villages, caves, lava, structures, biomes, other people's
// bases), and come home before dark or when hurt.
//
// The explored map lives in memory as 32x32-block cells, so the next trip picks new ground.
// How far and how long it may go, and what it recognises, come from the exploration tier.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const DIRS = {
  north: [0, -1], northeast: [1, -1], east: [1, 0], southeast: [1, 1],
  south: [0, 1], southwest: [-1, 1], west: [-1, 0], northwest: [-1, -1]
}
const DIR_NAMES = Object.keys(DIRS)
const unit = (d) => { const [x, z] = DIRS[d]; const n = Math.hypot(x, z); return { x: x / n, z: z / n } }

const WALK_SPEED = 4 // blocks per second, pathfinding included (a little pessimistic)
const DUSK = 12000 // monsters start spawning around 12500; be home by about here

// What structures look like from the outside. Blocks that don't exist in this version are ignored.
const STRUCTURES = [
  { label: 'dungeon', any: ['spawner'] },
  { label: 'trial chambers', any: ['trial_spawner', 'vault'] },
  { label: 'ruined portal', any: ['crying_obsidian'] },
  { label: 'desert temple', all: ['chiseled_sandstone', 'orange_terracotta'] },
  { label: 'jungle temple', all: ['mossy_cobblestone', 'dispenser'] },
  { label: 'pillager outpost', mobs: ['pillager'], minMobs: 2 },
  { label: 'witch hut', all: ['cauldron'], biome: /swamp/ },
  { label: 'ocean monument', any: ['prismarine_bricks', 'dark_prismarine'] },
  { label: 'mineshaft', any: ['cobweb'], min: 4, below: true },
  { label: 'stronghold', any: ['end_portal_frame'] },
  { label: 'ancient city', any: ['sculk_shrieker', 'reinforced_deepslate'] },
  { label: 'trail ruins', any: ['suspicious_gravel'] },
  { label: 'igloo', all: ['snow_block', 'white_carpet'] },
  { label: 'woodland mansion', mobs: ['vindicator', 'evoker'], minMobs: 1, biome: /dark_forest/ },
  { label: 'shipwreck', all: ['spruce_planks', 'chest'], biome: /ocean|beach/ }
]

// Blocks a player's base has, and villages mostly don't (chests and furnaces especially).
const BASE_BLOCKS = /^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|anvil|enchanting_table|brewing_stand|.*_bed)$/

function idsFor (bot, names) {
  return names.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
}

function find (bot, names, radius, count = 32, point = null) {
  const ids = idsFor(bot, names)
  if (!ids.length) return []
  const opts = { matching: ids, maxDistance: radius, count }
  if (point) opts.point = point
  try { return bot.findBlocks(opts) } catch { return [] }
}

function dimOf (bot) { return String(bot.game?.dimension || 'overworld').replace('minecraft:', '') }

// Pick the direction with the most unexplored land between home and the trip radius.
function chooseDirection (memory, center, radius, dimension, { smart = true, avoid = null } = {}) {
  const scores = DIR_NAMES.map(name => {
    const u = unit(name)
    let fresh = 0; let total = 0
    for (let d = 32; d <= radius; d += 32) {
      for (const side of [-24, 0, 24]) {
        const p = { x: center.x + u.x * d - u.z * side, z: center.z + u.z * d + u.x * side }
        total++
        if (!memory || !memory.isExplored(p, dimension)) fresh++
      }
    }
    return { name, share: total ? fresh / total : 1 }
  }).filter(s => s.name !== avoid)
  if (smart) {
    const best = Math.max(...scores.map(s => s.share))
    const top = scores.filter(s => s.share >= best - 0.05)
    return top[Math.floor(Math.random() * top.length)].name
  }
  // Beginners just pick a direction that still has something new.
  const open = scores.filter(s => s.share >= 0.3)
  const pool = open.length ? open : scores
  return pool[Math.floor(Math.random() * pool.length)].name
}

const OPEN = (b) => b && (b.name === 'air' || b.name === 'cave_air')

// An opening in the ground near the bot: a column that drops 7+ blocks straight down below
// the bot's feet, with rock around it (so a shaft or cave mouth, not just the edge of a cliff).
function findShaft (bot, pos) {
  const fx = Math.floor(pos.x); const fy = Math.floor(pos.y); const fz = Math.floor(pos.z)
  for (let dx = -12; dx <= 12; dx++) {
    for (let dz = -12; dz <= 12; dz++) {
      const x = fx + dx; const z = fz + dz
      let depth = 0
      for (let y = fy - 1; y >= fy - 10; y--) {
        if (OPEN(bot.blockAt(new Vec3(x, y, z)))) depth++
        else break
      }
      if (depth < 7) continue
      const y = fy - 5
      const walls = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]
        .filter(([ax, az]) => { const b = bot.blockAt(new Vec3(x + ax, y, z + az)); return b && b.boundingBox === 'block' }).length
      if (walls >= 3) return new Vec3(x, fy - 1, z)
    }
  }
  return null
}

// Look around: returns [{ kind, label, pos, note }] for everything recognisable within reach.
function scan (ctx, params) {
  const { bot } = ctx
  const pos = bot.entity.position
  const r = params.scanRadius || 32
  const notices = new Set(params.notices || [])
  const mem = ctx.memory
  const ownZone = (p) => { const z = Z.zoneAt(mem, p); return z && !mem?.data.places?.[z.name]?.owner }
  const out = []

  if (notices.has('biome')) {
    let biome = ''
    try { biome = bot.blockAt(pos.floored())?.biome?.name || '' } catch {}
    if (biome) out.push({ kind: 'biome', label: biome, pos })
  }

  const villagers = Object.values(bot.entities || {}).filter(e => e?.name === 'villager' && e.position.distanceTo(pos) <= r)
  const bells = find(bot, ['bell'], r, 4).filter(p => !ownZone(p))
  let village = null
  if (notices.has('village') && (bells.length || villagers.length >= 2)) {
    village = bells[0] || villagers[0].position.floored()
    out.push({ kind: 'village', label: 'village', pos: village, note: `${villagers.length} villager${villagers.length === 1 ? '' : 's'} seen` })
  }

  if (notices.has('lava')) {
    const lava = find(bot, ['lava'], Math.min(r, 32), 64).filter(p => Math.abs(p.y - pos.y) <= 12)
    if (lava.length) out.push({ kind: 'lava', label: 'lava', pos: lava[0], note: lava.length >= 8 ? 'a lava pool: careful' : 'some lava: careful' })
  }

  if (notices.has('cave')) {
    const air = find(bot, ['cave_air'], Math.min(r, 24), 40)
    let mouth = air.length >= 12 ? air[0] : null
    if (!mouth) mouth = findShaft(bot, pos)
    if (mouth && !ownZone(mouth)) out.push({ kind: 'cave', label: 'cave', pos: mouth, note: 'a way down' })
  }

  if (notices.has('structure')) {
    let biome = ''
    try { biome = bot.blockAt(pos.floored())?.biome?.name || '' } catch {}
    for (const s of STRUCTURES) {
      if (s.biome && !s.biome.test(biome)) continue
      let at = null
      if (s.mobs) {
        const mobs = Object.values(bot.entities || {}).filter(e => s.mobs.includes(e?.name) && e.position.distanceTo(pos) <= r)
        if (mobs.length >= (s.minMobs || 1)) at = mobs[0].position.floored()
      } else {
        const names = s.any || s.all
        const hits = names.map(n => find(bot, [n], r, 16).filter(p => !ownZone(p) && !ctx.social?.ownerAt(p, dimOf(bot)) && (!s.below || p.y < pos.y - 4)))
        const ok = s.any ? hits.some(h => h.length >= (s.min || 1)) : hits.every(h => h.length >= (s.min || 1))
        if (ok) at = hits.find(h => h.length)[0]
      }
      if (at) out.push({ kind: 'structure', label: s.label, pos: at })
    }
  }

  if (notices.has('base')) {
    // Player-made furniture out in the wild, away from villages and from your own bases.
    const spots = find(bot, Object.keys(bot.registry.blocksByName).filter(n => BASE_BLOCKS.test(n)), r, 48)
      .filter(p => !ownZone(p) && !(village && p.distanceTo(village) < 64))
    if (spots.length >= 2) {
      // Cluster around the first one: at least 3 kinds of furniture within 10 blocks.
      const c = spots[0]
      const close = spots.filter(p => p.distanceTo(c) <= 10)
      const kinds = new Set(close.map(p => (bot.blockAt(p)?.name || '').replace(/^.*_bed$/, 'bed')))
      if (kinds.size >= 3) {
        const o = ctx.social?.ownerAt(c, dimOf(bot))
        let owner = o && o.how !== 'mine' ? o.owner : null
        if (!owner) {
          const p = Object.values(bot.entities || {}).find(e => e?.type === 'player' && e.username !== bot.username && e.position.distanceTo(c) <= 16)
          if (p) { owner = p.username; ctx.social?.observeHome(p.username, c, dimOf(bot), 2, 'found them at a base while exploring') }
        }
        out.push({ kind: 'base', label: owner ? `${owner}'s base` : "someone's base", pos: c, note: `${[...kinds].join(', ')}`, owner })
      }
    }
  }
  return out
}

// A torch on a two-block cobblestone post next to the bot, so a find is easy to spot again.
async function placeMarker (ctx) {
  const { bot } = ctx
  if ((bot.inventory.items().find(i => i.name === 'cobblestone')?.count || 0) < 2 || !bot.inventory.items().some(i => i.name === 'torch')) return false
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const p = base.offset(dx, 0, dz)
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') continue
    if (![0, 1, 2].every(dy => ['air', 'cave_air', 'short_grass', 'tall_grass'].includes(bot.blockAt(p.offset(0, dy, 0))?.name))) continue
    try {
      if (await placeAt(ctx, p, 'cobblestone') !== 'placed') continue
      if (await placeAt(ctx, p.offset(0, 1, 0), 'cobblestone') !== 'placed') return false
      await placeAt(ctx, p.offset(0, 2, 0), 'torch', { solid: false })
      return true
    } catch (err) {
      if (err instanceof CancelledError) throw err
      return false
    }
  }
  return false
}

// Should we turn back? Returns a reason or null.
function turnBackReason (bot, { home, deadline, params, fleeHealth = 6 }) {
  const t = bot.time?.timeOfDay ?? 6000
  const pos = bot.entity.position
  const distHome = Math.hypot(home.x - pos.x, home.z - pos.z)
  const ticksHome = (distHome / WALK_SPEED) * 20 + (params.safety || 2) * 1200
  if (t < 23000 && t + ticksHome >= DUSK) return 'it was getting late'
  if (t >= DUSK && t < 23000) return 'it was getting dark'
  if (bot.health <= Math.max(10, fleeHealth + 4)) return 'I got hurt'
  const hasFood = bot.inventory.items().some(i => bot.registry.foodsByName?.[i.name])
  if (bot.food <= 6 && !hasFood) return 'I was getting hungry with no food'
  if (Date.now() >= deadline) return 'the trip took long enough'
  if (bot.inventory.emptySlotCount() === 0) return 'my pockets were full'
  return null
}

const exploreAction = {
  description: 'Go exploring: head out in a direction you haven\'t been (or the one given), look around every few dozen blocks, remember what you find (villages, caves, lava, structures, biomes, other people\'s bases) and come home before dark or if you get hurt. Range and trip length grow with your exploration skill. Best in the morning, with some food.',
  params: { direction: 'optional: north, northeast, east, ... (default: least explored)' },
  timeoutSeconds: 1200,
  run: async (ctx, { direction }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const params = ctx.skills?.params('exploration') || require('../skills/registry').SKILLS.exploration.tiers[1].params
    const dimension = dimOf(bot)
    const homePlace = mem?.getPlace('home')
    const home = homePlace && homePlace.dimension === dimension ? new Vec3(homePlace.x, homePlace.y, homePlace.z) : bot.entity.position.floored()
    const t = bot.time?.timeOfDay ?? 6000
    if (dimension !== 'overworld') throw new Error('explore is for the overworld; in the Nether use nether_trip')

    // Resume an interrupted trip (a fight, eating) rather than starting a new one.
    let trip = mem?.data.exploreTrip
    if (trip && Date.now() - trip.startedAt > params.minutes * 2 * 60000) trip = null
    if (!trip) {
      if (t >= DUSK - 600 && t < 23000) throw new Error("it's too close to night to head out. Explore in the morning")
      if (bot.health < 14) throw new Error("I'm too hurt to go exploring. Heal up first")
      let dir = direction ? String(direction).toLowerCase().replace(/[\s_-]/g, '') : null
      if (dir && !DIRS[dir]) throw new Error(`"${direction}" isn't a direction. Use north, northeast, east, southeast, south, southwest, west or northwest`)
      if (!dir) dir = chooseDirection(mem, home, params.radius, dimension, { smart: params.smartDir, avoid: mem?.data.lastExploreDir })
      trip = { startedAt: Date.now(), dir, legs: 0, cells: 0, finds: [], biomes: [], reason: null, farthest: 0 }
      if (mem) { mem.data.exploreTrip = trip; mem.data.lastExploreDir = dir; mem.save() }
    }
    const deadline = trip.startedAt + params.minutes * 60000
    const fleeHealth = ctx.config?.reflexes?.fleeHealth ?? 6
    let failures = 0
    let heading = trip.dir

    const record = async () => {
      if (mem) {
        const fresh = mem.markExplored(bot.entity.position, dimension, 1)
        trip.cells += fresh
        if (fresh) ctx.skills?.award('exploration', 0.4 * fresh)
      }
      for (const f of scan(ctx, params)) {
        if (f.kind === 'biome') {
          if (mem?.noteBiome(f.label, f.pos)) { trip.biomes.push(f.label); ctx.skills?.award('exploration', 3, `found a new biome: ${f.label}`) }
          continue
        }
        const res = mem ? mem.addDiscovery(f.kind, f.label, f.pos, dimension, f.note) : { isNew: true, entry: f }
        if (!res.isNew) continue
        let place = ''
        if (mem && ['village', 'cave', 'structure'].includes(f.kind)) {
          place = mem.freePlaceName(f.label.replace(/\s+/g, '_'))
          mem.setPlace(place, f.pos, dimension, `found while exploring${f.note ? `; ${f.note}` : ''}`)
        }
        trip.finds.push(`${f.label} at ${f.pos.x} ${f.pos.y} ${f.pos.z}${place ? ` (saved as ${place})` : ''}${f.note && f.kind !== 'base' ? ` - ${f.note}` : ''}`)
        const xp = { village: 10, structure: 12, cave: 4, lava: 2, base: 6 }[f.kind] || 2
        ctx.skills?.award('exploration', xp, `found ${f.label}`)
        if (params.marker && (f.kind === 'village' || f.kind === 'structure')) {
          try { if (await placeMarker(ctx)) trip.finds[trip.finds.length - 1] += ', marked with a torch post' } catch (err) { if (err instanceof CancelledError) throw err }
        }
      }
      if (mem) { mem.data.exploreTrip = trip; mem.save() }
    }

    // Outward.
    await record()
    while (!trip.reason) {
      ctx.check()
      const why = turnBackReason(bot, { home, deadline, params, fleeHealth })
      if (why) { trip.reason = why; break }
      const pos = bot.entity.position
      const u = unit(heading)
      const jitter = (Math.random() - 0.5) * params.hop * 0.4
      let next = { x: pos.x + u.x * params.hop - u.z * jitter, z: pos.z + u.z * params.hop + u.x * jitter }
      const out = Math.hypot(next.x - home.x, next.z - home.z)
      if (out > params.radius) {
        // Reached the edge of how far this explorer dares to go: sweep sideways once, then head home.
        if (trip.turned) { trip.reason = `I reached the edge of how far I go (${params.radius} blocks)`; break }
        trip.turned = true
        const i = DIR_NAMES.indexOf(heading)
        heading = DIR_NAMES[(i + (Math.random() < 0.5 ? 2 : 6)) % 8]
        continue
      }
      ctx.setStatus(`exploring ${trip.dir}: ${Math.round(Math.hypot(pos.x - home.x, pos.z - home.z))} blocks out, ${trip.finds.length} finds`)
      try {
        await goto(ctx, new goals.GoalNearXZ(Math.round(next.x), Math.round(next.z), 3), Math.round(params.hop / 2 + 20) * 1000)
        failures = 0
        trip.legs++
        trip.farthest = Math.max(trip.farthest, Math.round(Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z)))
      } catch (err) {
        if (err instanceof CancelledError) throw err
        // Water, a cliff or a ravine in the way: veer off a little and try again.
        if (++failures >= 4) { trip.reason = 'the way was blocked'; break }
        const i = DIR_NAMES.indexOf(heading)
        heading = DIR_NAMES[(i + (failures % 2 ? 1 : 7)) % 8]
        continue
      }
      await record()
      ctx.resumeArgs = { direction: trip.dir }
    }

    // Home.
    ctx.setStatus(`heading home (${trip.reason})`)
    if (mem) { mem.data.exploreTrip = trip; mem.save() }
    const distHome = Math.hypot(home.x - bot.entity.position.x, home.z - bot.entity.position.z)
    let gotHome = true
    if (distHome > 6) {
      try {
        await goto(ctx, new goals.GoalNearXZ(home.x, home.z, 4), Math.round(distHome / 2 + 60) * 1000)
      } catch (err) {
        if (err instanceof CancelledError) throw err
        gotHome = false
      }
    }
    if (mem) { delete mem.data.exploreTrip; mem.addJournal(`Explored ${trip.dir}${trip.finds.length ? `: found ${trip.finds.map(f => f.split(' at ')[0]).join(', ')}` : ''}`); mem.save() }
    if (gotHome) ctx.skills?.award('exploration', 5, 'came home safely from a trip')
    const parts = [`explored ${trip.dir} (${trip.farthest} blocks out, ${trip.cells} new area${trip.cells === 1 ? '' : 's'} mapped)`]
    parts.push(trip.finds.length ? `found: ${trip.finds.join('; ')}` : 'found nothing special')
    if (trip.biomes.length) parts.push(`new biomes: ${trip.biomes.join(', ')}`)
    parts.push(gotHome ? `came home because ${trip.reason}` : `turned back because ${trip.reason}, but couldn't find the way all the way home (I'm at ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.z)})`)
    return parts.join('. ')
  }
}

module.exports = { exploreAction, chooseDirection, scan, turnBackReason, DIRS, STRUCTURES }
