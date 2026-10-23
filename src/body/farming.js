'use strict'

// Farming: a remembered crop plot near home that the bot tills, plants, harvests and replants,
// plus breeding animals. How big and how clever the farm is depends on the farming tier.
//
//   tier 1  plots right next to existing water, wheat only
//   tier 2  bigger plots, makes its own water source with a bucket, more crops, fences it in
//   tier 3  + breeds animals
//   tier 4  + bone meal to speed up crops, bigger plots

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const T = require('./terrain')
const Z = require('./zones')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const CROPS = {
  wheat: { seed: 'wheat_seeds', block: 'wheat', maxAge: 7, produce: 'wheat' },
  carrots: { seed: 'carrot', block: 'carrots', maxAge: 7, produce: 'carrot' },
  potatoes: { seed: 'potato', block: 'potatoes', maxAge: 7, produce: 'potato' },
  beetroot: { seed: 'beetroot_seeds', block: 'beetroots', maxAge: 3, produce: 'beetroot' }
}
const CROP_BY_BLOCK = Object.fromEntries(Object.entries(CROPS).map(([k, v]) => [v.block, { name: k, ...v }]))
const TILLABLE = /^(grass_block|dirt|dirt_path|coarse_dirt|rooted_dirt)$/
const PLANT_COVER = /^(short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|dead_bush|snow)$/

const ANIMAL_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'dandelion'], horse: ['golden_carrot', 'golden_apple'], llama: ['hay_block']
}

function count (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

function cropAge (block) {
  try {
    const p = block.getProperties ? block.getProperties() : {}
    if (p.age !== undefined) return Number(p.age)
  } catch {}
  return block.metadata ?? 0
}

async function reach (ctx, pos) {
  const { bot } = ctx
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4) return
  await goto(ctx, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2.5), 45000)
}

// ------------------------------------------------------------------ choosing a plot

function plotCells (center, r) {
  const out = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (dx || dz) out.push(center.offset(dx, 0, dz))
  return out
}

// Ground that can become farmland: tillable (or already farmland) with nothing solid above.
function farmable (bot, p) {
  const g = bot.blockAt(p)
  const above = bot.blockAt(p.offset(0, 1, 0))
  if (!g || !above) return false
  if (!(TILLABLE.test(g.name) || g.name === 'farmland')) return false
  return above.name === 'air' || PLANT_COVER.test(above.name) || !!CROP_BY_BLOCK[above.name]
}

// Next to existing water (tier 1), or anywhere flat if we can bring our own water.
function chooseSite (bot, memory, { radius, makeWater, near }) {
  const origin = (near || bot.entity.position).floored()
  let best = null
  const consider = (center, natural) => {
    if (Z.zoneAt(memory, center)) return
    const cells = plotCells(center, radius)
    const good = cells.filter(p => farmable(bot, p) && !Z.zoneAt(memory, p)).length
    if (good < Math.max(6, cells.length * 0.6)) return
    const score = good * 2 - center.distanceTo(origin) * 0.5 + (natural ? 4 : 0)
    if (!best || score > best.score) best = { center, natural, score }
  }
  // Existing water sources at ground level.
  const waterId = bot.registry.blocksByName.water?.id
  const waters = waterId === undefined ? [] : bot.findBlocks({ matching: waterId, maxDistance: 32, count: 200 })
  for (const w of waters) {
    const above = bot.blockAt(w.offset(0, 1, 0))
    if (above && above.name === 'air') consider(w, true)
  }
  if (makeWater) {
    for (let dx = -20; dx <= 20; dx += 2) {
      for (let dz = -20; dz <= 20; dz += 2) {
        const col = T.columnInfo(bot, origin.x + dx, origin.z + dz, origin.y, 8)
        if (!col || col.water || col.roofed) continue
        const c = new Vec3(origin.x + dx, col.y, origin.z + dz)
        if (TILLABLE.test(bot.blockAt(c)?.name || '')) consider(c, false)
      }
    }
  }
  return best
}

