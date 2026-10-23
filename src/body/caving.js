'use strict'

// Caving: the other way players get ore. Walk into a cave, light the way with torches, take the
// ore you can see on the walls, go a bit deeper when there's nothing in sight, and come back out
// the way you came (the torches and remembered waypoints are the breadcrumbs).
//
// It turns back when the trip is long enough, it's gone as far as it dares, it's hurt or hungry,
// its torches or pickaxe are running out, or its pockets are full. How long and how deep it goes,
// and which ores it knows to look for, come from the mining tier.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const M = require('./mining')
const SV = require('./survival')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const OPEN = (b) => !!b && (b.name === 'air' || b.name === 'cave_air')
const ORE_VALUE = { diamond: 10, emerald: 9, gold: 6, redstone: 5, lapis: 5, iron: 4, copper: 2, coal: 2 }
const ORE_XP = { diamond: 15, emerald: 15, gold: 6, redstone: 5, lapis: 5, iron: 4, copper: 3, coal: 2 }
const oreKind = (name) => (name.match(/(diamond|emerald|gold|redstone|lapis|iron|copper|coal)_ore$/) || [])[1] || null

function exposed (bot, p) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (OPEN(bot.blockAt(p.offset(...d)))) return true
  return false
}

function nearLava (bot, p) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (bot.blockAt(p.offset(...d))?.name === 'lava') return true
  return false
}

const standable = (bot, p) => T.isFirm(bot.blockAt(p.offset(0, -1, 0))) && OPEN(bot.blockAt(p)) && OPEN(bot.blockAt(p.offset(0, 1, 0)))

function roofed (bot, p) {
  for (let k = 2; k <= 10; k++) if (T.isFirm(bot.blockAt(p.offset(0, k, 0)))) return true
  return false
}

// The way in: a place you name, the nearest cave you've found exploring, or one right here.
function findMouth (ctx, at) {
  const { bot } = ctx
  const mem = ctx.memory
  if (at) {
    const p = mem?.getPlace(at)
    if (!p) throw new Error(`I don't remember a place called "${at}"`)
    return { pos: new Vec3(p.x, p.y, p.z), name: at }
  }
  const dim = String(bot.game?.dimension || 'overworld').replace('minecraft:', '')
  const known = (mem?.discoveriesNear(bot.entity.position, dim, 20) || []).filter(d => d.kind === 'cave' && d.distance <= 256)
  if (known.length) return { pos: new Vec3(known[0].x, known[0].y, known[0].z), name: `the cave at ${known[0].x} ${known[0].y} ${known[0].z}`, discovery: known[0] }
  const ex = require('./explore')
  const found = ex.scan(ctx, { notices: ['cave'], scanRadius: 24 }).find(f => f.kind === 'cave')
  if (found) return { pos: found.pos, name: `the cave at ${found.pos.x} ${found.pos.y} ${found.pos.z}` }
  return null
}

function pickaxeOk (bot) {
  const picks = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
  return picks.some(p => { const d = SV.durability(bot, p); return !d || d.left > 4 })
}

async function digOre (ctx, p, stats, skill) {
  const { bot } = ctx
  const b = bot.blockAt(p)
  if (!b || !oreKind(b.name)) return 0
  if (b.harvestTools && !bot.inventory.items().some(i => b.harvestTools[i.type])) { stats.tooHard.add(b.name); return 0 }
  await goto(ctx, new goals.GoalLookAtBlock(p, bot.world), 25000)
  let n = 0
  const vein = [p, ...M.findVein(bot, [p], (name) => name === b.name, skill.veinLimit || 8)]
  for (const q of vein) {
    ctx.check()
    const qb = bot.blockAt(q)
    if (!qb || qb.name !== b.name || nearLava(bot, q)) continue
    try {
      if (bot.entity.position.distanceTo(q.offset(0.5, 0.5, 0.5)) > 4.5) await goto(ctx, new goals.GoalLookAtBlock(q, bot.world), 15000)
      if (bot.tool?.equipForBlock) { try { await bot.tool.equipForBlock(qb, {}) } catch {} }
      await ctx.race(bot.dig(qb, true), 10000)
      n++
      const k = oreKind(qb.name)
      stats.mined[qb.name] = (stats.mined[qb.name] || 0) + 1
      ctx.skills?.award('mining', ORE_XP[k] || 1)
    } catch (err) {
      if (err instanceof CancelledError) throw err
    }
  }
  await require('./actions').helpers.pickupNearbyItems(ctx, 6)
  return n
}

