'use strict'

// About once a week per player, if the bot could build it without much trouble, it gets the
// idea to offer that player a powered rail line from its base to theirs. The LLM decides
// whether (and how) to ask, in character. If it doesn't know where they live, it may ask.

const { Vec3 } = require('vec3')
const R = require('../body/railway')
const log = require('../util/log')

const DAY = 24 * 60 * 60 * 1000

function startRailOffers (bot, brain, memory, config) {
  if (!memory) return () => {}
  const cfg = () => ({ enabled: true, intervalDays: 7, minDistance: 40, ...(config.bot.railOffers || {}) })
  const lastCheck = new Map() // player -> time we last found it too hard (re-check every few hours)

  function tick () {
    const c = cfg()
    if (!c.enabled || brain.paused || !bot.entity) return
    const home = memory.getPlace('home')
    if (!home) return
    const others = new Set((config.bot.otherBots || []).map(n => String(n).toLowerCase()))
    for (const p of Object.values(bot.players)) {
      const name = p.username
      if (!name || name === bot.username || others.has(name.toLowerCase())) continue
      if (Date.now() - memory.lastRailOffer(name) < c.intervalDays * DAY) continue
      if (Date.now() - (lastCheck.get(name) || 0) < 4 * 60 * 60 * 1000) continue

      const base = memory.playerBase(name)
      if (!base) {
        // Only bring it up when they're around, so asking makes sense.
        const near = p.entity && p.entity.position.distanceTo(bot.entity.position) < 32
        if (!near) continue
        memory.recordRailOffer(name)
        brain.notify(`[railway idea] ${name} is nearby and you don't know where their base is. If it fits your mood and how you feel about them, ask where they live (then save it with remember_place, owner "${name}") - you could build them a railway some day.`, true)
        log.info(`railway offer: asking ${name} where their base is`)
        return
      }
      if (memory.railways().some(r => (r.owner || '').toLowerCase() === name.toLowerCase())) continue
      const dist = Math.hypot(base.x - home.x, base.z - home.z)
      if (dist < c.minDistance) continue

      const route = R.planRoute(memory, new Vec3(home.x, home.y, home.z), new Vec3(base.x, base.y, base.z))
      if (route.blocked > 0) { lastCheck.set(name, Date.now()); continue }
      const need = R.estimate(route.cols.length)
      const check = R.materialCheck(bot, need)
      if (!check.easy) { lastCheck.set(name, Date.now()); continue }

      memory.recordRailOffer(name)
      const mats = check.hasAll ? 'you already have the metal and redstone for it' : `you'd need to gather ${check.missing.join(', ')}, which should be easy`
      brain.notify(`[railway idea] You could build a powered minecart railway from your base to ${name}'s base (${route.cols.length} blocks; ${mats}). If it fits your personality and how you feel about ${name}, offer it to them in chat. If they say yes, use build_railway with to "${name}".`, true)
      log.info(`railway offer: suggesting a line to ${name} (${route.cols.length} blocks)`)
      return // one idea at a time
    }
  }

  const iv = setInterval(() => { try { tick() } catch (err) { log.debug('rail offers: ' + err.message) } }, 60000)
  iv.unref?.()
  const onJoin = () => setTimeout(() => { try { tick() } catch {} }, 30000)
  bot.on('playerJoined', onJoin)
  bot.once('end', () => clearInterval(iv))
  return { tick, stop: () => clearInterval(iv) }
}

module.exports = { startRailOffers }
