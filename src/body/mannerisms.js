'use strict'

// Little things that make a bot read as a person rather than a machine:
//   - a short hesitation before starting something new, glancing at who it's working for
//   - stepping back to look at a build it just finished
//   - gestures while talking: a crouch-nod for hi/thanks, a hop when laughing or excited,
//     a head shake for no
//   - fidgets when idle: hopping, crouching, looking at the sky or at a passing animal,
//     punching the air (see src/body/idle.js)
//   - greeting someone who walks up after a while away
//
// How much of this happens is bot.mannerisms.level (0 = none, 1 = lots), which the setup page
// and the randomizer set from the personality. Nothing here changes what the bot decides.

const { goals } = require('mineflayer-pathfinder')

const BUILDS = new Set(['build', 'build_base', 'upgrade_base'])
const sleepMs = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function levelOf (config) {
  const m = config?.bot?.mannerisms
  if (!m || m.enabled === false) return m && m.enabled === false ? 0 : 0.5
  const l = Number(m.level)
  return Number.isFinite(l) ? Math.max(0, Math.min(1, l)) : 0.5
}

// Which gesture fits a chat line (null = none). Exported for tests.
function gestureFor (text) {
  const t = String(text || '').toLowerCase()
  if (/\b(ha(ha)+|lol|lmao|hehe|yay|woo+|wahoo|let'?s go+)\b/.test(t) || (t.match(/!/g) || []).length >= 2) return 'hop'
  if (/\b(no+|nope|never|nah|no way)\b/.test(t)) return 'shake'
  if (/\b(hi|hey|hello|howdy|thanks|thank you|thx|cheers|bye|cya|see ya|welcome|sorry|yes|yeah|yep|sure|okay|ok|deal|nice)\b/.test(t)) return 'nod'
  return null
}

async function crouchNod (bot, times = 2) {
  for (let i = 0; i < times; i++) {
    bot.setControlState('sneak', true); await sleepMs(170)
    bot.setControlState('sneak', false); await sleepMs(150)
  }
}

async function hop (bot) {
  bot.setControlState('jump', true); await sleepMs(250); bot.setControlState('jump', false)
}

async function shake (bot) {
  const yaw = bot.entity.yaw
  for (const d of [0.4, -0.4, 0.3, 0]) { try { await bot.look(yaw + d, bot.entity.pitch, false) } catch {} await sleepMs(120) }
}

async function gesture (bot, kind) {
  try {
    if (kind === 'nod') await crouchNod(bot)
    else if (kind === 'hop') await hop(bot)
    else if (kind === 'shake') await shake(bot)
  } catch {}
}

function nearestPlayer (bot, radius = 8) {
  return bot.nearestEntity?.(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(bot.entity.position) <= radius) || null
}

function attachMannerisms (bot, executor, brain, config) {
  const level = () => levelOf(config)

  // Before each step: a moment's pause, and a glance at the player it's doing it for.
  executor.beforeStep = async (step, ctx, def) => {
    const L = level()
    if (!L || def.instant || def.persistent) return
    const who = step.args?.player || step.args?.target
    const p = who ? bot.players?.[who]?.entity : null
    if (p) { try { await bot.lookAt(p.position.offset(0, 1.6, 0)) } catch {} }
    await ctx.sleep(Math.round((120 + Math.random() * 650) * L))
  }

  // After finishing a build: step back and take it in.
  executor.afterStep = async (step, result, ctx) => {
    const L = level()
    if (!L || !BUILDS.has(step.name) || !/^(built|finished|added)/.test(String(result))) return
    if (Math.random() > 0.35 + 0.55 * L) return
    const m = String(result).match(/at (-?\d+), (-?\d+), (-?\d+)/)
    const center = m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : bot.entity.position.floored()
    const me = bot.entity.position
    const dx = me.x - center.x; const dz = me.z - center.z
    const len = Math.hypot(dx, dz) || 1
    const spot = { x: Math.round(center.x + (dx / len) * 9), z: Math.round(center.z + (dz / len) * 9) }
    try { await ctx.race(bot.pathfinder.goto(new goals.GoalNearXZ(spot.x, spot.z, 2)), 9000) } catch (err) { if (err?.name === 'CancelledError') throw err }
    try { await bot.lookAt(new (require('vec3').Vec3)(center.x + 0.5, center.y + 3, center.z + 0.5)) } catch {}
    await ctx.sleep(1200 + Math.random() * 1800 * L)
  }

  // Gestures while talking.
  brain.onSaid = (text) => {
    const L = level()
    if (!L || Math.random() > 0.3 + 0.7 * L) return
    const kind = gestureFor(text)
    const p = nearestPlayer(bot, 10)
    if (!kind && !p) return
    Promise.resolve().then(async () => {
      if (p && executor.isIdle()) { try { await bot.lookAt(p.position.offset(0, 1.6, 0)) } catch {} }
      if (kind && !executor.reflexActive) await gesture(bot, kind)
    }).catch(() => {})
  }
}

module.exports = { attachMannerisms, gestureFor, levelOf, gesture, crouchNod }
