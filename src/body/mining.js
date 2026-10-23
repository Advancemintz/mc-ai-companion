'use strict'

// A proper mine instead of random holes:
//   1. an entrance on the surface, away from any base, with a covered stairwell (walls, roof, doors)
//   2. a staircase down to the right depth for the ore you want (seals caves, water and lava)
//   3. branch mining at that depth: a main tunnel with side branches every 4 blocks,
//      digging out every ore vein it uncovers, lighting the way with torches
// The mine is a remembered project, so every call digs further into the same mine.

const { Vec3 } = require('vec3')
const B = require('./builder')
const T = require('./terrain')
const Z = require('./zones')
const { placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const TARGETS = {
  coal: { ores: ['coal_ore', 'deepslate_coal_ore'], y: 48 },
  copper: { ores: ['copper_ore', 'deepslate_copper_ore'], y: 48 },
  iron: { ores: ['iron_ore', 'deepslate_iron_ore'], y: 16 },
  lapis: { ores: ['lapis_ore', 'deepslate_lapis_ore'], y: 0 },
  gold: { ores: ['gold_ore', 'deepslate_gold_ore'], y: -16 },
  redstone: { ores: ['redstone_ore', 'deepslate_redstone_ore'], y: -58 },
  diamond: { ores: ['diamond_ore', 'deepslate_diamond_ore'], y: -58 },
  emerald: { ores: ['emerald_ore', 'deepslate_emerald_ore'], y: 16 },
  stone: { ores: ['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff'], y: null }
}
const BONUS = /^(deepslate_)?(coal|copper|iron|lapis|gold|redstone|diamond|emerald)_ore$/

function resolveTarget (q) {
  const s = String(q || 'iron').toLowerCase().replace(/^raw_|_ore$|^deepslate_|_ingot$|s$/g, '')
  if (TARGETS[s]) return s
  if (/cobble|rock/.test(s)) return 'stone'
  if (/lapis/.test(s)) return 'lapis'
  return null
}

// Staircase from the surface. Two blocks wide for the first steps (a proper entrance),
// one block wide below that. 3 blocks of headroom, a 3x3 landing at the bottom.
function shaftCells (depth) {
  const D = Math.max(3, depth)
  const map = new Map()
  const key = (r, u, f) => `${r},${u},${f}`
  const add = (ri, up, fi, role, extra = {}) => { if (!map.has(key(ri, up, fi)) || role !== 'shell') map.set(key(ri, up, fi), { rel: [ri, up, fi], role, ...extra }) }
  for (let i = 0; i < D; i++) {
    const s = 1 - i
    const cols = i < 5 ? [0, 1] : [0]
    for (const ri of cols) {
      for (let up = s; up <= s + 2; up++) add(ri, up, i, 'air')
      add(ri, s - 1, i, 'support')
    }
    if (i > 1 && i % 4 === 2) add(0, s + 1, i, 'light')
  }
  add(0, 1, 0, 'door'); add(1, 1, 0, 'door'); add(0, 2, 0, 'doortop'); add(1, 2, 0, 'doortop')
  const L = 1 - D
  for (let fi = D; fi < D + 3; fi++) {
    for (let ri = -1; ri <= 1; ri++) {
      for (let up = L; up <= L + 2; up++) add(ri, up, fi, 'air')
      add(ri, L - 1, fi, 'support')
    }
  }
  add(-1, L + 1, D + 1, 'light')
  const open = [...map.values()].filter(c => c.role !== 'support')
  for (const c of open) {
    for (const [dr, du, df] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const [r, u, f] = [c.rel[0] + dr, c.rel[1] + du, c.rel[2] + df]
      if (f < 0) continue
      if (!map.has(key(r, u, f))) add(r, u, f, 'shell')
    }
  }
  // Side walls one higher where the entrance sticks out of the ground (holds up its roof).
  for (let i = 0; i < Math.min(D, 4); i++) for (const ri of [-1, 2]) if (!map.has(key(ri, 4 - i, i))) add(ri, 4 - i, i, 'shell')
  return { cells: [...map.values()], inside: [0, L, D + 1], entrance: [0, 1, -1] }
}

// Choose an entrance: open ground, away from bases, with a clean path down.
function chooseMineSite (bot, memory, depth) {
  const me = bot.entity.position.floored()
  const home = memory?.getPlace('home')
  const awayFromHome = home ? new Vec3(me.x - home.x, 0, me.z - home.z) : null
  const dirs8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  let best = null
  for (const dist of [3, 7, 11, 15, 20]) {
    for (const [dx, dz] of dirs8) {
      const x = me.x + Math.round(dx * dist / Math.hypot(dx, dz))
      const z = me.z + Math.round(dz * dist / Math.hypot(dx, dz))
      const col = T.columnInfo(bot, x, z, me.y, 12)
      if (!col || col.water || col.roofed) continue
      const origin = new Vec3(x, col.y, z)
      if (Z.distanceToZones(memory, origin) < 6) continue
      for (const f of [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)]) {
        const plan = B.toWorld(shaftCells(depth), origin, f, B.rightOf(f))
        let lava = 0; let water = 0; let bad = false
        for (const c of plan.cells) {
          const b = bot.blockAt(c.pos)
          if (!b || b.name === 'bedrock') { bad = true; break }
          if (Z.zoneAt(memory, c.pos)) { bad = true; break }
          if (b.name === 'lava') lava++
          else if (b.name === 'water') water++
          else if (!B.isAirLike(b) && !B.NATURAL.test(b.name) && c.role !== 'shell') { bad = true; break }
        }
        if (bad) continue
        let cost = dist + lava * 15 + water * 2 + Math.abs(col.y - (me.y - 1)) * 2
        if (awayFromHome && (awayFromHome.x * f.x + awayFromHome.z * f.z) < 0) cost += 8 // tunnel heads back under the base
        if (!best || cost < best.cost) best = { origin, f, cost }
      }
    }
    if (best && best.cost < dist + 6) break
  }
  return best
}

