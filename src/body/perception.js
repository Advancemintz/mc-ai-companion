'use strict'

// Builds the compact text "what I can see right now" summary the LLM reads each turn.
// Keep this short: every line costs tokens and latency on every decision.

const W = require('./world')
const T = require('./terrain')

const NOTABLE_EXACT = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'ender_chest',
  'sand', 'gravel', 'clay', 'sugar_cane', 'pumpkin', 'melon', 'wheat', 'carrots', 'potatoes',
  'obsidian', 'nether_portal', 'spawner', 'bee_nest', 'ancient_debris'
])
const LANDMARKS = new Set(['crafting_table', 'furnace', 'chest', 'barrel', 'nether_portal', 'spawner'])

let notableCache = null
function notableIds (registry) {
  if (notableCache && notableCache.registry === registry) return notableCache.ids
  const ids = []
  for (const b of Object.values(registry.blocksByName)) {
    if (NOTABLE_EXACT.has(b.name) || b.name.endsWith('_ore') || b.name.endsWith('_bed') ||
      (b.name.endsWith('_log') && !b.name.startsWith('stripped_'))) {
      ids.push(b.id)
    }
  }
  notableCache = { registry, ids }
  return ids
}

function fmt (p) {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
}

function timeLabel (bot) {
  const t = bot.time?.timeOfDay ?? 0
  if (t < 1000) return 'early morning'
  if (t < 6000) return 'morning'
  if (t < 11000) return 'afternoon'
  if (t < 12500) return 'evening (night soon)'
  if (t < 23000) return 'night (monsters spawn)'
  return 'dawn'
}

function inventorySummary (bot) {
  const totals = {}
  for (const i of bot.inventory.items()) totals[i.name] = (totals[i.name] || 0) + i.count
  const entries = Object.entries(totals)
  if (!entries.length) return 'empty'
  return entries.map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ')
}

function armorSummary (bot) {
  const slots = [5, 6, 7, 8].map(s => bot.inventory.slots[s]?.name).filter(Boolean)
  return slots.length ? slots.join(', ') : 'none'
}

function describe (bot, { executor, maxEntities = 10, blockRadius = 16 } = {}) {
  const me = bot.entity
  const pos = me.position
  const lines = []

  const dim = String(bot.game?.dimension || 'overworld').replace('minecraft:', '')
  let biome = ''
  try { biome = bot.blockAt(pos)?.biome?.name || '' } catch {}
  lines.push(`Position: ${fmt(pos)} in ${dim}${biome ? ` (${biome})` : ''}`)
  try { lines.push(`Surroundings: ${T.describeCover(bot)}`) } catch {}

  let vitals = `Health ${Math.round(bot.health)}/20, food ${bot.food}/20`
  if (bot.experience) vitals += `, XP level ${bot.experience.level}`
  if (bot.oxygenLevel !== undefined && bot.oxygenLevel < 20) vitals += `, air ${bot.oxygenLevel}/20`
  lines.push(vitals)
  lines.push(`Time: ${timeLabel(bot)}${bot.isRaining ? ', raining' : ''}`)
  lines.push(`Holding: ${bot.heldItem?.name || 'nothing'}. Armor: ${armorSummary(bot)}`)
  lines.push(`Inventory (${bot.inventory.emptySlotCount()} free slots): ${inventorySummary(bot)}`)

  // Entities
  const players = []
  const mobs = []
  for (const e of Object.values(bot.entities)) {
    if (e === me || !e.position) continue
    const d = e.position.distanceTo(pos)
    if (d > 32) continue
    if (e.type === 'player') players.push({ label: e.username, d })
    else if (W.isMob(e)) {
      let tag = ''
      try { tag = require('./husbandry').animalTag(bot, e, executor?.memory) } catch {}
      mobs.push({ label: e.name + (W.isHostile(e) ? ' (hostile)' : '') + (tag ? ` (${tag})` : ''), d })
    }
  }
  players.sort((a, b) => a.d - b.d)
  mobs.sort((a, b) => a.d - b.d)
  lines.push(`Players nearby: ${players.length ? players.map(p => `${p.label} ${Math.round(p.d)}m`).join(', ') : 'none'}`)
  lines.push(`Mobs nearby: ${mobs.length ? mobs.slice(0, maxEntities).map(m => `${m.label} ${Math.round(m.d)}m`).join(', ') : 'none'}`)

  // Notable blocks
  try {
    const found = bot.findBlocks({ matching: notableIds(bot.registry), maxDistance: blockRadius, count: 300 })
    const counts = {}
    const nearest = {}
    for (const p of found) {
      const b = bot.blockAt(p)
      if (!b) continue
      const name = b.name.endsWith('_bed') ? 'bed' : b.name
      counts[name] = (counts[name] || 0) + 1
      if (!nearest[name]) nearest[name] = p
    }
    const parts = Object.entries(counts).map(([n, c]) => {
      const where = (LANDMARKS.has(n) || n === 'bed') ? ` at ${fmt(nearest[n])}` : ''
      return `${n} x${c}${where}`
    })
    lines.push(`Blocks within ${blockRadius}: ${parts.length ? parts.join(', ') : 'nothing notable'}`)
  } catch {}

  const under = bot.blockAt(pos.offset(0, -1, 0))
  if (under) lines.push(`Standing on: ${under.name}`)

  if (executor) lines.push(`Activity: ${executor.describe()}`)
  return lines.join('\n')
}

module.exports = { describe, inventorySummary }