// ------------------------------------------------------------------ the farm round

async function placeWater (ctx, center) {
  const { bot } = ctx
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!bucket) return false
  const g = bot.blockAt(center)
  if (g && g.name !== 'water' && g.name !== 'air') {
    await reach(ctx, center)
    await ctx.race(bot.dig(g, true), 10000)
  }
  await reach(ctx, center)
  await bot.equip(bucket, 'hand')
  await bot.lookAt(center.offset(0.5, 0.05, 0.5), true)
  bot.activateItem()
  await ctx.sleep(400)
  try { bot.deactivateItem() } catch {}
  return bot.blockAt(center)?.name === 'water'
}

async function till (ctx, p) {
  const { bot } = ctx
  const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'))
  if (!hoe) return false
  const above = bot.blockAt(p.offset(0, 1, 0))
  if (above && PLANT_COVER.test(above.name)) { await reach(ctx, p); await ctx.race(bot.dig(above, true), 5000) }
  await reach(ctx, p)
  if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand')
  await ctx.race(bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0)), 5000)
  await ctx.sleep(100)
  return bot.blockAt(p)?.name === 'farmland'
}

async function plant (ctx, p, crop) {
  const { bot } = ctx
  const seed = bot.inventory.items().find(i => i.name === CROPS[crop].seed)
  if (!seed) return false
  await reach(ctx, p)
  if (bot.heldItem?.name !== seed.name) await bot.equip(seed, 'hand')
  try { await ctx.race(bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0)), 5000) } catch (err) { if (err instanceof CancelledError) throw err }
  await ctx.sleep(60)
  return !!CROP_BY_BLOCK[bot.blockAt(p.offset(0, 1, 0))?.name]
}

async function pickup (ctx) {
  const { bot } = ctx
  for (let i = 0; i < 10; i++) {
    const drop = bot.nearestEntity(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(bot.entity.position) <= 6)
    if (!drop) return
    try { await ctx.race(bot.pathfinder.goto(new goals.GoalFollow(drop, 0)), 4000) } catch (err) { if (err instanceof CancelledError) throw err; return }
  }
}

