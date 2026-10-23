'use strict'

// The Nether: building and lighting a portal, and careful round trips through it.
// What a trip may go for (and how far and how long) depends on the nether tier.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const FILLER = /^(cobblestone|cobbled_deepslate|stone|deepslate|netherrack|dirt|andesite|diorite|granite|tuff|blackstone|.*_planks)$/

const TRIP_TARGETS = {
  netherrack: { blocks: ['netherrack'], item: 'netherrack' },
  quartz: { blocks: ['nether_quartz_ore'], item: 'quartz' },
  gold: { blocks: ['nether_gold_ore'], item: 'gold_nugget', angersPiglins: true },
  glowstone: { blocks: ['glowstone'], item: 'glowstone_dust' },
  nether_wart: { blocks: ['nether_wart'], item: 'nether_wart' },
  blaze_rod: { mob: 'blaze', item: 'blaze_rod' },
  barter: { mob: 'piglin', item: null }
}
const TARGET_ALIASES = { quartz_ore: 'quartz', nether_quartz: 'quartz', gold_ore: 'gold', nether_gold: 'gold', wart: 'nether_wart', blaze: 'blaze_rod', blaze_rods: 'blaze_rod', piglin: 'barter', trade: 'barter', look: 'look', explore: 'look' }

const inNether = (bot) => /nether/.test(String(bot.game?.dimension || ''))
const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const toVec = (p) => new Vec3(p.x, p.y, p.z)

// ------------------------------------------------------------------ portal frame

// The frame is 4 wide and 5 tall, standing on the ground at (origin) along `axis`.
// Returns cells in a buildable order: bottom row, the two pillars, then the top row.
function frameCells (origin, axis) {
  const step = axis === 'x' ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1)
  const at = (i, y) => origin.offset(step.x * i, y, step.z * i)
  const cells = []
  for (let i = 0; i < 4; i++) cells.push({ pos: at(i, 1), corner: i === 0 || i === 3 })
  for (let y = 2; y <= 4; y++) for (const i of [0, 3]) cells.push({ pos: at(i, y), corner: false })
  for (let i = 0; i < 4; i++) cells.push({ pos: at(i, 5), corner: i === 0 || i === 3 })
  const inner = []
  for (let y = 2; y <= 4; y++) for (const i of [1, 2]) inner.push(at(i, y))
  return { cells, inner, base: at(1, 1), front: axis === 'x' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0) }
}

const open = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty')

function choosePortalSite (bot, memory, near) {
  const o = (near || bot.entity.position).floored()
  let best = null
  for (let dx = -16; dx <= 16; dx++) {
    for (let dz = -16; dz <= 16; dz++) {
      for (const axis of ['x', 'z']) {
        const col = T.columnInfo(bot, o.x + dx, o.z + dz, o.y, 8)
        if (!col || col.water || col.roofed) continue
        const origin = new Vec3(o.x + dx, col.y, o.z + dz)
        const { cells, inner, front } = frameCells(origin, axis)
        // flat ground under the whole width, the frame space and a spot to stand on either side free
        let ok = true
        for (let i = 0; i < 4 && ok; i++) {
          const g = origin.offset(axis === 'x' ? i : 0, 0, axis === 'z' ? i : 0)
          if (!T.isFirm(bot.blockAt(g))) ok = false
          for (const side of [front, front.scaled(-1)]) {
            if (!T.isFirm(bot.blockAt(g.plus(side)))) ok = false
            if (!open(bot.blockAt(g.plus(side).offset(0, 1, 0))) || !open(bot.blockAt(g.plus(side).offset(0, 2, 0)))) ok = false
          }
        }
        if (!ok) continue
        if ([...cells.map(c => c.pos), ...inner].some(p => !open(bot.blockAt(p)) || Z.zoneAt(memory, p))) continue
        const d = origin.distanceTo(o)
        if (d < 4) continue // not right on top of whoever is standing here
        if (!best || d < best.d) best = { origin, axis, d }
      }
    }
  }
  return best
}