// Branch-mining layout at one level: yields steps, each a list of block positions to dig.
function * branchSteps (start, dir, { spacing = 4, length = 6 } = {}) {
  const side = new Vec3(-dir.z, 0, dir.x)
  for (let k = 1; ; k++) {
    const p = start.plus(dir.scaled(k))
    yield { cells: [p, p.offset(0, 1, 0)], main: true, k }
    if (k % spacing === 0) {
      for (const s of [side, side.scaled(-1)]) {
        for (let j = 1; j <= length; j++) {
          const q = p.plus(s.scaled(j))
          yield { cells: [q, q.offset(0, 1, 0)], main: false, k }
        }
      }
    }
  }
}

function findVein (bot, from, isWanted, limit = 16) {
  const found = []
  const seen = new Set()
  const queue = []
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const p of from) for (const d of dirs) queue.push(p.offset(...d))
  while (queue.length && found.length < limit) {
    const p = queue.shift()
    const k = p.toString()
    if (seen.has(k)) continue
    seen.add(k)
    const b = bot.blockAt(p)
    if (!b || !isWanted(b.name)) continue
    found.push(p)
    for (const d of dirs) queue.push(p.offset(...d))
  }
  return found
}

module.exports = { TARGETS, BONUS, resolveTarget, shaftCells, chooseMineSite, branchSteps, findVein }