// Get some wheat seeds by breaking grass nearby (where wheat farming starts for everyone).
async function gatherSeeds (ctx, want = 6) {
  const { bot } = ctx
  const ids = ['short_grass', 'grass', 'tall_grass'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  for (let tries = 0; tries < 20 && count(bot, 'wheat_seeds') < want; tries++) {
    ctx.check()
    const g = bot.findBlock({ matching: ids, maxDistance: 24 })
    if (!g) break
    await reach(ctx, g.position)
    try { await ctx.race(bot.dig(g, true), 5000) } catch (err) { if (err instanceof CancelledError) throw err }
    await pickup(ctx)
  }
  return count(bot, 'wheat_seeds')
}

async function farmRound (ctx, proj, skill) {
  const { bot } = ctx
  const center = new Vec3(proj.center.x, proj.center.y, proj.center.z)
  const stats = { harvested: {}, planted: {}, tilled: 0, boneMealed: 0, notes: [] }
  if (proj.water === 'made' && bot.blockAt(center)?.name !== 'water') {
    if (await placeWater(ctx, center)) stats.notes.push('placed the water source')
  }
  const allowed = skill.crops
  const cropForCell = (i) => {
    const have = allowed.filter(c => count(bot, CROPS[c].seed) > 0)
    return have.length ? have[i % have.length] : null
  }
  const cells = plotCells(center, proj.radius).sort((a, b) => a.z - b.z || a.x - b.x)
  let i = 0
  for (const p of cells) {
    ctx.check()
    i++
    ctx.setStatus(`farming ${i}/${cells.length}`)
    const g = bot.blockAt(p)
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (!g || !above) continue
    const crop = CROP_BY_BLOCK[above.name]
    if (crop) {
      if (cropAge(above) >= crop.maxAge) {
        await reach(ctx, p)
        try { await ctx.race(bot.dig(above, true), 5000) } catch (err) { if (err instanceof CancelledError) throw err; continue }
        stats.harvested[crop.produce] = (stats.harvested[crop.produce] || 0) + 1
        ctx.skills?.award('farming', 1.5)
        if (count(bot, crop.seed) === 0) await pickup(ctx)
        // replant the same crop straight away
        if (await plant(ctx, p, crop.name)) stats.planted[crop.name] = (stats.planted[crop.name] || 0) + 1
      } else if (skill.boneMeal && count(bot, 'bone_meal') > 0 && stats.boneMealed < 16) {
        const meal = bot.inventory.items().find(it => it.name === 'bone_meal')
        await reach(ctx, p)
        await bot.equip(meal, 'hand')
        try { await ctx.race(bot.activateBlock(above), 3000); stats.boneMealed++ } catch (err) { if (err instanceof CancelledError) throw err }
      }
      continue
    }
    if (g.name !== 'farmland' && TILLABLE.test(g.name) && (above.name === 'air' || PLANT_COVER.test(above.name))) {
      if (await till(ctx, p)) { stats.tilled++; ctx.skills?.award('farming', 0.1) }
    }
    if (bot.blockAt(p)?.name === 'farmland' && bot.blockAt(p.offset(0, 1, 0))?.name === 'air') {
      const c = cropForCell(i)
      if (c && await plant(ctx, p, c)) { stats.planted[c] = (stats.planted[c] || 0) + 1; ctx.skills?.award('farming', 0.2) }
    }
  }
  // A fence keeps animals (and players) from trampling it. Leave a gap on one side as the way in.
  if (skill.fence) {
    const fence = bot.inventory.items().find(it => /_fence$/.test(it.name))
    if (fence) {
      const r = proj.radius + 1
      let placedFence = 0
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          if (dx === 0 && dz === -r) continue // gate gap
          const p = center.offset(dx, 1, dz)
          const b = bot.blockAt(p)
          if (!b || /_fence$/.test(b.name) || (b.name !== 'air' && !PLANT_COVER.test(b.name))) continue
          if (!bot.inventory.items().some(it => it.name === fence.name)) break
          try { if (await placeAt(ctx, p, fence.name, { solid: false }) === 'placed') placedFence++ } catch (err) { if (err instanceof CancelledError) throw err }
        }
      }
      if (placedFence) stats.notes.push(`put up ${placedFence} fence posts`)
    } else if (!proj.fenceHinted) {
      stats.notes.push('no fences to put around it yet (craft some from planks and sticks)')
      proj.fenceHinted = true
    }
  }
  await pickup(ctx)
  return stats
}

// ------------------------------------------------------------------ actions