const portalAction = {
  description: 'Build and light a Nether portal near home (outside any base). Needs 10 obsidian (14 for obsidian corners, otherwise 4 cobblestone or similar for the corners) and flint and steel (crafted from iron + flint if needed). Saved as nether_portal.',
  params: {},
  timeoutSeconds: 300,
  run: async (ctx) => {
    const { bot } = ctx
    const mem = ctx.memory
    if (inNether(bot)) throw new Error("I'm already in the Nether")
    const known = mem?.getPlace('nether_portal')
    if (known) {
      const b = bot.blockAt(toVec(known))
      if (b?.name === 'nether_portal') return `there's already a lit portal at ${known.x} ${known.y} ${known.z}`
    }
    const obsidian = count(bot, 'obsidian')
    if (obsidian < 10) throw new Error(`I need 10 obsidian for a portal and have ${obsidian}. Obsidian needs a diamond pickaxe (water poured on still lava makes it)`)
    if (!bot.inventory.items().some(i => i.name === 'flint_and_steel')) {
      try { await require('./actions').actions.craft.run(ctx, { item: 'flint_and_steel' }) } catch (err) { if (err instanceof CancelledError) throw err }
      if (!bot.inventory.items().some(i => i.name === 'flint_and_steel')) throw new Error('I need flint and steel (1 iron ingot + 1 flint; flint comes from digging gravel) to light the portal')
    }
    const filler = obsidian >= 14 ? null : bot.inventory.items().find(i => FILLER.test(i.name) && i.count >= 4)
    if (obsidian < 14 && !filler) throw new Error('I need 4 more obsidian or 4 cobblestone (or similar) for the corners')

    const home = mem?.getPlace('home')
    const site = choosePortalSite(bot, mem, home ? toVec(home) : null)
    if (!site) throw new Error('no flat, open spot for a portal nearby (it needs 4x5 of space and room on both sides)')
    const { cells, inner, base, front } = frameCells(site.origin, site.axis)
    let placed = 0
    for (const c of cells) {
      ctx.check()
      ctx.setStatus(`portal frame ${placed}/${cells.length}`)
      const item = c.corner && filler ? filler.name : 'obsidian'
      const r = await placeAt(ctx, c.pos, item)
      if (r === 'no-support' || r === 'blocked') throw new Error(`couldn't place the portal frame at ${c.pos} (${r})`)
      placed++
    }
    // light it from in front
    const stand = site.origin.offset(site.axis === 'x' ? 1 : 0, 1, site.axis === 'z' ? 1 : 0).plus(front)
    await goto(ctx, new goals.GoalNear(stand.x, stand.y, stand.z, 1), 30000)
    const fs = bot.inventory.items().find(i => i.name === 'flint_and_steel')
    await bot.equip(fs, 'hand')
    await bot.lookAt(base.offset(0.5, 1, 0.5), true)
    await ctx.race(bot.activateBlock(bot.blockAt(base), new Vec3(0, 1, 0)), 5000)
    await ctx.sleep(500)
    const lit = inner.some(p => bot.blockAt(p)?.name === 'nether_portal')
    if (!lit) throw new Error('built the frame but it did not light. Check the frame is complete and try again')
    const entry = inner[0]
    if (mem) {
      mem.setPlace('nether_portal', entry, bot.game?.dimension, 'my Nether portal')
      mem.addZone('nether_portal', entry, 3)
      Z.invalidate()
    }
    ctx.skills?.award('nether', 25, 'built a Nether portal')
    return `built and lit a Nether portal at ${entry.x} ${entry.y} ${entry.z}`
  }
}

// ------------------------------------------------------------------ trips

async function waitForDimension (ctx, wantNether, ms = 20000) {
  const { bot } = ctx
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (inNether(bot) === wantNether && bot.entity?.position) return true
    await ctx.sleep(250)
  }
  return false
}

async function stepInto (ctx, pos) {
  const { bot } = ctx
  await goto(ctx, new goals.GoalBlock(pos.x, pos.y, pos.z), 30000)
  bot.clearControlStates?.()
}

function nearbyPortalBlock (bot, from, radius = 6) {
  const id = bot.registry.blocksByName.nether_portal?.id
  if (id === undefined) return null
  const found = bot.findBlocks({ matching: id, maxDistance: radius, count: 1, point: from })
  return found[0] || null
}

