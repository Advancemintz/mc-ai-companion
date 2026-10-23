'use strict'

// More of a real farm: a melon and pumpkin patch, sugar cane along the water, and fenced animal
// pens that the bot fills by luring animals in with their food (the way players do it).

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const TILLABLE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|farmland)$/
const COVER = /^(short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|dead_bush|snow)$/
const OPEN = (b) => !!b && (b.name === 'air' || COVER.test(b.name))

const PATCH = {
  melon: { seed: 'melon_seeds', stem: /^(attached_)?melon_stem$/, fruit: 'melon', produce: 'melon_slice' },
  pumpkin: { seed: 'pumpkin_seeds', stem: /^(attached_)?pumpkin_stem$/, fruit: 'pumpkin', produce: 'pumpkin' }
}

const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const pickup = (ctx) => require('./actions').helpers.pickupNearbyItems(ctx, 6)

async function reach (ctx, pos) {
  if (ctx.bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4) return
  await goto(ctx, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2.5), 45000)
}

// A free, flat, open rectangle of ground near `near`, w wide (x) and d deep (z), outside every
// protected area and away from the farm plot. Returns the corner (lowest x, z) or null.
function findPlot (bot, memory, near, w, d, { avoid = [] } = {}) {
  const o = near.floored()
  let best = null
  for (let dx = -16; dx <= 16; dx++) {
    for (let dz = -16; dz <= 16; dz++) {
      const col = T.columnInfo(bot, o.x + dx, o.z + dz, o.y, 6)
      if (!col || col.water || col.roofed) continue
      const corner = new Vec3(o.x + dx, col.y, o.z + dz)
      let ok = true
      for (let x = 0; x < w && ok; x++) {
        for (let z = 0; z < d && ok; z++) {
          const p = corner.offset(x, 0, z)
          const g = bot.blockAt(p)
          if (!g || !TILLABLE.test(g.name) || !OPEN(bot.blockAt(p.offset(0, 1, 0)))) ok = false
          else if (Z.zoneAt(memory, p) || avoid.some(a => Math.abs(a.x - p.x) <= a.r && Math.abs(a.z - p.z) <= a.r)) ok = false
        }
      }
      if (!ok) continue
      const dist = corner.distanceTo(o)
      if (dist < 4) continue
      if (!best || dist < best.dist) best = { corner, dist }
    }
  }
  return best?.corner || null
}

function farmAvoid (memory) {
  const f = memory?.getProject('farm')
  return f ? [{ x: f.center.x, z: f.center.z, r: (f.radius || 4) + 2 }] : []
}

// ------------------------------------------------------------------ melons and pumpkins

// The patch is 7 wide and 3 deep: stems in the middle row every other block, with free ground
// all around them for the fruit to grow onto.
function patchStems (proj) {
  const c = new Vec3(proj.corner.x, proj.corner.y, proj.corner.z)
  return [1, 3, 5].map(x => c.offset(x, 0, 1))
}

async function tendPatch (ctx, kind, stats) {
  const { bot } = ctx
  const mem = ctx.memory
  const spec = PATCH[kind]
  const key = `${kind}_patch`
  let proj = mem?.getProject(key) || bot[`_${key}`]
  if (!proj) {
    if (!count(bot, spec.seed)) throw new Error(`I need ${spec.seed} to start a ${kind} patch (break ${kind === 'melon' ? 'a melon' : 'a pumpkin'} or find seeds)`)
    const home = mem?.getPlace('farm') || mem?.getPlace('home')
    const near = home ? new Vec3(home.x, home.y, home.z) : bot.entity.position
    const corner = findPlot(bot, mem, near, 7, 3, { avoid: farmAvoid(mem) })
    if (!corner) throw new Error(`no free flat ground near the farm for a ${kind} patch (it needs 7x3)`)
    proj = { style: 'patch', kind, corner: { x: corner.x, y: corner.y, z: corner.z }, createdAt: new Date().toISOString() }
    if (mem) { mem.saveProject(key, proj); Z.invalidate() } else bot[`_${key}`] = proj
    stats.notes.push(`started a ${kind} patch at ${corner.x} ${corner.y} ${corner.z}`)
  }
  const c = new Vec3(proj.corner.x, proj.corner.y, proj.corner.z)
  // Harvest fruit anywhere around the stems; leave the stems to grow more.
  for (let x = -1; x <= 7; x++) {
    for (let z = -1; z <= 3; z++) {
      const p = c.offset(x, 1, z)
      const b = bot.blockAt(p)
      if (!b || b.name !== spec.fruit) continue
      ctx.check()
      await reach(ctx, p)
      const axe = bot.inventory.items().find(i => /_axe$/.test(i.name))
      if (axe) { try { await bot.equip(axe, 'hand') } catch {} }
      try { await ctx.race(bot.dig(b, true), 6000); stats.harvested[spec.produce] = (stats.harvested[spec.produce] || 0) + 1; ctx.skills?.award('farming', 2) } catch (err) { if (err instanceof CancelledError) throw err }
    }
  }
  // Replant any stem that's missing.
  const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'))
  for (const p of patchStems(proj)) {
    ctx.check()
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (above && spec.stem.test(above.name)) continue
    if (!count(bot, spec.seed)) break
    const g = bot.blockAt(p)
    if (g && g.name !== 'farmland' && hoe) {
      await reach(ctx, p)
      await bot.equip(hoe, 'hand')
      try { await ctx.race(bot.activateBlock(g, new Vec3(0, 1, 0)), 4000) } catch (err) { if (err instanceof CancelledError) throw err }
    }
    if (bot.blockAt(p)?.name !== 'farmland') continue
    const seed = bot.inventory.items().find(i => i.name === spec.seed)
    await reach(ctx, p)
    await bot.equip(seed, 'hand')
    try { await ctx.race(bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0)), 4000); stats.planted[kind] = (stats.planted[kind] || 0) + 1 } catch (err) { if (err instanceof CancelledError) throw err }
  }
  await pickup(ctx)
}

