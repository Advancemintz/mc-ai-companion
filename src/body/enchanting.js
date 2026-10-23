'use strict'

// Enchanting, the way players do it:
//   - An enchanting table is only as good as the bookshelves around it (up to 15, two blocks
//     away with air in between). With all 15, the best offer costs level 30.
//   - Beginners take the best offer they can afford right away. Better enchanters save their
//     levels for the top offer and enchant their gear in order of importance.
//   - Anvils put enchanted books on the right gear, repair worn gear, and name things.
//   - The best enchanters read the offers (the table shows one enchantment per slot) and put
//     Mending on their best gear first.

const { goals } = require('mineflayer-pathfinder')
const { goto } = require('./motion')
const { CancelledError } = require('./executor')

const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const level = (bot) => bot.experience?.level ?? 0

// What gets enchanted first, like a player would.
const PRIORITY = ['pickaxe', 'sword', 'chestplate', 'leggings', 'helmet', 'boots', 'bow', 'axe', 'shovel', 'trident', 'crossbow', 'fishing_rod', 'shears', 'hoe', 'shield', 'elytra']
const MATERIAL_RANK = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, stone: 2, leather: 1, wooden: 1, turtle: 3 }
const kindOf = (name) => PRIORITY.find(k => name === k || name.endsWith('_' + k)) || null
const rankOf = (name) => MATERIAL_RANK[(name.match(/^(netherite|diamond|iron|chainmail|golden|stone|leather|wooden|turtle)_/) || [])[1]] || 3

// Enchantments on an item (or stored in a book), as [{ name, lvl }].
function enchantsOf (item) {
  try {
    const e = item?.enchants
    if (Array.isArray(e)) return e.map(x => ({ name: String(x.name).replace(/^minecraft:/, ''), lvl: x.lvl ?? x.level ?? 1 }))
  } catch {}
  return []
}

// ------------------------------------------------------------------ the table

// Bookshelves that count for a table: two blocks out (5x5 ring, at table height and one above),
// with nothing but air between them and the table.
function bookshelfPower (bot, tablePos) {
  let n = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
      for (const dy of [0, 1]) {
        const shelf = bot.blockAt(tablePos.offset(dx, dy, dz))
        if (!shelf || shelf.name !== 'bookshelf') continue
        const gap = bot.blockAt(tablePos.offset(Math.trunc(dx / 2), dy, Math.trunc(dz / 2)))
        if (!gap || (gap.name !== 'air' && gap.name !== 'cave_air')) continue
        n++
      }
    }
  }
  return Math.min(15, n)
}

// The most a table's top slot can cost with n bookshelves (30 with 15).
const bestLevelFor = (n) => Math.min(30, 8 + Math.floor(n / 2) + n)

function findTable (ctx, radius = 32) {
  const { bot } = ctx
  const id = bot.registry.blocksByName.enchanting_table?.id
  if (id === undefined) return null
  const SN = require('./sneaky')
  const found = bot.findBlocks({ matching: id, maxDistance: radius, count: 8 }).map(p => bot.blockAt(p))
    .filter(b => b && (!SN.ownerOf(ctx, b.position) || SN.ownerOf(ctx, b.position).how === 'mine'))
  // The one with the most bookshelves wins.
  return found.sort((a, b) => bookshelfPower(bot, b.position) - bookshelfPower(bot, a.position))[0] || null
}

// Gear worth enchanting: not yet enchanted, best material first, in priority order.
function enchantCandidates (bot, { priorities = true, only = null } = {}) {
  const all = [...bot.inventory.items(), ...[5, 6, 7, 8].map(s => bot.inventory.slots?.[s]).filter(Boolean)]
  const list = all.filter(i => kindOf(i.name) && !enchantsOf(i).length && i.name !== 'enchanted_book')
  if (only) return list.filter(i => i.name === only || i.name.includes(only) || kindOf(i.name) === only)
  if (!priorities) return list
  return list.sort((a, b) => PRIORITY.indexOf(kindOf(a.name)) - PRIORITY.indexOf(kindOf(b.name)) || rankOf(b.name) - rankOf(a.name))
}

