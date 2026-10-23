'use strict'

// Small "alive" behaviors while standing still: look at nearby players, glance around.
// Purely cosmetic, never moves the bot and never runs during a task or reflex.

function startIdleBehaviors (bot, executor) {
  let lastGlance = 0
  const iv = setInterval(async () => {
    try {
      if (!bot.entity || !executor.isIdle() || executor.reflexActive || bot.pathfinder?.isMoving?.()) return
      const me = bot.entity.position
      const player = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity && e.position.distanceTo(me) < 10)
      if (player) {
        await bot.lookAt(player.position.offset(0, player.height || 1.6, 0))
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