// ------------------------------------------------------------------ sugar cane

const CANE_GROUND = /^(grass_block|dirt|coarse_dirt|sand|red_sand|podzol|mud)$/

function caneSpots (bot, memory, near) {
  const ids = ['water'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  const waters = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 24, count: 200, point: near }) : []
  const spots = []
  const seen = new Set()
  for (const w of waters) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const g = w.offset(dx, 0, dz)
      const k = g.toString()
      if (seen.has(k)) continue
      seen.add(k)
      const gb = bot.blockAt(g)
      const above = bot.blockAt(g.offset(0, 1, 0))
      if (!gb || !CANE_GROUND.test(gb.name) || !above || !(above.name === 'air' || above.name === 'sugar_cane' || COVER.test(above.name))) continue
      if (Z.zoneAt(memory, g) && !memory?.getProject('farm')) continue
      spots.push(g)
    }
  }
  return spots.sort((a, b) => a.distanceTo(near) - b.distanceTo(near)).slice(0, 8)
}

async function tendCane (ctx, stats) {
  const { bot } = ctx
  const mem = ctx.memory
  let proj = mem?.getProject('cane') || bot._caneProject
  if (!proj) {
    if (!count(bot, 'sugar_cane')) throw new Error('I need some sugar cane to plant (it grows wild beside water)')
    const home = mem?.getPlace('farm') || mem?.getPlace('home')
    const near = home ? new Vec3(home.x, home.y, home.z) : bot.entity.position.floored()
    const spots = caneSpots(bot, mem, near)
    if (!spots.length) throw new Error('no dirt or sand right next to water nearby to plant sugar cane on')
    proj = { style: 'cane', spots: spots.map(p => ({ x: p.x, y: p.y, z: p.z })), createdAt: new Date().toISOString() }
    if (mem) mem.saveProject('cane', proj); else bot._caneProject = proj
    stats.notes.push(`picked ${spots.length} spots by the water for sugar cane`)
  }
  for (const s of proj.spots) {
    ctx.check()
    const g = new Vec3(s.x, s.y, s.z)
    const second = bot.blockAt(g.offset(0, 2, 0))
    if (second?.name === 'sugar_cane') {
      // Cut from the second block up and leave the bottom one to regrow.
      await reach(ctx, g.offset(0, 1, 0))
      let n = 0
      for (let y = 4; y >= 2; y--) if (bot.blockAt(g.offset(0, y, 0))?.name === 'sugar_cane') n++
      try { await ctx.race(bot.dig(second, true), 4000); stats.harvested.sugar_cane = (stats.harvested.sugar_cane || 0) + n; ctx.skills?.award('farming', 0.5 * n) } catch (err) { if (err instanceof CancelledError) throw err }
      continue
    }
    if (bot.blockAt(g.offset(0, 1, 0))?.name === 'sugar_cane' || !count(bot, 'sugar_cane')) continue
    const cane = bot.inventory.items().find(i => i.name === 'sugar_cane')
    await reach(ctx, g)
    await bot.equip(cane, 'hand')
    try { await ctx.race(bot.placeBlock(bot.blockAt(g), new Vec3(0, 1, 0)), 4000); stats.planted.sugar_cane = (stats.planted.sugar_cane || 0) + 1 } catch (err) { if (err instanceof CancelledError) throw err }
  }
  await pickup(ctx)
}