async function lightHere (ctx, stats) {
  const { bot } = ctx
  if (!bot.inventory.items().some(i => i.name === 'torch')) return false
  const feet = bot.entity.position.floored()
  for (const p of [feet, feet.offset(1, 0, 0), feet.offset(-1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1)]) {
    if (!OPEN(bot.blockAt(p)) || !T.isFirm(bot.blockAt(p.offset(0, -1, 0)))) continue
    try {
      if (await placeAt(ctx, p, 'torch', { solid: false }) === 'placed') { stats.torches++; return true }
    } catch (err) {
      if (err instanceof CancelledError) throw err
    }
  }
  return false
}

function turnBack (bot, { started, skill, mouth, lastTorch }) {
  if (Date.now() - started > skill.minutes * 60000) return 'the trip had gone on long enough'
  if (bot.health <= 12) return 'I got hurt'
  const hasFood = bot.inventory.items().some(i => bot.registry.foodsByName?.[i.name])
  if (bot.food <= 6 && !hasFood) return 'I was getting hungry'
  if (bot.inventory.emptySlotCount() <= 1) return 'my pockets were full'
  if (!pickaxeOk(bot)) return 'my pickaxe was about to break'
  const torches = bot.inventory.items().filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0)
  if (torches === 0 && bot.entity.position.distanceTo(lastTorch) > 10) return 'I ran out of torches'
  if (bot.entity.position.distanceTo(mouth) > skill.reach) return 'I had gone as deep as I dare'
  return null
}

