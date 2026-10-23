'use strict'

// Small "alive" behaviours while standing still: look at nearby players, glance around, and
// (scaled by bot.mannerisms.level) fidget like a person waiting: hop, crouch, look up at the sky
// or at a passing animal, punch the air, take a step. Greets someone who walks up after a while.
// Never runs during a task or reflex.

const { levelOf, crouchNod } = require('./mannerisms')

function startIdleBehaviors (bot, executor, config = {}) {
  let lastGlance = 0
  let lastFidget = Date.now()
  const lastNear = new Map() // player -> last time they were close
  const level = () => levelOf(config)
  const idle = () => bot.entity && executor.isIdle() && !executor.reflexActive && !bot.pathfinder?.isMoving?.()

  async function fidget () {
    const roll = Math.random()
    if (roll < 0.25) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250); return }
    if (roll < 0.45) { await crouchNod(bot, 1); return }
    if (roll < 0.6) { await bot.look(bot.entity.yaw + (Math.random() - 0.5), -1.1 + Math.random() * 0.3); return } // look up at the sky
    if (roll < 0.75) {
      const animal = bot.nearestEntity(e => e !== bot.entity && e.type !== 'player' && e.position && e.position.distanceTo(bot.entity.position) < 12)
      if (animal) { await bot.lookAt(animal.position.offset(0, (animal.height || 1) * 0.8, 0)); return }
    }
    if (roll < 0.87) { bot.swingArm?.(); return }
    // A step or two in some direction, then stop.
    await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2, 0)
    bot.setControlState('forward', true)
    setTimeout(() => bot.setControlState('forward', false), 250 + Math.random() * 300)
  }

  const iv = setInterval(async () => {
    try {
      if (!idle()) { lastFidget = Date.now(); return }
      const me = bot.entity.position
      const L = level()
      const player = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(me) < 10)
      if (player) {
        // Someone just walked up after being away a while: a nod hello.
        const seen = lastNear.get(player.username) || 0
        lastNear.set(player.username, Date.now())
        await bot.lookAt(player.position.offset(0, player.height || 1.6, 0))
        if (L && Date.now() - seen > 5 * 60000 && player.position.distanceTo(me) < 6) await crouchNod(bot, 2)
        return
      }
      if (L && Date.now() - lastFidget > (25000 - 17000 * L) * (0.6 + Math.random() * 0.8)) {
        lastFidget = Date.now()
        await fidget()
        return
      }
      if (Date.now() - lastGlance > 6000 + Math.random() * 6000) {
        lastGlance = Date.now()
        await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.6)
      }
    } catch {}
  }, 1500)
  bot.once('end', () => clearInterval(iv))
  return () => clearInterval(iv)
}

module.exports = { startIdleBehaviors }