// ------------------------------------------------------------------ pens

const PEN = 7 // fence ring size (5x5 inside)

function penRing (corner) {
  const out = []
  for (let x = 0; x < PEN; x++) {
    for (let z = 0; z < PEN; z++) {
      if (x !== 0 && z !== 0 && x !== PEN - 1 && z !== PEN - 1) continue
      out.push(corner.offset(x, 1, z))
    }
  }
  return out
}
const penGate = (corner) => corner.offset(Math.floor(PEN / 2), 1, PEN - 1) // middle of the south side
const penInside = (corner, p) => p.x > corner.x && p.x < corner.x + PEN - 1 && p.z > corner.z && p.z < corner.z + PEN - 1

function animalsInPen (bot, kind, corner) {
  return Object.values(bot.entities || {}).filter(e => e?.name === kind && e.position && penInside(corner, e.position.floored()) && Math.abs(e.position.y - corner.y - 1) < 3)
}

async function setGap (ctx, corner, open) {
  const { bot } = ctx
  const g = penGate(corner)
  const b = bot.blockAt(g)
  if (/_fence_gate$/.test(b?.name || '')) {
    const isOpen = !!b.getProperties?.().open
    if (isOpen !== open) { await reach(ctx, g.offset(0, -1, 0)); try { await bot.activateBlock(b) } catch {} }
    return true
  }
  if (open) {
    if (b && /_fence$/.test(b.name)) { await reach(ctx, g.offset(0, -1, 0)); try { await ctx.race(bot.dig(b, true), 4000) } catch (err) { if (err instanceof CancelledError) throw err } await pickup(ctx) }
    return true
  }
  const gate = bot.inventory.items().find(i => /_fence_gate$/.test(i.name)) || bot.inventory.items().find(i => /_fence$/.test(i.name))
  if (!gate) return false
  try { return await placeAt(ctx, g, gate.name, { solid: false }) === 'placed' } catch (err) { if (err instanceof CancelledError) throw err; return false }
}

// Bring animals of `kind` into the pen until it holds `target`. Holding their food makes them
// follow (if they're close enough to notice); a lead works for any animal at any distance.
// Returns how many came in.
async function lureInto (ctx, corner, kind, foods, target, notes = [], { leads = false } = {}) {
  const { bot } = ctx
  const gate = penGate(corner)
  const outsideGate = gate.offset(0, 0, 2)
  const middle = corner.offset(3, 1, 3)
  let lured = 0
  let tries = 0
  while (animalsInPen(bot, kind, corner).length < target && tries < target + 3) {
    ctx.check()
    tries++
    const food = bot.inventory.items().find(i => foods.includes(i.name))
    const lead = leads ? bot.inventory.items().find(i => i.name === 'lead') : null
    if (!food && !lead) { notes.push(`no ${foods.join(' or ')} to lure them with`); break }
    const inside = new Set(animalsInPen(bot, kind, corner).map(e => e.id))
    const outside = Object.values(bot.entities || {}).filter(e => e?.name === kind && !inside.has(e.id) && e.position.distanceTo(bot.entity.position) < 48 &&
      !require('./husbandry').protectedReason(ctx, e, { ignorePens: true }))
      .sort((a, b) => a.position.distanceTo(corner) - b.position.distanceTo(corner))
    if (!outside.length) { if (!lured) notes.push(`no ${kind}s nearby to bring in`); break }
    const a = outside[0]
    // Far away (or no food): a lead is surer than hoping it notices the food.
    const useLead = !!lead && (!food || a.position.distanceTo(corner) > 16)
    await setGap(ctx, corner, true)
    ctx.setStatus(`${useLead ? 'leading' : 'luring'} a ${kind} into the pen`)
    if (!useLead) await bot.equip(food, 'hand')
    try { await goto(ctx, new goals.GoalFollow(a, useLead ? 2 : 3), 30000) } catch (err) { if (err instanceof CancelledError) throw err; continue }
    if (useLead) {
      await bot.equip(lead, 'hand')
      try { await bot.activateEntity(a) } catch {}
    }
    await ctx.sleep(800) // let it notice the food
    try {
      await goto(ctx, new goals.GoalNear(outsideGate.x, outsideGate.y, outsideGate.z, 1), 40000)
      await goto(ctx, new goals.GoalNear(middle.x, middle.y, middle.z, 1), 20000)
      await ctx.sleep(1500) // it follows us in
      if (useLead) { try { await bot.activateEntity(a) } catch {} await ctx.sleep(300) } // unclip the lead
      // Put the food away so it stops following, then slip out and shut the gate.
      try { await bot.unequip('hand') } catch {}
      await goto(ctx, new goals.GoalNear(outsideGate.x, outsideGate.y, outsideGate.z, 1), 20000)
    } catch (err) { if (err instanceof CancelledError) throw err }
    await setGap(ctx, corner, false)
    if (animalsInPen(bot, kind, corner).some(e => e.id === a.id)) { lured++; ctx.skills?.award('farming', 2, `penned a ${kind}`) }
  }
  if (!lured && tries === 0) await setGap(ctx, corner, false)
  return lured
}