// How good an offered enchantment is for this item (for readOffers).
const GOOD = {
  pickaxe: { mending: 10, efficiency: 8, fortune: 9, unbreaking: 7, silk_touch: 6 },
  sword: { mending: 10, sharpness: 9, looting: 8, unbreaking: 7, sweeping_edge: 5, fire_aspect: 5, knockback: 3, smite: 4, bane_of_arthropods: 3 },
  axe: { mending: 10, efficiency: 7, sharpness: 6, unbreaking: 7 },
  shovel: { mending: 10, efficiency: 8, unbreaking: 7, silk_touch: 5 },
  bow: { mending: 10, power: 9, infinity: 8, unbreaking: 7, flame: 6, punch: 4 },
  armour: { mending: 10, protection: 9, unbreaking: 7, fire_protection: 5, blast_protection: 5, projectile_protection: 5, feather_falling: 8, respiration: 5, aqua_affinity: 4, thorns: 3, depth_strider: 4, swift_sneak: 6 }
}
function offerScore (bot, kind, offer) {
  const id = offer?.expected?.enchant
  const name = (bot.registry.enchantments?.[id]?.name || bot.registry.enchantmentsArray?.find?.(e => e.id === id)?.name || '').replace(/^minecraft:/, '')
  const table = ['helmet', 'chestplate', 'leggings', 'boots'].includes(kind) ? GOOD.armour : (GOOD[kind] || {})
  return (table[name] ?? 4) * 10 + (offer.expected?.level || 1) * 3 + offer.level / 10
}

// Which slot to pick (0-2), or { wait: reason }.
function chooseOffer (bot, offers, { params, lapis, power, kind }) {
  const lv = level(bot)
  const usable = offers.map((o, i) => ({ ...o, i })).filter(o => o && o.level > 0)
  if (!usable.length) return { wait: 'the table shows no offers for that item' }
  const affordable = usable.filter(o => o.level <= lv && lapis >= o.i + 1)
  if (params.waitForBest) {
    const top = usable[usable.length - 1]
    if (top.level > lv) return { wait: `I'm level ${lv}; I'm saving up for the top offer (level ${top.level}${power < 15 ? `; with ${15 - power} more bookshelves it could reach 30` : ''})` }
    if (lapis < top.i + 1) return { wait: `I need ${top.i + 1} lapis for the top offer (I have ${lapis})` }
    if (params.readOffers) {
      const best = affordable.sort((a, b) => offerScore(bot, kind, b) - offerScore(bot, kind, a))[0]
      return { slot: best.i }
    }
    return { slot: top.i }
  }
  if (!affordable.length) return { wait: `I can't afford any of the offers yet (I'm level ${lv}, cheapest is ${usable[0].level})` }
  return { slot: affordable[affordable.length - 1].i }
}

function waitForOffers (table, ms = 3000) {
  return new Promise((resolve) => {
    if (table.enchantments?.some(e => e && e.level > 0)) return resolve()
    const t = setTimeout(resolve, ms)
    table.once?.('ready', () => { clearTimeout(t); resolve() })
  })
}

function describeEnchants (list) {
  return list.map(e => `${e.name.replace(/_/g, ' ')} ${e.lvl}`).join(', ')
}

