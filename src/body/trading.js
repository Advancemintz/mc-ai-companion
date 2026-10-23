'use strict'

// Trading with villagers, the way players do it: go to a village, look through what each
// villager offers, sell surplus (wheat, coal, paper...) for emeralds, and buy what you came for.
// Everything seen goes in a trade book in memory, so the bot remembers "the librarian at the
// river village sells Mending for 20 emeralds" and can come back for it.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { goto } = require('./motion')
const { CancelledError } = require('./executor')

const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
const lc = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '_')

// What a player happily sells: things that pile up.
const SURPLUS = { wheat: 32, potato: 32, carrot: 32, beetroot: 32, coal: 24, paper: 24, string: 16, rotten_flesh: 32, stick: 64, pumpkin: 12, melon: 8, sugar_cane: 32, flint: 16, leather: 12, feather: 24, raw_chicken: 20, raw_porkchop: 20, beef: 20, mutton: 20, cod: 15, salmon: 15, white_wool: 24 }
// Worth pointing out when a villager has it.
const NOTABLE = /^(enchanted_book|diamond_.*|iron_(pickaxe|sword|axe|helmet|chestplate|leggings|boots)|bell|name_tag|ender_pearl|experience_bottle|golden_carrot|saddle|map|bookshelf|glass|lantern|shield|crossbow|bow|emerald)$/

function itemLabel (it) {
  if (!it) return ''
  let name = it.name
  try {
    const ench = it.enchants?.length ? it.enchants : null
    if (ench && ench.length) name += ` (${ench.map(e => `${e.name} ${e.lvl}`).join(', ')})`
  } catch {}
  return `${it.count} ${name}`
}

function describeTrade (t) {
  const give = [itemLabel(t.inputItem1), t.inputItem2 && t.hasItem2 !== false ? itemLabel(t.inputItem2) : ''].filter(Boolean).join(' + ')
  return { give, get: itemLabel(t.outputItem), disabled: !!t.tradeDisabled || (t.maximumNbTradeUses && t.nbTradeUses >= t.maximumNbTradeUses) }
}

function usesLeft (t) {
  if (t.tradeDisabled) return 0
  if (t.maximumNbTradeUses) return Math.max(0, t.maximumNbTradeUses - (t.nbTradeUses || 0))
  return 4
}

// How many times we can afford a trade with what's in our pockets.
function affordable (bot, t) {
  let n = Math.floor(count(bot, t.inputItem1.name) / Math.max(1, t.inputItem1.count))
  if (t.inputItem2 && t.hasItem2 !== false && t.inputItem2.count) n = Math.min(n, Math.floor(count(bot, t.inputItem2.name) / t.inputItem2.count))
  return n
}

// Which trades to do with this villager: sell surplus (or what was asked) for emeralds, then buy.
function chooseTrades (bot, trades, { want = '', sell = '' } = {}) {
  const plan = []
  trades.forEach((t, index) => {
    if (!t.outputItem || !t.inputItem1 || !usesLeft(t)) return
    const out = t.outputItem.name
    const inName = t.inputItem1.name
    if (out === 'emerald') {
      const asked = sell && (inName === sell || inName.includes(sell))
      const keepBack = asked ? 0 : (SURPLUS[inName] ?? Infinity)
      if (!asked && keepBack === Infinity) return
      // Saving up for something? Then the surplus can all go.
      const spare = count(bot, inName) - (asked || want ? 0 : Math.floor(keepBack / 2))
      const times = Math.min(usesLeft(t), Math.floor(Math.max(0, spare) / Math.max(1, t.inputItem1.count)), asked ? 12 : 4)
      if (times > 0) plan.push({ index, times, kind: 'sell', trade: t })
    } else if (want && (out === want || out.includes(want) || (out === 'enchanted_book' && /book|enchant|mending/.test(want)))) {
      // How many we can afford is checked again after selling.
      plan.push({ index, times: Math.min(usesLeft(t), 4), kind: 'buy', trade: t })
    }
  })
  // Sell first so the emeralds are there for buying.
  return plan.sort((a, b) => (a.kind === 'sell' ? 0 : 1) - (b.kind === 'sell' ? 0 : 1))
}

