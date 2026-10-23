'use strict'

// The Nether end game, done the way players do it:
//   - ancient debris: tunnel at y 8-22 (where it's most common) and take what the tunnel walls
//     uncover. No x-ray: it only mines debris it actually exposes.
//   - bastions: find one by its blackstone, raid its chests for the good stuff (gold armour on,
//     and piglins get angry anyway).
//   - make_netherite: smelt debris into scrap, craft ingots (4 scrap + 4 gold), and upgrade
//     diamond gear at a smithing table with a netherite upgrade template.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const B = require('./builder')
const M = require('./mining')
const { goto } = require('./motion')
const { CancelledError } = require('./executor')

const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const danger = (bot) => bot.health <= 10 || bot.food <= 6
const pickup = (ctx) => require('./actions').helpers.pickupNearbyItems(ctx, 5)

const DEBRIS_Y = { min: 8, max: 22, best: 15 }

// ------------------------------------------------------------------ ancient debris

async function tunnelForDebris (ctx, origin, radius, deadline, stats) {
  const { bot } = ctx
  const pick = bot.inventory.items().find(i => /^(diamond|netherite)_pickaxe$/.test(i.name))
  if (!pick) throw new Error('ancient debris needs a diamond or netherite pickaxe')
  // Get down (or up) to the debris layer first.
  const y = Math.floor(bot.entity.position.y)
  if (y < DEBRIS_Y.min || y > DEBRIS_Y.max) {
    ctx.setStatus(`heading to y=${DEBRIS_Y.best} for ancient debris`)
    try { await goto(ctx, new goals.GoalNear(origin.x, DEBRIS_Y.best, origin.z, 3), 120000) } catch (err) { if (err instanceof CancelledError) throw err; throw new Error(`couldn't get down to y=${DEBRIS_Y.best} near the portal`) }
  }
  const start = bot.entity.position.floored()
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const away = new Vec3(start.x - origin.x, 0, start.z - origin.z)
  const dir = dirs.sort((a, b) => (b.x * away.x + b.z * away.z) - (a.x * away.x + a.z * away.z))[0]
  const gen = M.branchSteps(start, dir, { spacing: 3, length: 4 })
  const digStats = { dug: 0, placed: 0, sealed: 0, missing: {}, warnings: new Set(), flooded: new Set() }
  let steps = 0
  const isDebris = (n) => n === 'ancient_debris'
  while (Date.now() < deadline && !danger(bot) && steps < 80 && bot.inventory.emptySlotCount() > 1) {
    ctx.check()
    const step = gen.next().value
    if (step.cells[0].distanceTo(origin) > radius) break
    for (const p of step.cells) await B.digCell(ctx, p, new Set(), digStats) // seals lava it breaks into
    for (const p of [...step.cells.filter(c => isDebris(bot.blockAt(c)?.name)), ...M.findVein(bot, step.cells, isDebris, 4)]) {
      const b = bot.blockAt(p)
      if (!b || !isDebris(b.name)) continue
      try {
        await bot.equip(pick, 'hand')
        await goto(ctx, new goals.GoalLookAtBlock(p, bot.world), 15000)
        await ctx.race(bot.dig(b, true), 20000)
        stats.dug++
        stats.debris = (stats.debris || 0) + 1
        ctx.skills?.award('nether', 12, 'found ancient debris')
        ctx.skills?.award('mining', 4)
        await pickup(ctx)
      } catch (err) { if (err instanceof CancelledError) throw err }
    }
    steps++
    ctx.setStatus(`tunnelling for ancient debris: ${steps} blocks, ${stats.debris || 0} found`)
  }
  if (digStats.sealed) stats.sealed = digStats.sealed
  stats.tunnel = steps
}

// ------------------------------------------------------------------ bastions

const BASTION_BLOCKS = ['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone']
const LOOT = /^(netherite_upgrade_smithing_template|ancient_debris|netherite_scrap|netherite_ingot|gold_block|gold_ingot|diamond.*|enchanted_golden_apple|golden_apple|.*smithing_template|lodestone|crying_obsidian|spectral_arrow|obsidian|magma_cream|string|iron_ingot|iron_block|arrow|leather|golden_.*)$/

function findBastion (bot, origin, radius) {
  const ids = BASTION_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  if (!ids.length) return null
  const found = bot.findBlocks({ matching: ids, maxDistance: Math.min(radius, 96), count: 40, point: origin })
  if (found.length < 8) return null
  const c = found.reduce((a, p) => a.plus(p), new Vec3(0, 0, 0)).scaled(1 / found.length).floored()
  return c
}

async function raidBastion (ctx, origin, radius, deadline, stats) {
  const { bot } = ctx
  const wearingGold = [5, 6, 7, 8].some(s => /^golden_/.test(bot.inventory.slots?.[s]?.name || ''))
  if (!wearingGold) {
    const g = bot.inventory.items().find(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))
    if (g) { try { await bot.equip(g, /helmet/.test(g.name) ? 'head' : /chestplate/.test(g.name) ? 'torso' : /leggings/.test(g.name) ? 'legs' : 'feet') } catch {} }
  }
  const center = findBastion(bot, origin, radius)
  if (!center) throw new Error('no bastion within reach of the portal (they are built of dark blackstone bricks)')
  stats.bastion = `${center.x} ${center.y} ${center.z}`
  const chestIds = ['chest'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  const chests = bot.findBlocks({ matching: chestIds, maxDistance: 40, count: 12, point: center })
  if (!chests.length) throw new Error(`found a bastion at ${stats.bastion} but no chests I can see`)
  stats.looted = stats.looted || {}
  for (const p of chests) {
    if (Date.now() > deadline || danger(bot)) break
    ctx.check()
    try {
      await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 2), 60000)
      const c = await ctx.race(bot.openContainer(bot.blockAt(p)), 8000)
      try {
        for (const it of c.containerItems()) {
          if (!LOOT.test(it.name) || bot.inventory.emptySlotCount() === 0) continue
          try { await c.withdraw(it.type, null, it.count); stats.looted[it.name] = (stats.looted[it.name] || 0) + it.count } catch {}
        }
      } finally { try { c.close() } catch {} }
      ctx.skills?.award('nether', 8, 'raided a bastion chest')
    } catch (err) { if (err instanceof CancelledError) throw err }
  }
}