const buildPenAction = {
  description: 'Build (or top up) a fenced pen near home for one kind of animal and lure them in by holding their food (cows/sheep: wheat, pigs: carrots, chickens: seeds). The pen is 7x7 with a gate (needs about 24 fences, a fence gate if you have one). Later calls bring more animals in. Animals in a pen are easy to breed and never wander off.',
  params: { animal: 'cow | sheep | pig | chicken | rabbit ...', count: 'how many to have in it (default 4)' },
  timeoutSeconds: 600,
  run: async (ctx, { animal, count: want }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const { ANIMAL_FOOD } = require('./farming')
    const kind = String(animal || '').toLowerCase().replace(/s$/, '').replace(/^cattle$/, 'cow')
    const foods = ANIMAL_FOOD[kind]
    if (!foods) throw new Error(`I don't know how to pen "${animal}". Try: ${Object.keys(ANIMAL_FOOD).join(', ')}`)
    const target = Math.max(2, Math.min(10, Math.round(Number(want) || 4)))
    const key = `pen_${kind}`
    let proj = mem?.getProject(key) || bot[`_${key}`]
    const notes = []
    if (!proj) {
      const fences = bot.inventory.items().filter(i => /_fence$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      if (fences < 23) throw new Error(`a pen needs about 24 fences and I have ${fences} (fences: 4 planks + 2 sticks make 3)`)
      const home = mem?.getPlace('farm') || mem?.getPlace('home')
      const near = home ? new Vec3(home.x, home.y, home.z) : bot.entity.position
      const others = Object.entries(mem?.data.projects || {}).filter(([k, p]) => p.style === 'pen').map(([, p]) => ({ x: p.corner.x + 3, z: p.corner.z + 3, r: 5 }))
      const corner = findPlot(bot, mem, near, PEN, PEN, { avoid: [...farmAvoid(mem), ...others] })
      if (!corner) throw new Error('no free flat 7x7 spot near home for a pen')
      proj = { style: 'pen', kind, corner: { x: corner.x, y: corner.y, z: corner.z }, createdAt: new Date().toISOString() }
      if (mem) { mem.saveProject(key, proj); mem.setPlace(key, corner.offset(3, 1, 3), bot.game?.dimension, `my ${kind} pen`); Z.invalidate() } else bot[`_${key}`] = proj
      notes.push(`built a ${kind} pen at ${corner.x} ${corner.y} ${corner.z}`)
    }
    const corner = new Vec3(proj.corner.x, proj.corner.y, proj.corner.z)
    // Fence it in (skipping the gate spot), then hang the gate.
    const gate = penGate(corner)
    let posts = 0
    for (const p of penRing(corner)) {
      ctx.check()
      if (p.equals(gate)) continue
      const b = bot.blockAt(p)
      if (!b || /_fence$/.test(b.name) || !OPEN(b)) continue
      const fence = bot.inventory.items().find(i => /_fence$/.test(i.name))
      if (!fence) { notes.push('ran out of fences'); break }
      try { if (await placeAt(ctx, p, fence.name, { solid: false }) === 'placed') posts++ } catch (err) { if (err instanceof CancelledError) throw err }
    }
    if (posts) ctx.skills?.award('farming', 4)
    const leads = !!ctx.skills?.params('farming')?.leads || !ctx.skills
    const lured = await lureInto(ctx, corner, kind, foods, target, notes, { leads })
    const now = animalsInPen(bot, kind, corner).length
    proj.lastCount = now
    mem?.saveProject(key, proj)
    return `${notes.length ? notes.join('; ') + '. ' : ''}The ${kind} pen at ${corner.x} ${corner.y} ${corner.z} has ${now} ${kind}${now === 1 ? '' : 's'}${lured ? ` (lured ${lured} in)` : ''}${now >= 2 ? '; breed them with breed_animals while standing by the pen' : ''}.`
  }
}

module.exports = { PATCH, tendPatch, tendCane, caneSpots, buildPenAction, penRing, penGate, penInside, animalsInPen, findPlot, lureInto, setGap, OPEN, PEN }
