'use strict'

// "Noticing" things: changes in the world that a person would react to.
// They become events for the brain. Interesting ones wake it up (rate-limited),
// which gives the bot spontaneous reactions instead of only answering chat.

const W = require('../body/world')
const T = require('../body/terrain')

const VALUABLE = new Set(['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'gold_ore', 'deepslate_gold_ore', 'ancient_debris', 'iron_ore', 'deepslate_iron_ore', 'lapis_ore', 'deepslate_lapis_ore'])
const DANGEROUS = new Set(['creeper', 'witch', 'warden', 'ravager', 'evoker', 'phantom', 'breeze'])

function startSenses (bot, brain, config) {
  const wakeAllowed = () => config.bot.autonomous
  let lastWake = 0
  const COOLDOWN = 20000

  // Report an observation. wake = it's worth reacting to right now.
  const notice = (text, wake) => {
    const canWake = wake && (wakeAllowed() || wake === 'always') && Date.now() - lastWake > COOLDOWN
    if (canWake) lastWake = Date.now()
    brain.notify(`[notice] ${text}`, canWake)
  }

  let lastTime = bot.time?.timeOfDay ?? 0
  let wasRaining = bot.isRaining
  let wasThunder = (bot.thunderState || 0) > 0
  const seenOres = new Set()
  const seenDanger = new Map() // entity id -> time
  const lastSeenPlayer = new Map() // username -> time
  const coverState = { kind: null }

  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return
    notice(`${player.username} joined the game`, 'always')
  })
  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return
    notice(`${player.username} left the game`, false)
  })

  // Items players toss to you.
  bot.on('playerCollect', (collector, collected) => {
    if (collector !== bot.entity) return
    const giver = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(bot.entity.position) < 5)
    const item = collected.getDroppedItem?.()
    if (giver && item) notice(`${giver.username} gave you ${item.count} ${item.name}`, true)
  })

  // Hit by a player.
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
    const p = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(bot.entity.position) < 4)
    if (p && !W.nearestHostile(bot, 5)) notice(`${p.username} hit you! (health ${Math.round(bot.health)}/20)`, 'always')
  })

  function tick () {
    if (!bot.entity) return
    const now = Date.now()

    // Time of day transitions.
    const t = bot.time?.timeOfDay ?? 0
    if (lastTime < 11500 && t >= 11500 && t < 13000) notice('The sun is starting to set. Night is coming soon.', true)
    if (lastTime < 23300 && t >= 23300) notice('The sun is rising. Monsters will burn soon.', false)
    if (lastTime > t && t < 1000) notice('A new day has begun.', false)
    lastTime = t

    // Weather.
    const thunder = (bot.thunderState || 0) > 0
    if (bot.isRaining && !wasRaining) notice('It started raining.', false)
    if (!bot.isRaining && wasRaining) notice('The rain stopped.', false)
    if (thunder && !wasThunder) notice('A thunderstorm started (monsters can spawn, you can sleep).', true)
    wasRaining = bot.isRaining
    wasThunder = thunder

    // Going underground / coming out.
    const c = T.cover(bot).kind
    if (coverState.kind && c !== coverState.kind && (c === 'underground' || coverState.kind === 'underground')) {
      notice(c === 'underground' ? 'You are now underground.' : 'You are back on the surface.', false)
    }
    coverState.kind = c

    // Players coming back into view after a while.
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === bot.username) continue
      const close = p.entity.position.distanceTo(bot.entity.position) < 24
      if (!close) continue
      const last = lastSeenPlayer.get(p.username)
      if (last && now - last > 3 * 60000) notice(`${p.username} is back near you after a while.`, true)
      lastSeenPlayer.set(p.username, now)
    }

    // Dangerous mobs appearing.
    for (const e of Object.values(bot.entities)) {
      if (!DANGEROUS.has(e.name)) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d > 16) continue
      const prev = seenDanger.get(e.id)
      if (!prev || now - prev > 60000) notice(`A ${e.name} is ${Math.round(d)} blocks away.`, e.name !== 'phantom')
      seenDanger.set(e.id, now)
    }
    for (const [id, at] of seenDanger) if (now - at > 120000) seenDanger.delete(id)
  }

  // Ores are scanned less often (block searches are more expensive).
  function scanOres () {
    if (!bot.entity) return
    const ids = [...VALUABLE].map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
    let found = []
    try { found = bot.findBlocks({ matching: ids, maxDistance: 12, count: 20 }) } catch {}
    for (const p of found) {
      const key = p.toString()
      if (seenOres.has(key)) continue
      seenOres.add(key)
      const b = bot.blockAt(p)
      if (!b) continue
      const rare = /diamond|emerald|ancient_debris/.test(b.name)
      notice(`You spot ${b.name} at ${p.x} ${p.y} ${p.z}.`, rare)
      break // one at a time is plenty
    }
    if (seenOres.size > 500) seenOres.clear()
  }

  const iv = setInterval(tick, 2000)
  const ivOre = setInterval(scanOres, 6000)
  bot.once('end', () => { clearInterval(iv); clearInterval(ivOre) })
}

module.exports = { startSenses }