const farmAction = {
  description: 'Look after your crop farm near home: the first time it picks a plot (next to water, or with a water bucket at higher tiers it can make its own water), then each round it tills, plants, harvests ripe crops and replants, and tends the melon/pumpkin patch and sugar cane if you have them. Needs a hoe and seeds (it pulls up grass for wheat seeds if needed). Optional crop: wheat, carrots, potatoes, beetroot, or (master farmers) melon, pumpkin, sugar_cane to start or tend that patch.',
  params: { crop: 'optional preferred crop' },
  timeoutSeconds: 900,
  run: async (ctx, { crop }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const skill = ctx.skills?.params('farming') || { plotRadius: 4, crops: [...Object.keys(CROPS), 'melon', 'pumpkin', 'sugar_cane'], makeWater: true, fence: true, boneMeal: true }
    const R = require('./ranch')
    // Melons, pumpkins and sugar cane have their own patches next to the farm.
    const side = String(crop || '').toLowerCase().trim().replace(/\s+/g, '_').replace(/s$/, '').replace(/^(sugar_?)?cane$/, 'sugar_cane').replace(/^sugarcane$/, 'sugar_cane')
    if (['melon', 'pumpkin', 'sugar_cane'].includes(side)) {
      if (!skill.crops.includes(side)) throw new Error(`I don't know how to grow ${side.replace('_', ' ')} yet; that comes with more farming. So far: ${skill.crops.join(', ')}`)
      const st = { harvested: {}, planted: {}, notes: [] }
      if (side === 'sugar_cane') await R.tendCane(ctx, st)
      else await R.tendPatch(ctx, side, st)
      const list = (o) => Object.entries(o).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')
      const parts = [...st.notes]
      if (Object.keys(st.harvested).length) parts.push(`harvested ${list(st.harvested)}`)
      if (Object.keys(st.planted).length) parts.push(`planted ${list(st.planted)}`)
      return (parts.join('; ') || `checked the ${side.replace('_', ' ')}: nothing ready yet`) + '.'
    }
    let crops = skill.crops.filter(c => CROPS[c])
    if (crop) {
      const c = String(crop).toLowerCase().replace(/s$/, '').replace(/^carrot$/, 'carrots').replace(/^potatoe?$/, 'potatoes').replace(/^beetroots?$/, 'beetroot')
      const name = CROPS[c] ? c : (CROPS[c + 's'] ? c + 's' : null)
      if (!name) throw new Error(`I don't know how to grow "${crop}". Crops: ${Object.keys(CROPS).join(', ')}`)
      if (!skill.crops.includes(name)) throw new Error(`I only know how to grow ${skill.crops.join(', ')} so far. (Farming more will teach me more crops.)`)
      crops = [name, ...crops.filter(c2 => c2 !== name)]
    }
    // A hoe: craft a wooden one if we can.
    if (!bot.inventory.items().some(i => i.name.endsWith('_hoe'))) {
      try { await require('./actions').actions.craft.run(ctx, { item: 'wooden_hoe' }) } catch (err) { if (err instanceof CancelledError) throw err }
      if (!bot.inventory.items().some(i => i.name.endsWith('_hoe'))) throw new Error('I need a hoe (2 planks + 2 sticks) to farm')
    }
    let proj = mem?.getProject('farm') || bot._farmProject || null
    // A new farm needs something to plant; an existing one can be harvested (ripe crops drop seeds).
    if (!proj) {
      if (!crops.some(c => count(bot, CROPS[c].seed) > 0) && crops.includes('wheat')) await gatherSeeds(ctx)
      if (!crops.some(c => count(bot, CROPS[c].seed) > 0)) throw new Error(`I have nothing to plant (need ${crops.map(c => CROPS[c].seed).join(' or ')})`)
    }
    let first = false
    if (!proj) {
      const home = mem?.getPlace('home')
      const canMakeWater = skill.makeWater && bot.inventory.items().some(i => i.name === 'water_bucket')
      const site = chooseSite(bot, mem, { radius: skill.plotRadius, makeWater: canMakeWater, near: home ? new Vec3(home.x, home.y, home.z) : null }) ||
        (skill.plotRadius > 2 ? chooseSite(bot, mem, { radius: 2, makeWater: canMakeWater }) : null)
      if (!site) {
        throw new Error(canMakeWater
          ? 'no flat, open ground or water nearby for a farm. Move somewhere flatter'
          : 'no water source on open ground nearby to farm next to' + (skill.makeWater ? ' (a water bucket would let me make my own)' : ''))
      }
      proj = { style: 'farm', center: { x: site.center.x, y: site.center.y, z: site.center.z }, radius: site.natural ? Math.min(skill.plotRadius, 4) : skill.plotRadius, water: site.natural ? 'natural' : 'made', createdAt: new Date().toISOString(), status: 'active' }
      first = true
      if (mem) { mem.saveProject('farm', proj); mem.setPlace('farm', site.center.offset(0, 1, 0), bot.game?.dimension, 'my crop farm'); Z.invalidate() } else bot._farmProject = proj
    } else if (skill.plotRadius > proj.radius && proj.water === 'made') {
      proj.radius = skill.plotRadius // got better: make the plot bigger
      mem?.saveProject('farm', proj)
    }
    const stats = await farmRound(ctx, proj, { ...skill, crops })
    // Tend the side patches on the same round, like a player doing their farm chores.
    for (const k of ['melon', 'pumpkin']) {
      if (skill.crops.includes(k) && mem?.getProject(`${k}_patch`)) {
        try { await R.tendPatch(ctx, k, stats) } catch (err) { if (err instanceof CancelledError) throw err; stats.notes.push(err.message) }
      }
    }
    if (skill.crops.includes('sugar_cane') && mem?.getProject('cane')) {
      try { await R.tendCane(ctx, stats) } catch (err) { if (err instanceof CancelledError) throw err; stats.notes.push(err.message) }
    }
    if (first) ctx.skills?.award('farming', 10, 'started a farm')
    proj.lastRound = new Date().toISOString()
    mem?.saveProject('farm', proj)
    const list = (o) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(', ')
    const parts = []
    if (first) parts.push(`started a ${proj.radius * 2 + 1}x${proj.radius * 2 + 1} farm at ${proj.center.x} ${proj.center.y} ${proj.center.z}`)
    if (Object.keys(stats.harvested).length) parts.push(`harvested ${list(stats.harvested)}`)
    if (Object.keys(stats.planted).length) parts.push(`planted ${list(stats.planted)}`)
    if (stats.tilled) parts.push(`tilled ${stats.tilled}`)
    if (stats.boneMealed) parts.push(`used bone meal ${stats.boneMealed}x`)
    parts.push(...stats.notes)
    return (parts.join('; ') || 'checked the farm: nothing ripe yet') + '. Crops take a while to grow; come back later for another round.'
  }
}