function wearingGold (bot) {
  return [5, 6, 7, 8].some(s => /^golden_/.test(bot.inventory.slots[s]?.name || ''))
}

function danger (bot) {
  return bot.health <= 10 || bot.food <= 6
}

async function gatherBlocks (ctx, target, origin, radius, deadline, stats) {
  const { bot } = ctx
  const ids = target.blocks.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  let misses = 0
  while (Date.now() < deadline && !danger(bot) && misses < 3) {
    ctx.check()
    const found = bot.findBlocks({ matching: ids, maxDistance: Math.min(radius, 64), count: 20, point: origin })
      .filter(p => p.distanceTo(origin) <= radius)
      .filter(p => !target.angersPiglins || !Object.values(bot.entities).some(e => /piglin/.test(e.name || '') && e.position.distanceTo(p) < 16))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const p = found[0]
    if (!p) break
    const b = bot.blockAt(p)
    try {
      await goto(ctx, new goals.GoalLookAtBlock(p, bot.world), 30000)
      await bot.tool?.equipForBlock?.(b)
      await ctx.race(bot.dig(b), 15000)
      stats.dug++
      ctx.skills?.award('nether', target.blocks[0] === 'netherrack' ? 0.2 : 2)
      await require('./actions').helpers.pickupNearbyItems(ctx, 5)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      misses++
    }
  }
}

async function fightMobs (ctx, mobName, origin, radius, deadline, stats) {
  const { bot } = ctx
  while (Date.now() < deadline && !danger(bot)) {
    ctx.check()
    const mob = bot.nearestEntity(e => e.name === mobName && e.position.distanceTo(origin) <= radius)
    if (!mob) break
    if (!bot.pvp) throw new Error('no combat plugin loaded')
    bot.pvp.attack(mob)
    const until = Math.min(deadline, Date.now() + 30000)
    while (Date.now() < until && bot.entities[mob.id] && !danger(bot)) await ctx.sleep(250)
    try { bot.pvp.forceStop?.() } catch {}
    if (!bot.entities[mob.id]) { stats.kills++; ctx.skills?.award('nether', 6, `killed a ${mobName}`); ctx.skills?.award('combat', 4) }
    await require('./actions').helpers.pickupNearbyItems(ctx, 6)
  }
}

async function barter (ctx, origin, radius, deadline, stats) {
  const { bot } = ctx
  if (!wearingGold(bot)) {
    const g = bot.inventory.items().find(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))
    if (g) { try { await bot.equip(g, /helmet/.test(g.name) ? 'head' : /chestplate/.test(g.name) ? 'torso' : /leggings/.test(g.name) ? 'legs' : 'feet') } catch {} }
  }
  if (!wearingGold(bot)) throw new Error('piglins attack anyone not wearing gold. I need a golden helmet (or any gold armour) on before trading')
  while (Date.now() < deadline && !danger(bot) && count(bot, 'gold_ingot') > 0) {
    ctx.check()
    const piglin = bot.nearestEntity(e => e.name === 'piglin' && e.position.distanceTo(origin) <= radius)
    if (!piglin) break
    await goto(ctx, new goals.GoalFollow(piglin, 2), 20000)
    const gold = bot.inventory.items().find(i => i.name === 'gold_ingot')
    await bot.lookAt(piglin.position.offset(0, 1, 0), true)
    await bot.toss(gold.type, null, 1)
    stats.traded++
    ctx.skills?.award('nether', 4, 'bartered with a piglin')
    await ctx.sleep(8000) // piglins admire the gold for ~6 seconds before throwing something back
    await require('./actions').helpers.pickupNearbyItems(ctx, 8)
  }
}

