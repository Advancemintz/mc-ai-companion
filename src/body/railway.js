'use strict'

// Powered minecart railways between places (the bot's base, mines, villages, players' bases).
//
// Route: an L-shaped line (one straight run along X, one along Z) between two stations that
// sit just outside any base, so the bot never digs into anyone's build.
// Track: follows the land, at most one block up or down per block. Hills get a tunnel
// (3 high), dips and water get a bridge of support blocks. Curves are always kept flat.
// Power: a powered rail every 24 blocks on the flat and on every uphill rail, each lit by a
// redstone torch beside the track.
// Stations: a buffer block, a powered "brake/launch" rail, and a button beside it. Put a cart
// on the end rail, get in, press the button and off you go; arriving carts brake and stop.
// It is built in sections of ~24 blocks and saved in memory, so it can pause and resume.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const B = require('./builder')
const T = require('./terrain')
const Z = require('./zones')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const SEGMENT = 24
const POWER_EVERY = 24
const RAIL_ITEMS = {
  rail: 'rail',
  powered: 'powered_rail',
  torch: 'redstone_torch',
  button: /_button$/
}

// ------------------------------------------------------------------ route

function sign (n) {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

// Straight run along one axis, then the other. Returns [{x, z, dir: Vec3}], start..end inclusive.
function lRoute (start, end, xFirst = true) {
  const cols = []
  let x = start.x; let z = start.z
  const legs = xFirst ? ['x', 'z'] : ['z', 'x']
  for (const axis of legs) {
    const target = axis === 'x' ? end.x : end.z
    const step = sign(target - (axis === 'x' ? x : z))
    const dir = axis === 'x' ? new Vec3(step, 0, 0) : new Vec3(0, 0, step)
    while ((axis === 'x' ? x : z) !== target) {
      cols.push({ x, z, dir })
      if (axis === 'x') x += step; else z += step
    }
  }
  const lastDir = cols.length ? cols[cols.length - 1].dir : new Vec3(1, 0, 0)
  cols.push({ x, z, dir: lastDir })
  return cols
}

// Is the column (x, z) inside any protected zone? (height ignored)
function inZoneXZ (memory, x, z) {
  return Z.getZones(memory).some(zone => zone.kind === 'radius'
    ? Math.hypot(x - zone.center.x, z - zone.center.z) <= zone.radius
    : x >= zone.min.x && x <= zone.max.x && z >= zone.min.z && z <= zone.max.z)
}

// Walk from a point toward the other end until we're clear of every protected zone (+margin).
function stationPoint (memory, from, toward, margin = 3) {
  const route = lRoute(from, toward, Math.abs(toward.x - from.x) >= Math.abs(toward.z - from.z))
  let i = 0
  while (i < route.length - 1 && inZoneXZ(memory, route[i].x, route[i].z)) i++
  i = Math.min(route.length - 1, i + margin)
  return new Vec3(route[i].x, from.y, route[i].z)
}

function planRoute (memory, fromPos, toPos) {
  const a = stationPoint(memory, fromPos, toPos)
  const b = stationPoint(memory, toPos, fromPos)
  // Choose the L that crosses fewer protected zones (in the middle part).
  let best = null
  for (const xFirst of [true, false]) {
    const cols = lRoute(a, b, xFirst)
    let blocked = 0
    for (const c of cols) if (inZoneXZ(memory, c.x, c.z)) blocked++
    if (!best || blocked < best.blocked) best = { cols, blocked, xFirst }
  }
  return { start: a, end: b, ...best }
}

// ------------------------------------------------------------------ materials

function countItem (bot, re) {
  return bot.inventory.items().filter(i => (typeof re === 'string' ? i.name === re : re.test(i.name))).reduce((n, i) => n + i.count, 0)
}

// Rough bill of materials for a line of `length` blocks.
function estimate (length, { slopes = 0 } = {}) {
  const powered = Math.ceil(length / POWER_EVERY) + 2 + slopes
  const torches = Math.ceil(length / POWER_EVERY) + slopes
  const rails = Math.max(0, length - powered)
  return {
    length,
    rails,
    powered,
    torches,
    buttons: 2,
    iron: Math.ceil(rails / 16) * 6,
    gold: Math.ceil(powered / 6) * 6,
    redstone: Math.ceil(powered / 6) + torches,
    sticks: Math.ceil(rails / 16) + Math.ceil(powered / 6) + torches,
    supportBlocks: Math.ceil(length * 0.35) // dips, bridges and tunnel floors; varies with terrain
  }
}

// What the bot has toward a bill of materials, and what's missing.
function materialCheck (bot, need) {
  const have = {
    rails: countItem(bot, 'rail'),
    powered: countItem(bot, 'powered_rail'),
    torches: countItem(bot, 'redstone_torch'),
    iron: countItem(bot, 'iron_ingot'),
    rawIron: countItem(bot, 'raw_iron'),
    gold: countItem(bot, 'gold_ingot'),
    rawGold: countItem(bot, 'raw_gold'),
    redstone: countItem(bot, 'redstone'),
    support: countItem(bot, /^(cobblestone|cobbled_deepslate|stone|dirt|andesite|diorite|granite|tuff|deepslate)$/),
    pickTier: Math.max(0, ...bot.inventory.items().filter(i => i.name.endsWith('_pickaxe')).map(i => ({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 })[i.name.split('_')[0]] || 0))
  }
  const ironShort = Math.max(0, need.iron - Math.floor(have.rails / 16) * 6 - have.iron - have.rawIron)
  const goldShort = Math.max(0, need.gold - Math.floor(have.powered / 6) * 6 - have.gold - have.rawGold)
  const redShort = Math.max(0, need.redstone - have.redstone - have.torches)
  const supportShort = Math.max(0, need.supportBlocks - have.support)
  const short = { iron: ironShort, gold: goldShort, redstone: redShort, supportBlocks: supportShort }
  const hasAll = !ironShort && !goldShort && !redShort
  // "Easily" = a trip or two to the mine with a good enough pickaxe.
  const easy = hasAll || (have.pickTier >= 3 && ironShort <= 36 && goldShort <= 18 && redShort <= 16) ||
    (have.pickTier >= 2 && !goldShort && !redShort && ironShort <= 36)
  const missing = Object.entries(short).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'supportBlocks' ? 'support blocks (cobblestone/dirt)' : k === 'redstone' ? 'redstone' : `${k} ingots`}`)
  return { have, short, hasAll, easy, missing }
}

// ------------------------------------------------------------------ building

function sideOf (dir) {
  return new Vec3(-dir.z, 0, dir.x) // the right-hand side
}

// Decide the track height for the next column, following the land gently.
function nextHeight (bot, cols, i, prevY, { flatHere }) {
  const c = cols[i]
  const ground = (col) => {
    const info = T.columnInfo(bot, col.x, col.z, prevY, 20)
    if (!info) return null
    if (info.water) return info.y + 1 // bridge on top of the water surface
    return info.y + 1
  }
  const here = ground(c)
  if (here === null) return null // not loaded yet
  if (flatHere) return prevY
  // Look a few blocks ahead so the line doesn't zig-zag over every bump.
  const ahead = []
  for (let k = i; k < Math.min(cols.length, i + 6); k++) {
    const g = ground(cols[k])
    if (g !== null) ahead.push(g)
  }
  ahead.sort((a, b) => a - b)
  const want = ahead.length ? ahead[Math.floor(ahead.length / 2)] : here
  return prevY + sign(want - prevY)
}

async function ensureLoaded (ctx, pos) {
  const { bot } = ctx
  if (bot.blockAt(pos) && bot.entity.position.distanceTo(pos) < 48) return
  await goto(ctx, new goals.GoalNearXZ(pos.x, pos.z, 8), 180000)
}

// Craft rails / powered rails / redstone torches from raw materials when we run low.
async function craftParts (ctx, wantRails, wantPowered, wantTorches) {
  const { actions } = require('./actions') // lazy: actions requires this file
  const tryCraft = async (item, count) => {
    if (count <= 0) return
    try { await actions.craft.run(ctx, { item, count }) } catch (err) { if (err instanceof CancelledError) throw err }
  }
  const { bot } = ctx
  const sticksNeeded = Math.ceil(wantRails / 16) + Math.ceil(wantPowered / 6) + wantTorches
  if (countItem(bot, 'stick') < sticksNeeded) await tryCraft('stick', sticksNeeded - countItem(bot, 'stick') + 2)
  await tryCraft('rail', Math.max(0, wantRails - countItem(bot, 'rail')))
  await tryCraft('powered_rail', Math.max(0, wantPowered - countItem(bot, 'powered_rail')))
  await tryCraft('redstone_torch', Math.max(0, wantTorches - countItem(bot, 'redstone_torch')))
}

// Lay out (and remember) the rail positions for the next section of the line.
function extendLayout (bot, proj) {
  const cols = proj.cols.map(c => ({ x: c.x, z: c.z, dir: new Vec3(c.dx, 0, c.dz) }))
  const rails = proj.rails
  const n = cols.length
  const isCorner = (i) => i > 0 && i < n && (cols[i].dir.x !== cols[i - 1].dir.x || cols[i].dir.z !== cols[i - 1].dir.z)
  const nearCorner = (i) => [i - 1, i, i + 1].some(k => k > 0 && k < n && isCorner(k))
  let added = 0
  while (rails.length < n && added < SEGMENT) {
    const i = rails.length
    const prevY = i === 0 ? proj.startY : rails[i - 1].y
    const flatHere = i === 0 || i >= n - 2 || nearCorner(i) || i <= 1
    const y = nextHeight(bot, cols, i, prevY, { flatHere })
    if (y === null) break
    rails.push({ x: cols[i].x, y, z: cols[i].z, dx: cols[i].dir.x, dz: cols[i].dir.z, kind: 'rail' })
    added++
  }
  // Power: terminals, every uphill rail, and every POWER_EVERY on the flat.
  for (let i = 0; i < rails.length; i++) {
    const r = rails[i]
    if (r.kindFixed) continue
    const next = rails[i + 1]
    const uphill = next && next.y > r.y
    const terminal = i === 0 || (i === n - 1)
    if (terminal) r.kind = 'brake'
    else if (uphill) r.kind = 'powered'
    else if (i % POWER_EVERY === 0 && !nearCorner(i)) r.kind = 'powered'
    if (next || i === n - 1) r.kindFixed = true
  }
  return added
}

// Blueprint cells for rails [from..to): bed, clearance, torch posts, station extras.
function sectionCells (proj, from, to) {
  const cells = []
  const add = (pos, role, extra = {}) => cells.push({ pos, role, rel: [0, 0, 0], ...extra })
  const rails = proj.rails
  for (let i = from; i < to; i++) {
    const r = rails[i]
    const p = new Vec3(r.x, r.y, r.z)
    const dir = new Vec3(r.dx, 0, r.dz)
    add(p.offset(0, -1, 0), 'shell') // track bed
    for (let up = 0; up <= 2; up++) add(p.offset(0, up, 0), 'air') // tunnel / headroom
    const prev = rails[i - 1]
    if (prev && prev.y > r.y) add(p.offset(0, 3, 0), 'air') // extra headroom where the line drops
    if (r.kind === 'powered' || r.kind === 'brake') {
      const s = p.plus(sideOf(dir))
      add(s.offset(0, -1, 0), 'shell')
      add(s, 'air'); add(s.offset(0, 1, 0), 'air')
    }
    if (i === 0 || i === rails.length - 1) {
      // Station: buffer block at the end of the line and a little platform.
      const out = i === 0 ? dir.scaled(-1) : dir
      if (i === rails.length - 1 && rails.length === proj.cols.length) add(p.plus(out), 'shell', { buffer: true })
      if (i === 0) add(p.plus(out), 'shell', { buffer: true })
      const s = p.minus(sideOf(dir))
      add(s.offset(0, -1, 0), 'shell'); add(s, 'air'); add(s.offset(0, 1, 0), 'air')
    }
  }
  return cells
}

async function placePart (ctx, pos, item) {
  const { bot } = ctx
  const name = typeof item === 'string' ? item : bot.inventory.items().find(i => item.test(i.name))?.name
  if (!name || !bot.inventory.items().some(i => i.name === name)) return 'missing'
  try {
    return await placeAt(ctx, pos, name, { solid: false })
  } catch (err) {
    if (err instanceof CancelledError) throw err
    return /ran out/.test(err.message) ? 'missing' : 'blocked'
  }
}

// Build (or continue) the line. Returns a status object.
async function buildSection (ctx, proj, { onStatus = () => {}, save = () => {} } = {}) {
  const { bot } = ctx
  const missing = {}
  let laid = 0
  const total = proj.cols.length
  while (proj.built < total) {
    ctx.check()
    // Make sure the next stretch is loaded and laid out.
    const nextCol = proj.cols[Math.min(proj.built + SEGMENT, total - 1)]
    const target = proj.cols[proj.built]
    await ensureLoaded(ctx, new Vec3(target.x, proj.rails[proj.built - 1]?.y ?? proj.startY, target.z))
    if (proj.rails.length < Math.min(total, proj.built + SEGMENT)) extendLayout(bot, proj)
    if (proj.rails.length <= proj.built) {
      await ensureLoaded(ctx, new Vec3(nextCol.x, proj.startY, nextCol.z))
      extendLayout(bot, proj)
      if (proj.rails.length <= proj.built) throw new Error('the next part of the route is not loaded and I could not get there')
    }
    const from = proj.built
    const to = Math.min(proj.rails.length, from + SEGMENT)

    // Parts for this section: craft what we can.
    const sec = proj.rails.slice(from, to)
    const wantPowered = sec.filter(r => r.kind !== 'rail').length
    const wantTorches = sec.filter(r => r.kind === 'powered').length
    const wantRails = sec.length - wantPowered
    if (countItem(bot, 'rail') < wantRails || countItem(bot, 'powered_rail') < wantPowered || countItem(bot, 'redstone_torch') < wantTorches) {
      onStatus('crafting rails')
      await craftParts(ctx, wantRails, wantPowered, wantTorches)
    }

    // Terrain: tunnel, level, bridge.
    onStatus(`preparing track ${from}-${to} of ${total}`)
    const plan = { cells: sectionCells(proj, from, to), digOrder: null }
    const stats = await B.runBlueprint(ctx, plan, { onStatus: (t) => onStatus(`track ${from}/${total}: ${t}`) })
    for (const [g, c] of Object.entries(stats.missing)) missing[g] = (missing[g] || 0) + c
    if (Object.keys(stats.missing).length) break

    // Rails, in order, then torches and buttons.
    let stop = false
    for (let i = from; i < to; i++) {
      ctx.check()
      const r = proj.rails[i]
      const pos = new Vec3(r.x, r.y, r.z)
      const cur = bot.blockAt(pos)
      const item = r.kind === 'rail' ? RAIL_ITEMS.rail : RAIL_ITEMS.powered
      if (cur && /rail$/.test(cur.name)) continue
      onStatus(`laying rail ${i + 1}/${total}`)
      const res = await placePart(ctx, pos, item)
      if (res === 'missing') { missing[item] = (missing[item] || 0) + (to - i); stop = true; break }
      if (res === 'placed') laid++
    }
    if (stop) break
    for (let i = from; i < to; i++) {
      const r = proj.rails[i]
      const dir = new Vec3(r.dx, 0, r.dz)
      const p = new Vec3(r.x, r.y, r.z)
      if (r.kind === 'powered') {
        const s = p.plus(sideOf(dir))
        const b = bot.blockAt(s)
        if (b && /redstone.*torch/.test(b.name)) continue
        const res = await placePart(ctx, s, RAIL_ITEMS.torch)
        if (res === 'missing') missing.redstone_torch = (missing.redstone_torch || 0) + 1
      }
      if (r.kind === 'brake') {
        const s = p.plus(sideOf(dir))
        const b = bot.blockAt(s)
        if (b && /_button$/.test(b.name)) continue
        const res = await placePart(ctx, s, RAIL_ITEMS.button)
        if (res === 'missing') missing.button = 1
      }
    }
    proj.built = to
    proj.laid = (proj.laid || 0) + laid
    save()
  }
  return { missing, laid, done: proj.built >= total }
}

module.exports = { inZoneXZ, lRoute, planRoute, stationPoint, estimate, materialCheck, extendLayout, sectionCells, buildSection, countItem, sideOf, SEGMENT, POWER_EVERY }