// ------------------------------------------------------------------ netherite

// Upgrade one diamond item at a smithing table: template + diamond item + netherite ingot.
async function smithUpgrade (ctx, tableBlock, itemName) {
  const { bot } = ctx
  const win = await ctx.race(bot.openBlock(tableBlock), 8000)
  try {
    const slotOf = (name) => {
      for (let i = win.inventoryStart; i < win.inventoryEnd; i++) if (win.slots[i]?.name === name) return i
      return -1
    }
    for (const [name, dest] of [['netherite_upgrade_smithing_template', 0], [itemName, 1], ['netherite_ingot', 2]]) {
      const from = slotOf(name)
      if (from < 0) throw new Error(`missing ${name}`)
      await bot.moveSlotItem(from, dest)
    }
    for (let i = 0; i < 20 && !win.slots[3]; i++) await ctx.sleep(100)
    if (!win.slots[3]) throw new Error('the smithing table gave nothing back')
    await bot.clickWindow(3, 0, 1) // shift-click the result into the inventory
    await ctx.sleep(150)
  } finally {
    try { bot.closeWindow(win) } catch {}
  }
}

const UPGRADE_ORDER = ['diamond_sword', 'diamond_pickaxe', 'diamond_chestplate', 'diamond_leggings', 'diamond_helmet', 'diamond_boots', 'diamond_axe', 'diamond_shovel', 'diamond_hoe']

const makeNetheriteAction = {
  description: 'Turn ancient debris into netherite: smelt the debris into scrap, craft netherite ingots (4 scrap + 4 gold ingots each), then upgrade your diamond gear at a smithing table (each upgrade needs a netherite upgrade template, found in bastions, and one ingot). Does as much as your materials allow.',
  params: { item: 'optional: which diamond item to upgrade first (default: sword, then pickaxe, then armour)' },
  timeoutSeconds: 900,
  run: async (ctx, { item }) => {
    const { bot } = ctx
    const A = require('./actions').actions
    const done = []
    if (count(bot, 'ancient_debris')) {
      const r = await A.smelt.run(ctx, { item: 'ancient_debris' })
      done.push(r)
    }
    const ingots = Math.min(Math.floor(count(bot, 'netherite_scrap') / 4), Math.floor(count(bot, 'gold_ingot') / 4))
    if (ingots) {
      const r = await A.craft.run(ctx, { item: 'netherite_ingot', count: ingots })
      done.push(r)
    }
    const order = item ? [String(item).replace(/^netherite_/, 'diamond_'), ...UPGRADE_ORDER] : UPGRADE_ORDER
    const upgraded = []
    let missing = ''
    for (const name of [...new Set(order)]) {
      if (!bot.inventory.items().some(i => i.name === name) && ![5, 6, 7, 8].some(s => bot.inventory.slots?.[s]?.name === name)) continue
      if (!count(bot, 'netherite_ingot')) { missing = 'no netherite ingots left'; break }
      if (!count(bot, 'netherite_upgrade_smithing_template')) { missing = 'no netherite upgrade template (they are found in bastion chests)'; break }
      // Armour has to come off to go in the table.
      const armourSlot = [5, 6, 7, 8].find(s => bot.inventory.slots?.[s]?.name === name)
      if (armourSlot !== undefined) { try { await bot.unequip({ 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[armourSlot]) } catch {} }
      let table = bot.findBlock({ matching: bot.registry.blocksByName.smithing_table?.id, maxDistance: 32 })
      if (!table && count(bot, 'smithing_table')) {
        const { placeNextToBot } = require('./actions').helpers
        table = await placeNextToBot(ctx, 'smithing_table')
      }
      if (!table) { missing = 'no smithing table nearby (4 planks + 2 iron ingots)'; break }
      try {
        await goto(ctx, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 60000)
        await smithUpgrade(ctx, table, name)
        upgraded.push(name.replace('diamond_', 'netherite_'))
        ctx.skills?.award('nether', 15, `made a ${name.replace('diamond_', 'netherite ')}`)
      } catch (err) {
        if (err instanceof CancelledError) throw err
        missing = err.message
        break
      }
    }
    if (upgraded.length) await require('./survival').equipBestArmour(bot)
    if (!done.length && !upgraded.length) throw new Error(missing || 'nothing to do: I have no ancient debris, scrap, or diamond gear to upgrade')
    return [...done, upgraded.length ? `upgraded to ${upgraded.join(', ')}` : '', missing && upgraded.length ? `stopped: ${missing}` : ''].filter(Boolean).join('; ')
  }
}

module.exports = { tunnelForDebris, raidBastion, findBastion, smithUpgrade, makeNetheriteAction, DEBRIS_Y, BASTION_BLOCKS }