function villagersNear (bot, radius = 24) {
  return Object.values(bot.entities || {}).filter(e => e?.name === 'villager' && e.position && e.position.distanceTo(bot.entity.position) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

function nearestVillage (ctx) {
  const mem = ctx.memory
  if (!mem) return null
  const here = ctx.bot.entity.position
  const finds = (mem.discoveriesNear(here, 'overworld', 20) || []).filter(d => d.kind === 'village' && d.distance <= 400)
  if (finds.length) return new Vec3(finds[0].x, finds[0].y, finds[0].z)
  const place = Object.entries(mem.data.places || {}).filter(([k]) => /village/.test(k))
    .map(([, p]) => ({ p, d: Math.hypot(p.x - here.x, p.z - here.z) })).sort((a, b) => a.d - b.d)[0]
  return place && place.d <= 400 ? new Vec3(place.p.x, place.p.y, place.p.z) : null
}

function recordTrades (mem, villager, trades, village) {
  if (!mem) return
  mem.data.tradeBook = mem.data.tradeBook || {}
  const key = String(villager.uuid || villager.id)
  mem.data.tradeBook[key] = {
    village,
    x: Math.floor(villager.position.x), y: Math.floor(villager.position.y), z: Math.floor(villager.position.z),
    trades: trades.map(describeTrade).slice(0, 10),
    seenAt: new Date().toISOString()
  }
  const keys = Object.keys(mem.data.tradeBook)
  if (keys.length > 40) delete mem.data.tradeBook[keys.sort((a, b) => Date.parse(mem.data.tradeBook[a].seenAt) - Date.parse(mem.data.tradeBook[b].seenAt))[0]]
  mem.save()
}

// Remembered offers that give `want` (for the model and for planning a trip).
function findInTradeBook (mem, want) {
  const w = lc(want)
  const out = []
  for (const v of Object.values(mem?.data.tradeBook || {})) {
    for (const t of v.trades) if (!t.disabled && t.get.includes(w)) out.push({ ...t, at: `${v.x} ${v.y} ${v.z}`, village: v.village })
  }
  return out
}

const tradeAction = {
  description: 'Trade with villagers: goes to the nearest village you know (or the place in at), looks through each villager\'s offers, sells your surplus or the item in sell (wheat, coal, paper, string...) for emeralds, and buys the item in want if someone offers it. Remembers every offer it sees, so you know where to come back for what.',
  params: { want: 'optional: item to buy (e.g. enchanted_book, bookshelf, iron_pickaxe)', sell: 'optional: item to sell for emeralds', at: 'optional: saved place to trade at' },
  timeoutSeconds: 900,
  run: async (ctx, { want, sell, at }) => {
    const { bot } = ctx
    const mem = ctx.memory
    want = want ? lc(want) : ''
    sell = sell ? lc(sell) : ''
    let villageName = at || ''
    if (at) {
      const p = mem?.getPlace(at)
      if (!p) throw new Error(`I don't remember a place called "${at}"`)
      await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 4), 400000)
    } else if (!villagersNear(bot, 32).length) {
      const v = nearestVillage(ctx)
      if (!v) throw new Error("there are no villagers nearby and I don't know a village (explore to find one)")
      villageName = `the village at ${v.x} ${v.z}`
      ctx.setStatus(`walking to ${villageName}`)
      await goto(ctx, new goals.GoalNear(v.x, v.y, v.z, 6), 400000)
    }
    villageName = villageName || `the village near ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.z)}`
    const villagers = villagersNear(bot, 32).slice(0, 8)
    if (!villagers.length) throw new Error('no villagers around here (they may be indoors at night)')
    const sold = {}
    const bought = {}
    const notable = []
    let looked = 0
    for (const v of villagers) {
      ctx.check()
      ctx.setStatus(`looking at a villager's trades (${looked + 1}/${villagers.length})`)
      try {
        await goto(ctx, new goals.GoalFollow(v, 2), 20000)
        const win = await ctx.race(bot.openVillager(v), 8000)
        try {
          const trades = win.trades || []
          looked++
          recordTrades(mem, v, trades, villageName)
          for (const t of trades) {
            const d = describeTrade(t)
            if (!d.disabled && NOTABLE.test(t.outputItem?.name || '') && t.outputItem.name !== 'emerald') notable.push(`${d.get} for ${d.give}`)
          }
          for (const step of chooseTrades(bot, trades, { want, sell })) {
            const times = step.kind === 'buy' ? Math.min(step.times, affordable(bot, step.trade)) : step.times
            if (times <= 0) continue
            try {
              await ctx.race(bot.trade(win, step.index, times), 10000)
              const t = step.trade
              if (step.kind === 'sell') sold[t.inputItem1.name] = (sold[t.inputItem1.name] || 0) + t.inputItem1.count * times
              else bought[t.outputItem.name] = (bought[t.outputItem.name] || 0) + t.outputItem.count * times
            } catch (err) { if (err instanceof CancelledError) throw err }
          }
        } finally {
          try { win.close() } catch {}
        }
      } catch (err) {
        if (err instanceof CancelledError) throw err
      }
      if (want && bought[want]) break
    }
    if (!looked) throw new Error("couldn't get any villager to trade (they might be busy, asleep or unreachable)")
    const list = (o) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(', ')
    const parts = [`looked at ${looked === 1 ? "1 villager's" : `${looked} villagers'`} trades at ${villageName}`]
    if (Object.keys(sold).length) parts.push(`sold ${list(sold)} (now ${count(bot, 'emerald')} emeralds)`)
    if (Object.keys(bought).length) parts.push(`bought ${list(bought)}`)
    else if (want) {
      const known = findInTradeBook(mem, want)
      parts.push(known.length ? `couldn't afford ${want} (${known[0].get} costs ${known[0].give})` : `nobody here sells ${want}`)
    }
    if (notable.length) parts.push(`worth knowing: ${[...new Set(notable)].slice(0, 4).join('; ')}`)
    return parts.join('. ')
  }
}

module.exports = { tradeAction, chooseTrades, describeTrade, findInTradeBook, recordTrades, SURPLUS }