const caveAction = {
  description: 'Go caving: walk into a cave you found while exploring (or one right here, or a saved place named in at), light the way with torches, mine the ore you can see on the walls, go deeper when there is none in sight, and come back out the way you came. Turns back when hurt, hungry, out of torches, pickaxe nearly broken, pockets full, or deep enough. Bring torches (at least 4), food and a pickaxe.',
  params: { at: 'optional: name of a saved place to start from' },
  timeoutSeconds: 1500,
  run: async (ctx, { at }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const skill = ctx.skills?.params('mining') || { cave: { minutes: 6, reach: 80, ores: Object.keys(ORE_VALUE) }, veinLimit: 16, torchEvery: 8 }
    if (!skill.cave) ctx.skills.require('mining', 2, 'caving')
    const cave = skill.cave
    if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) throw new Error('caving needs a pickaxe')
    if (!pickaxeOk(bot)) throw new Error('my pickaxe is about to break; make a new one first (upgrade_gear)')
    const torches = bot.inventory.items().filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0)
    if (torches < 4) throw new Error(`I need at least 4 torches to go caving (I have ${torches}); torches are coal + sticks`)
    if (bot.health < 14) throw new Error("I'm too hurt to go caving. Heal up first")
    const mouth = findMouth(ctx, at)
    if (!mouth) throw new Error("I don't know any caves nearby. Explore to find one (explore remembers caves), or walk me to one")

    const stats = { mined: {}, torches: 0, tooHard: new Set() }
    const oreNames = Object.keys(bot.registry.blocksByName).filter(n => cave.ores.includes(oreKind(n)))
    const oreIds = oreNames.map(n => bot.registry.blocksByName[n].id)
    ctx.setStatus(`heading to ${mouth.name}`)
    if (bot.entity.position.distanceTo(mouth.pos) > 4) await goto(ctx, new goals.GoalNear(mouth.pos.x, mouth.pos.y, mouth.pos.z, 2), 300000)
    const entry = bot.entity.position.floored()
    const trail = [entry.clone()]
    const visited = new Set()
    const cellKey = (p) => `${Math.floor(p.x / 4)},${Math.floor(p.y / 4)},${Math.floor(p.z / 4)}`
    let lastTorch = entry.clone()
    const started = Date.now()
    let reason = null
    let dead = 0
    const skip = new Set()

    while (!reason) {
      ctx.check()
      reason = turnBack(bot, { started, skill: cave, mouth: entry, lastTorch })
      if (reason) break
      const here = bot.entity.position.floored()
      visited.add(cellKey(here))
      const total = Object.values(stats.mined).reduce((a, b) => a + b, 0)
      ctx.setStatus(`caving: ${Math.round(here.distanceTo(entry))} blocks in, ${total} ore`)

      // Light the way, and leave a breadcrumb.
      if (here.distanceTo(lastTorch) >= (skill.torchEvery || 8) + 2) {
        if (await lightHere(ctx, stats)) lastTorch = here.clone()
      }
      if (here.distanceTo(trail[trail.length - 1]) >= 6) trail.push(here.clone())

      // Ore in sight? Take it.
      const ores = bot.findBlocks({ matching: oreIds, maxDistance: 16, count: 60 })
        .filter(p => !skip.has(p.toString()) && exposed(bot, p) && !nearLava(bot, p) && !Z.zoneAt(mem, p) && Math.abs(p.y - here.y) <= 10 && !stats.tooHard.has(bot.blockAt(p)?.name))
        .sort((a, b) => (ORE_VALUE[oreKind(bot.blockAt(b).name)] || 0) - (ORE_VALUE[oreKind(bot.blockAt(a).name)] || 0) || a.distanceTo(here) - b.distanceTo(here))
      if (ores.length) {
        try {
          if (await digOre(ctx, ores[0], stats, skill)) { dead = 0; ctx.resumeArgs = { at }; continue }
        } catch (err) {
          if (err instanceof CancelledError) throw err
        }
        skip.add(ores[0].toString())
      }

      // Nothing here: go further in, preferring deeper ground we haven't been to.
      const fromEntry = here.distanceTo(entry)
      const spots = bot.findBlocks({ matching: ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined), maxDistance: 20, count: 400 })
        .filter(p => standable(bot, p) && roofed(bot, p) && !visited.has(cellKey(p)) && p.distanceTo(entry) >= fromEntry + 3 && !Z.zoneAt(mem, p))
        .sort((a, b) => (a.y - b.y) * 0.5 - (a.distanceTo(entry) - b.distanceTo(entry)))
      const next = spots[0]
      if (!next) { reason = 'the cave ran out (nowhere further to go)'; break }
      try {
        await goto(ctx, new goals.GoalNear(next.x, next.y, next.z, 1), 30000)
        dead = 0
      } catch (err) {
        if (err instanceof CancelledError) throw err
        visited.add(cellKey(next))
        if (++dead >= 4) reason = 'the way on was blocked'
      }
    }

    // Back out the way we came.
    ctx.setStatus(`heading back out (${reason})`)
    let out = true
    for (let i = trail.length - 1; i >= 0; i--) {
      ctx.check()
      const wp = trail[i]
      if (bot.entity.position.distanceTo(wp) <= 3) continue
      try {
        await goto(ctx, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 60000)
      } catch (err) {
        if (err instanceof CancelledError) throw err
        if (i === 0) out = false
      }
    }
    const list = Object.entries(stats.mined).map(([n, c]) => `${c} ${n}`).join(', ')
    const total = Object.values(stats.mined).reduce((a, b) => a + b, 0)
    if (mem) {
      const dim = String(bot.game?.dimension || 'overworld').replace('minecraft:', '')
      const d = mem.addDiscovery('cave', 'cave', entry, dim, '').entry
      d.note = `caved ${new Date().toISOString().slice(0, 10)}: ${total ? list : 'nothing left in sight'}`
      mem.save()
      mem.addJournal(`Went caving${total ? `: ${list}` : ''}.`)
    }
    if (out) ctx.skills?.award('mining', 4, 'came back out of a cave safely')
    const extra = [stats.torches ? `placed ${stats.torches} torches` : '', stats.tooHard.size ? `left some ore my pickaxe can't handle` : ''].filter(Boolean)
    return `went caving at ${mouth.name}: ${total ? `mined ${list}` : 'found no ore worth taking'}${extra.length ? `; ${extra.join(', ')}` : ''}. Came back ${out ? 'out' : 'part of the way'} because ${reason}.`
  }
}

module.exports = { caveAction, findMouth, exposed }