const breedAction = {
  description: 'Breed two animals of a kind that are nearby by feeding them (cows/sheep: wheat, pigs: carrots/potatoes/beetroot, chickens: seeds, rabbits: carrots). Makes a baby animal for more food and wool later.',
  params: { animal: 'cow | sheep | pig | chicken | rabbit ...', pairs: 'how many pairs (default 1)' },
  timeoutSeconds: 180,
  run: async (ctx, { animal, pairs }) => {
    const { bot } = ctx
    const kind = String(animal || '').toLowerCase().replace(/s$/, '').replace(/^cattle$/, 'cow')
    const foods = ANIMAL_FOOD[kind]
    if (!foods) throw new Error(`I don't know how to breed "${animal}". Try: ${Object.keys(ANIMAL_FOOD).join(', ')}`)
    const want = Math.max(1, Math.min(4, Math.round(Number(pairs) || 1)))
    let bred = 0
    const fed = new Set()
    for (let n = 0; n < want; n++) {
      const food = bot.inventory.items().find(i => foods.includes(i.name))
      if (!food || count(bot, food.name) < 2) {
        if (bred) break
        throw new Error(`I need 2 ${foods.join(' or ')} to breed ${kind}s`)
      }
      const adults = Object.values(bot.entities)
        .filter(e => e.name === kind && !fed.has(e.id) && e.position.distanceTo(bot.entity.position) < 20 && !(e.metadata?.[16] === true))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        .slice(0, 2)
      if (adults.length < 2) {
        if (bred) break
        throw new Error(`I need two ${kind}s close together (within 20 blocks) to breed them`)
      }
      for (const a of adults) {
        ctx.check()
        try { await goto(ctx, new goals.GoalFollow(a, 1.5), 15000) } catch (err) { if (err instanceof CancelledError) throw err }
        const f = bot.inventory.items().find(i => i.name === food.name)
        if (!f) break
        await bot.equip(f, 'hand')
        await bot.activateEntity(a)
        fed.add(a.id)
        await ctx.sleep(300)
      }
      bred++
      ctx.skills?.award('farming', 6, `bred ${kind}s`)
      await ctx.sleep(1500)
    }
    return `fed ${bred} pair${bred === 1 ? '' : 's'} of ${kind}s; babies should appear shortly`
  }
}

module.exports = { CROPS, ANIMAL_FOOD, farmAction, breedAction, chooseSite, plotCells, farmable }