const enchantAction = {
  description: 'Enchant gear at an enchanting table (yours or one nobody owns, within 32 blocks). Needs lapis lazuli and XP levels. Bookshelves around the table (up to 15) make the offers better: level 30 offers need all 15. Without an item it picks your most important unenchanted gear (pickaxe, sword, chestplate...). How patient and picky you are depends on your enchanting skill.',
  params: { item: 'optional: which item (e.g. diamond_pickaxe)', count: 'how many items to enchant this time (default 1)' },
  timeoutSeconds: 300,
  run: async (ctx, { item, count: howMany }) => {
    const { bot } = ctx
    const params = ctx.skills?.params('enchanting') || require('../skills/registry').SKILLS.enchanting.tiers[1].params
    const table = findTable(ctx)
    if (!table) throw new Error('no enchanting table of mine within 32 blocks (one takes 4 obsidian, 2 diamonds and a book)')
    const power = bookshelfPower(bot, table.position)
    const lapisNow = count(bot, 'lapis_lazuli')
    if (!lapisNow) throw new Error('enchanting needs lapis lazuli (mine for lapis: it is found around y 0)')
    if (!level(bot)) throw new Error("I have no XP levels yet (XP comes from mining coal, redstone and lapis, smelting, fighting, breeding and trading)")
    const want = Math.max(1, Math.min(4, Math.round(Number(howMany) || 1)))
    const candidates = enchantCandidates(bot, { priorities: params.priorities, only: item ? String(item).toLowerCase().trim().replace(/\s+/g, '_') : null })
    if (!candidates.length) throw new Error(item ? `I don't have an unenchanted ${item}` : 'none of my gear needs enchanting')
    // A patient enchanter doesn't spend levels on a weak table offer.
    if (params.waitForBest && level(bot) < bestLevelFor(power)) {
      throw new Error(`I'm level ${level(bot)} and this table's best offer costs about ${bestLevelFor(power)}; I'll save up first${power < 15 ? ` (and it has only ${power} of 15 bookshelves)` : ''}. XP: mine coal/redstone/lapis, smelt, fight`)
    }
    await goto(ctx, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 60000)
    const done = []
    let reason = ''
    for (const it of candidates.slice(0, want)) {
      ctx.check()
      const kind = kindOf(it.name)
      // Armour has to come off to go on the table.
      const armourSlot = [5, 6, 7, 8].find(s => bot.inventory.slots?.[s] === it)
      if (armourSlot !== undefined) { try { await bot.unequip({ 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[armourSlot]) } catch {} }
      const fresh = bot.inventory.items().find(i => i.name === it.name && !enchantsOf(i).length) || it
      const win = await ctx.race(bot.openEnchantmentTable(table), 8000)
      try {
        await win.putTargetItem(fresh)
        const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli')
        if (lapis) await win.putLapis(lapis)
        await waitForOffers(win)
        const pick = chooseOffer(bot, win.enchantments || [], { params, lapis: Math.min(3, count(bot, 'lapis_lazuli') + (win.lapis?.count || 0)), power, kind })
        if (pick.wait) { reason = pick.wait; try { await win.takeTargetItem() } catch {} break }
        const before = level(bot)
        const result = await ctx.race(win.enchant(pick.slot), 8000)
        try { await win.takeTargetItem() } catch {}
        const got = enchantsOf(result || bot.inventory.items().find(i => i.name === it.name && enchantsOf(i).length))
        done.push(`${it.name} with ${got.length ? describeEnchants(got) : 'an enchantment'} (cost ${Math.max(0, before - level(bot)) || pick.slot + 1} levels)`)
        ctx.skills?.award('enchanting', 6 + pick.slot * 4, `enchanted a ${it.name}`)
      } finally {
        try { win.close() } catch {}
      }
    }
    if (done.length) await require('./survival').equipBestArmour(bot)
    if (!done.length) throw new Error(reason || 'nothing got enchanted')
    return `enchanted ${done.join('; ')}. Now level ${level(bot)}${reason ? `; stopped: ${reason}` : ''}${power < 15 ? `. (The table has ${power}/15 bookshelves.)` : ''}`
  }
}

// ------------------------------------------------------------------ the anvil

// Which gear an enchanted book belongs on, best first.
const BOOK_TARGETS = {
  sharpness: ['sword', 'axe'], smite: ['sword', 'axe'], bane_of_arthropods: ['sword', 'axe'], looting: ['sword'], sweeping_edge: ['sword'], fire_aspect: ['sword'], knockback: ['sword'],
  efficiency: ['pickaxe', 'axe', 'shovel', 'hoe'], fortune: ['pickaxe', 'axe', 'shovel', 'hoe'], silk_touch: ['pickaxe', 'shovel', 'axe'],
  protection: ['chestplate', 'leggings', 'helmet', 'boots'], fire_protection: ['chestplate', 'leggings', 'helmet', 'boots'], blast_protection: ['chestplate', 'leggings', 'helmet', 'boots'], projectile_protection: ['chestplate', 'leggings', 'helmet', 'boots'],
  thorns: ['chestplate', 'leggings', 'helmet', 'boots'], feather_falling: ['boots'], depth_strider: ['boots'], frost_walker: ['boots'], soul_speed: ['boots'], respiration: ['helmet'], aqua_affinity: ['helmet'], swift_sneak: ['leggings'],
  power: ['bow'], punch: ['bow'], flame: ['bow'], infinity: ['bow'],
  mending: ['pickaxe', 'sword', 'chestplate', 'leggings', 'helmet', 'boots', 'bow', 'axe', 'shovel', 'elytra', 'shield'],
  unbreaking: ['pickaxe', 'sword', 'chestplate', 'leggings', 'helmet', 'boots', 'bow', 'axe', 'shovel', 'elytra', 'shield']
}
const CONFLICTS = [
  ['sharpness', 'smite', 'bane_of_arthropods'], ['fortune', 'silk_touch'],
  ['protection', 'fire_protection', 'blast_protection', 'projectile_protection'], ['depth_strider', 'frost_walker'], ['infinity', 'mending']
]

function canTake (item, ench) {
  const has = enchantsOf(item)
  const same = has.find(e => e.name === ench.name)
  if (same && same.lvl >= ench.lvl) return false
  for (const group of CONFLICTS) if (group.includes(ench.name) && has.some(e => e.name !== ench.name && group.includes(e.name))) return false
  return true
}

// Plan which book goes on which item. Returns [{ book, item, ench }].
function bookPlan (bot, { mending = false } = {}) {
  const gear = [...bot.inventory.items(), ...[5, 6, 7, 8].map(s => bot.inventory.slots?.[s]).filter(Boolean)].filter(i => kindOf(i.name))
  const books = bot.inventory.items().filter(i => i.name === 'enchanted_book')
  const plan = []
  const used = new Set()
  // Mending first, onto the most valuable gear, when the bot thinks that way.
  const ordered = books.slice().sort((a, b) => (mending ? (enchantsOf(b).some(e => e.name === 'mending') ? 1 : 0) - (enchantsOf(a).some(e => e.name === 'mending') ? 1 : 0) : 0))
  for (const book of ordered) {
    const ench = enchantsOf(book)[0]
    if (!ench) continue
    const kinds = BOOK_TARGETS[ench.name] || []
    const target = gear.filter(g => kinds.includes(kindOf(g.name)) && !used.has(g) && canTake(g, ench))
      .sort((a, b) => kinds.indexOf(kindOf(a.name)) - kinds.indexOf(kindOf(b.name)) || rankOf(b.name) - rankOf(a.name))[0]
    if (!target) continue
    plan.push({ book, item: target, ench })
    if (ench.name === 'mending') used.add(target) // one Mending per item; other books can stack
  }
  return plan
}

const REPAIR_MATERIAL = { netherite: 'netherite_ingot', diamond: 'diamond', iron: 'iron_ingot', golden: 'gold_ingot', chainmail: 'iron_ingot', stone: 'cobblestone', leather: 'leather', wooden: 'oak_planks', turtle: 'turtle_scute' }

function findAnvil (ctx) {
  const { bot } = ctx
  const ids = ['anvil', 'chipped_anvil', 'damaged_anvil'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  return ids.length ? bot.findBlock({ matching: ids, maxDistance: 32 }) : null
}

const anvilAction = {
  description: 'Use an anvil: job "books" (default) puts your enchanted books onto the gear they suit best (Mending on your best gear first); job "repair" fixes worn gear with its material (iron ingots for iron gear, diamonds for diamond...) or by combining two of the same item; job "rename" names an item (item + name). Costs XP levels; very old, much-worked items get "too expensive".',
  params: { job: 'books | repair | rename', item: 'optional item (rename/repair)', name: 'new name (rename)' },
  timeoutSeconds: 240,
  run: async (ctx, { job, item, name }) => {
    const { bot } = ctx
    const params = ctx.skills?.params('enchanting') || { mending: true }
    const anvilBlock = findAnvil(ctx)
    if (!anvilBlock) throw new Error('no anvil within 32 blocks (3 iron blocks + 4 iron ingots)')
    if (!level(bot)) throw new Error('anvil work costs XP levels and I have none')
    const what = String(job || 'books').toLowerCase()
    await goto(ctx, new goals.GoalNear(anvilBlock.position.x, anvilBlock.position.y, anvilBlock.position.z, 2), 60000)
    const anvil = await ctx.race(bot.openAnvil(anvilBlock), 8000)
    const done = []
    const failed = []
    try {
      if (what === 'rename') {
        const it = bot.inventory.items().find(i => i.name === item || i.name.includes(String(item || '')))
        if (!it || !name) throw new Error('rename needs an item I have and a name')
        await ctx.race(anvil.rename(it, String(name).slice(0, 50)), 8000)
        done.push(`named my ${it.name} "${String(name).slice(0, 50)}"`)
      } else if (what === 'repair') {
        const SV = require('./survival')
        const worn = SV.wornGear(bot).map(w => w.item).filter(i => !item || i.name.includes(item))
        const targets = worn.length ? worn : bot.inventory.items().filter(i => item && i.name.includes(item))
        if (!targets.length) throw new Error('nothing of mine needs repairing')
        for (const it of targets) {
          ctx.check()
          const mat = REPAIR_MATERIAL[(it.name.match(/^(netherite|diamond|iron|golden|chainmail|stone|leather|wooden|turtle)_/) || [])[1]]
          const twin = bot.inventory.items().find(i => i !== it && i.name === it.name)
          const with_ = (mat && bot.inventory.items().find(i => i.name === mat)) || twin
          if (!with_) { failed.push(`${it.name} (no ${mat || it.name} to repair it with)`); continue }
          try {
            await ctx.race(anvil.combine(it, with_), 8000)
            done.push(`repaired my ${it.name} with ${with_.name}`)
            ctx.skills?.award('enchanting', 3)
          } catch (err) {
            if (err instanceof CancelledError) throw err
            failed.push(`${it.name} (${/expensive/i.test(err.message) ? 'too expensive' : err.message})`)
          }
        }
      } else {
        const plan = bookPlan(bot, { mending: params.mending })
        if (!plan.length) throw new Error(bot.inventory.items().some(i => i.name === 'enchanted_book') ? 'none of my books fit my gear (or it already has them)' : 'I have no enchanted books (librarians sell them; check your villager offers)')
        for (const p of plan) {
          ctx.check()
          if (!level(bot)) { failed.push('ran out of levels'); break }
          try {
            await ctx.race(anvil.combine(p.item, p.book), 8000)
            done.push(`put ${p.ench.name.replace(/_/g, ' ')} ${p.ench.lvl} on my ${p.item.name}`)
            ctx.skills?.award('enchanting', p.ench.name === 'mending' ? 12 : 6, `put ${p.ench.name} on gear`)
          } catch (err) {
            if (err instanceof CancelledError) throw err
            failed.push(`${p.ench.name} on ${p.item.name} (${/expensive/i.test(err.message) ? 'too expensive: that item has been worked too often' : err.message})`)
          }
        }
      }
    } finally {
      try { anvil.close() } catch {}
    }
    if (done.length) await require('./survival').equipBestArmour(bot)
    if (!done.length) throw new Error(`couldn't do it: ${failed.join('; ') || 'nothing to do'}`)
    return `${done.join('; ')}${failed.length ? `; couldn't: ${failed.join('; ')}` : ''}. Now level ${level(bot)}`
  }
}

module.exports = { bookshelfPower, bestLevelFor, findTable, enchantCandidates, chooseOffer, offerScore, enchantsOf, bookPlan, canTake, enchantAction, anvilAction, PRIORITY }