const tripAction = {
  description: 'A careful round trip through your Nether portal: go through, gather something (get: netherrack, quartz, gold, glowstone, nether_wart, blaze_rod, barter, or look) within the range and time your tier allows, then come back through the portal. Turns back early if hurt or hungry. Bring food, good armour and blocks.',
  params: { get: 'what to go for (default: look)' },
  timeoutSeconds: 1200,
  run: async (ctx, { get }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const skill = ctx.skills?.params('nether') || { radius: 32, minutes: 5, targets: Object.keys(TRIP_TARGETS), barter: true }
    let key = String(get || 'look').toLowerCase().trim().replace(/\s+/g, '_')
    key = TARGET_ALIASES[key] || key
    if (key !== 'look' && !TRIP_TARGETS[key]) throw new Error(`I don't know how to go for "${get}" in the Nether. Options: ${Object.keys(TRIP_TARGETS).join(', ')}, look`)
    if (key !== 'look' && !skill.targets.includes(key)) throw new Error(`I'm not experienced enough to go for ${key} yet: so far I can manage ${skill.targets.join(', ')}. More careful trips will teach me.`)
    if (bot.health < 16) throw new Error("I'm too hurt to risk the Nether right now. Heal up first")
    if (!bot.inventory.items().some(i => i.foodPoints || /bread|cooked|apple|carrot|potato|steak|porkchop/.test(i.name))) throw new Error("I'm not going without food")

    const stats = { dug: 0, kills: 0, traded: 0 }
    const startItems = {}
    for (const i of bot.inventory.items()) startItems[i.name] = (startItems[i.name] || 0) + i.count

    // Go through.
    if (!inNether(bot)) {
      const p = mem?.getPlace('nether_portal')
      if (!p) throw new Error('I have no Nether portal. Build one with build_portal first')
      const entry = toVec(p)
      if (bot.blockAt(entry)?.name !== 'nether_portal') {
        const alt = nearbyPortalBlock(bot, entry, 4)
        if (!alt) throw new Error("my portal isn't lit any more. Relight it with flint and steel (or build_portal)")
      }
      ctx.setStatus('walking into the portal')
      await stepInto(ctx, entry)
      if (!await waitForDimension(ctx, true, 20000)) throw new Error("stood in the portal but didn't go through")
      ctx.skills?.award('nether', 5, 'went to the Nether')
    }
    await ctx.sleep(1500) // let the chunks arrive
    const arrival = bot.entity.position.floored()
    const back = nearbyPortalBlock(bot, arrival, 6) || arrival
    if (mem) mem.setPlace('nether_portal_nether', back, bot.game?.dimension, 'the Nether side of my portal')

    // Do the job.
    const deadline = Date.now() + skill.minutes * 60000
    let note = ''
    try {
      ctx.setStatus(`in the Nether: ${key}`)
      if (key === 'look') {
        await ctx.sleep(Math.min(20000, skill.minutes * 30000))
      } else {
        const t = TRIP_TARGETS[key]
        if (t.blocks) await gatherBlocks(ctx, t, back, skill.radius, deadline, stats)
        else if (key === 'blaze_rod') await fightMobs(ctx, 'blaze', back, skill.radius, deadline, stats)
        else if (key === 'barter') await barter(ctx, back, skill.radius, deadline, stats)
      }
      if (danger(bot)) note = 'turned back early because I was hurt or hungry'
    } catch (err) {
      if (err instanceof CancelledError) throw err
      note = `stopped: ${err.message}`
    }

    // Come home.
    ctx.setStatus('heading back to the portal')
    const portal = bot.blockAt(back)?.name === 'nether_portal' ? back : nearbyPortalBlock(bot, back, 8)
    if (!portal) throw new Error(`I can't find the portal back (it was at ${back.x} ${back.y} ${back.z} in the Nether). It may have been broken; I'm stuck here until it's relit`)
    await stepInto(ctx, portal)
    if (!await waitForDimension(ctx, false, 20000)) throw new Error("stood in the portal home but didn't go through. Trying again might work")
    ctx.skills?.award('nether', 10, 'came back from the Nether safely')

    const gained = {}
    for (const i of bot.inventory.items()) gained[i.name] = (gained[i.name] || 0) + i.count
    const haul = Object.entries(gained).map(([k, v]) => [k, v - (startItems[k] || 0)]).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ')
    return `back from the Nether${haul ? ` with ${haul}` : ' empty-handed'}${stats.kills ? `; killed ${stats.kills}` : ''}${stats.traded ? `; traded ${stats.traded} gold` : ''}${note ? `. ${note}` : ''}`
  }
}

module.exports = { portalAction, tripAction, frameCells, choosePortalSite, TRIP_TARGETS }
