'use strict'

// Protected zones: places the bot must treat with respect.
//   - every base it built (from memory projects), with a small margin
//   - a radius around "home" if it has no recorded footprint (e.g. a hut)
//   - areas an operator or the bot marked with protect_area
// Inside a zone the pathfinder may not dig or pillar, and collect_block won't harvest.
// Everywhere, the pathfinder never breaks player-made blocks (planks, glass, chests...).

const { Vec3 } = require('vec3')
// builder is required lazily: builder -> placement -> zones -> builder would be a cycle.
const B = new Proxy({}, { get: (_, k) => require('./builder')[k] })

let cache = { at: 0, memory: null, zones: [] }

function projectBox (proj) {
  if (proj.style === 'farm' && proj.center) {
    const c = proj.center; const r = (proj.radius || 2) + 1
    return { min: new Vec3(c.x - r, c.y - 1, c.z - r), max: new Vec3(c.x + r, c.y + 3, c.z + r) }
  }
  if ((proj.style === 'pen' || proj.style === 'patch') && proj.corner) {
    const c = proj.corner; const w = proj.style === 'pen' ? 7 : 7; const d = proj.style === 'pen' ? 7 : 3
    return { min: new Vec3(c.x - 1, c.y - 1, c.z - 1), max: new Vec3(c.x + w, c.y + 3, c.z + d) }
  }
  if (!proj.origin || !proj.f) return null
  const origin = new Vec3(proj.origin.x, proj.origin.y, proj.origin.z)
  const f = new Vec3(proj.f.x, 0, proj.f.z)
  const layout = (proj.style === 'surface' || proj.style === 'underground') ? require('./homes').baseLayout(proj) : null
  if (!layout) return null
  const plan = B.toWorld(layout, origin, f, B.rightOf(f))
  const min = new Vec3(Infinity, Infinity, Infinity)
  const max = new Vec3(-Infinity, -Infinity, -Infinity)
  for (const c of plan.cells) {
    min.x = Math.min(min.x, c.pos.x); min.y = Math.min(min.y, c.pos.y); min.z = Math.min(min.z, c.pos.z)
    max.x = Math.max(max.x, c.pos.x); max.y = Math.max(max.y, c.pos.y); max.z = Math.max(max.z, c.pos.z)
  }
  return { min: min.offset(-2, -2, -2), max: max.offset(2, 3, 2) }
}

function getZones (memory) {
  if (!memory) return []
  if (cache.memory === memory && Date.now() - cache.at < 5000) return cache.zones
  const zones = []
  for (const [name, proj] of Object.entries(memory.data.projects || {})) {
    if (proj.style === 'mine') continue
    const box = projectBox(proj)
    if (box) zones.push({ name, kind: 'base', ...box })
  }
  const home = memory.getPlace('home')
  if (home && !zones.some(z => contains(z, home))) {
    zones.push({ name: 'home', kind: 'radius', center: new Vec3(home.x, home.y, home.z), radius: 7 })
  }
  for (const z of memory.data.zones || []) {
    zones.push({ name: z.name, kind: 'radius', center: new Vec3(z.x, z.y, z.z), radius: z.radius })
  }
  cache = { at: Date.now(), memory, zones }
  return zones
}

function contains (zone, p) {
  if (zone.kind === 'radius') {
    const dx = p.x - zone.center.x; const dz = p.z - zone.center.z; const dy = p.y - zone.center.y
    return dx * dx + dz * dz <= zone.radius * zone.radius && dy >= -zone.radius && dy <= zone.radius
  }
  return p.x >= zone.min.x && p.x <= zone.max.x && p.y >= zone.min.y && p.y <= zone.max.y && p.z >= zone.min.z && p.z <= zone.max.z
}

function zoneAt (memory, pos) {
  return getZones(memory).find(z => contains(z, pos)) || null
}

function distanceToZones (memory, pos) {
  let best = Infinity
  for (const z of getZones(memory)) {
    if (z.kind === 'radius') {
      best = Math.min(best, Math.max(0, Math.hypot(pos.x - z.center.x, pos.z - z.center.z) - z.radius))
    } else {
      const dx = Math.max(z.min.x - pos.x, 0, pos.x - z.max.x)
      const dz = Math.max(z.min.z - pos.z, 0, pos.z - z.max.z)
      best = Math.min(best, Math.hypot(dx, dz))
    }
  }
  return best
}

function invalidate () {
  cache.at = 0
}

// Teach pathfinder movements to respect zones and other people's blocks.
// useZones=false is for the builder's own movements (it has to work inside its base).
function protectMovements (bot, movements, memory, { useZones = true } = {}) {
  for (const m of movements) {
    if (!m) continue
    m.canOpenDoors = true // so the bot can get in and out of bases with doors
    m.blocksCantBreak = m.blocksCantBreak || new Set()
    m.exclusionAreasBreak = m.exclusionAreasBreak || []
    m.exclusionAreasPlace = m.exclusionAreasPlace || []
    for (const b of Object.values(bot.registry.blocksByName)) {
      if (b.diggable === false) continue
      if (!B.NATURAL.test(b.name)) m.blocksCantBreak.add(b.id)
    }
    if (!useZones) continue
    m.exclusionAreasBreak.push((block) => (block?.position && zoneAt(memory, block.position) ? 1000 : 0))
    m.exclusionAreasPlace.push((block) => (block?.position && zoneAt(memory, block.position) ? 1000 : 0))
  }
}

module.exports = { getZones, zoneAt, distanceToZones, protectMovements, invalidate, contains }