// The action itself lives here too, to keep mining logic in one place.
module.exports.mineAction = {
  description: 'Mine ores or stone the proper way: picks a spot away from bases, digs a clean covered stairwell (with doors and torches) down to the best depth for the target, then branch-mines there (strip-mines at the top tier), digging out every vein it finds. Remembers the mine and digs further on every call. target: coal, copper, iron, lapis, gold, redstone, diamond, emerald or stone. count: how many target blocks to get this trip (default 8).',
  params: { target: 'coal | copper | iron | lapis | gold | redstone | diamond | emerald | stone', count: 'how many (default 8)' },
  timeoutSeconds: 3000,
  run: async (ctx, args) => {
    const { bot } = ctx
    const mem = ctx.memory
    const target = resolveTarget(args.target)
    if (!target) throw new Error(`I don't know how to mine for "${args.target}". Try coal, iron, gold, diamond, redstone, lapis, copper or stone`)
    const spec = TARGETS[target]
    const wanted = Math.max(1, Math.min(64, Math.round(Number(args.count) || 8)))
    // Mining skill: which targets the bot knows how to go after, and how good its mines are.
    const skill = ctx.skills?.params('mining') || { targets: Object.keys(TARGETS), branchSpacing: 4, branchLength: 6, veinLimit: 16, torchEvery: 8 }
    if (!skill.targets.includes(target)) {
      if (!skill.targets.length) ctx.skills.require('mining', 2, 'digging my own mine')
      throw new Error(`I don't know how to mine for ${target} yet; I can go after: ${skill.targets.join(', ')}. (Mining more will improve that.)`)
    }

    // Tool check: the pickaxe must be good enough to actually drop the ore.
    const sample = bot.registry.blocksByName[spec.ores[0]]
    const pick = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
    if (!pick.length) throw new Error('mining needs a pickaxe')
    if (sample?.harvestTools && !pick.some(i => sample.harvestTools[i.type])) {
      const need = Object.keys(sample.harvestTools).map(id => bot.registry.items[id]?.name).filter(Boolean)
      throw new Error(`my pickaxe is too weak for ${target}; I need one of: ${need.filter(n => !/golden/.test(n)).slice(0, 3).join(', ')}`)
    }

    // ---- the mine project
    let proj = mem?.getProject('mine') || bot._mineProject || null
    if (!proj) {
      const c = T.cover(bot)
      if (c.kind === 'underground' || c.kind === 'indoors') throw new Error('I need to start a mine from the surface. Use go_to_surface first')
      const surfaceY = bot.entity.position.floored().y - 1
      const levelY = spec.y ?? surfaceY - 8
      const depth = Math.max(4, surfaceY + 1 - levelY)
      const site = chooseMineSite(bot, mem, depth)
      if (!site) throw new Error('no good spot for a mine entrance within 20 blocks (bases, water, lava or other people\'s builds in the way). Move a bit and try again')
      proj = { style: 'mine', origin: { x: site.origin.x, y: site.origin.y, z: site.origin.z }, f: { x: site.f.x, z: site.f.z }, depth, levels: {}, status: 'in progress', progress: 0, createdAt: new Date().toISOString() }
    }
    const origin = new Vec3(proj.origin.x, proj.origin.y, proj.origin.z)
    const f = new Vec3(proj.f.x, 0, proj.f.z)
    const r = B.rightOf(f)
    let levelY = spec.y ?? (proj.origin.y - 7)
    levelY = Math.max(levelY, -58)
    const neededDepth = Math.max(4, origin.y + 1 - levelY)
    if (neededDepth > proj.depth) proj.depth = neededDepth // dig the stairs further down
    const save = () => { if (mem) mem.saveProject('mine', proj); else bot._mineProject = proj }
    save()
    if (mem && !mem.getPlace('mine_entrance')) mem.setPlace('mine_entrance', origin.offset(0, 1, 0).minus(f), bot.game?.dimension, 'entrance to my mine')

    // ---- 1. entrance + stairs
    const plan = B.toWorld(shaftCells(proj.depth), origin, f, r)
    plan.digOrder = (a, b) => a.rel[2] - b.rel[2]
    ctx.setStatus('digging the mine entrance and stairs')
    const shaftStats = await B.runBlueprint(ctx, plan, { onStatus: (t) => ctx.setStatus(`mine stairs: ${t}`) })

    // ---- 2. branch mining at the target level
    const stepIndex = origin.y + 1 - levelY // stair step whose standing level is levelY
    const key = String(levelY)
    let level = proj.levels[key]
    if (!level) {
      let start, dir
      if (stepIndex >= proj.depth) {
        // bottom: continue straight on from the landing
        start = origin.plus(f.scaled(proj.depth + 2)).offset(0, levelY - origin.y, 0)
        dir = f
      } else {
        // a level part way down: branch off sideways from the stairs
        start = origin.plus(f.scaled(stepIndex)).offset(0, levelY - origin.y, 0)
        dir = r.scaled(-1)
      }
      // The layout is fixed per level when it's started, so resuming never scrambles the tunnels.
      level = proj.levels[key] = { start: { x: start.x, y: start.y, z: start.z }, dir: { x: dir.x, z: dir.z }, progress: 0, mined: {}, spacing: skill.branchSpacing, length: skill.branchLength }
      if (mem) mem.setPlace(`mine_y${levelY}`, start, bot.game?.dimension, `branch mine level for ${target}`)
      save()
    }
    const start = new Vec3(level.start.x, level.start.y, level.start.z)
    const dir = new Vec3(level.dir.x, 0, level.dir.z)
    const wantedName = (n) => spec.ores.includes(n)
    const anyOre = (n) => wantedName(n) || BONUS.test(n)

    const stats = { dug: 0, placed: 0, sealed: 0, missing: {}, warnings: new Set(), flooded: new Set() }
    const got = {}
    let gotTarget = 0
    let steps = 0
    const gen = branchSteps(start, dir, { spacing: level.spacing || 4, length: level.length || 6 })
    const ORE_XP = { diamond: 15, emerald: 15, gold: 6, redstone: 5, lapis: 5, iron: 4, copper: 3, coal: 2 }
    const oreXp = (n) => { const m = n.match(/(diamond|emerald|gold|redstone|lapis|iron|copper|coal)_ore$/); return m ? ORE_XP[m[1]] : 0.2 }
    for (let i = 0; i < level.progress; i++) gen.next()

    while (gotTarget < wanted && steps < 90) {
      ctx.check()
      if (bot.inventory.emptySlotCount() <= 1) { stats.warnings.add('inventory full'); break }
      // Stop before the last good pickaxe breaks, like anyone who doesn't want to walk home empty-handed.
      if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe') && (() => { const d = require('./survival').durability(bot, i); return !d || d.left > 4 })())) {
        stats.warnings.add('stopped because my pickaxe is about to break (make a new one with upgrade_gear)'); break
      }
      const step = gen.next().value
      for (const p of step.cells) {
        const b = bot.blockAt(p)
        if (b && anyOre(b.name)) { got[b.name] = (got[b.name] || 0) + 1; if (wantedName(b.name)) gotTarget++; ctx.skills?.award('mining', oreXp(b.name)) }
        await B.digCell(ctx, p, new Set(), stats)
      }
      // Keep a floor under the tunnel (don't fall into caves).
      const floor = step.cells[0].offset(0, -1, 0)
      if (!T.isFirm(bot.blockAt(floor))) {
        const mat = B.pickMaterial(bot, 'shell')
        if (mat) { try { await placeAt(ctx, floor, mat) } catch (err) { if (err instanceof CancelledError) throw err } }
      }
      // Dig out ore veins uncovered in the walls, floor and ceiling.
      const vein = findVein(bot, step.cells, anyOre, skill.veinLimit)
      for (const p of vein) {
        const b = bot.blockAt(p)
        if (!b) continue
        got[b.name] = (got[b.name] || 0) + 1
        if (wantedName(b.name)) gotTarget++
        ctx.skills?.award('mining', oreXp(b.name))
        try { await B.digCell(ctx, p, new Set(), stats) } catch (err) { if (err instanceof CancelledError) throw err }
      }
      if (vein.length) await pickupDrops(ctx)
      // Torches every 8 blocks along the main tunnel.
      if (step.main && step.k % (skill.torchEvery || 8) === 0) {
        const torch = B.pickMaterial(bot, 'light')
        if (torch) { try { await placeAt(ctx, step.cells[0], torch, { solid: false }) } catch (err) { if (err instanceof CancelledError) throw err } }
      }
      steps++
      level.progress++
      ctx.skills?.award('mining', 0.3)
      ctx.setStatus(`mining at y=${levelY}: ${gotTarget}/${wanted} ${target}, tunnel ${level.progress}`)
      ctx.resumeArgs = { target: args.target, count: wanted - gotTarget }
      if (steps % 5 === 0) save()
    }
    await pickupDrops(ctx)
    for (const [n, c] of Object.entries(got)) level.mined[n] = (level.mined[n] || 0) + c
    save()

    const list = Object.entries(got).map(([n, c]) => `${c} ${n}`).join(', ') || 'no ores'
    const extra = []
    if (shaftStats.dug) extra.push(`dug ${shaftStats.dug} blocks of stairs`)
    if (stats.sealed + shaftStats.sealed) extra.push(`sealed ${stats.sealed + shaftStats.sealed} water/lava spots`)
    if (stats.warnings.size) extra.push([...stats.warnings].join('; '))
    return `mined at y=${levelY}: ${list} (wanted ${wanted} ${target}, got ${gotTarget}). Tunnel length ${level.progress}.` + (extra.length ? ` ${extra.join('. ')}.` : '') + ' Call mine again to keep digging this mine.'
  }
}

async function pickupDrops (ctx) {
  const { bot } = ctx
  const { goals } = require('mineflayer-pathfinder')
  for (let i = 0; i < 6; i++) {
    const drop = bot.nearestEntity(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(bot.entity.position) <= 6)
    if (!drop) return
    try {
      await ctx.race(bot.pathfinder.goto(new goals.GoalFollow(drop, 0)), 4000)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      return
    }
  }
}
