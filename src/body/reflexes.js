'use strict'

// Fast, LLM-free survival instincts. Checked several times per second.
// They interrupt the current action, deal with the problem, then the action resumes.
//   - flee when health is low and a monster is close
//   - fight back against monsters that get too close
//   - eat when hungry
//   - swim up when running out of air
// The brain is told what happened (without being woken up for every little thing).

const { goals } = require('mineflayer-pathfinder')
const W = require('./world')
const log = require('../util/log')
const { sleep } = require('./executor')

function startReflexes (bot, executor, config, notify) {
  const cfg = config.reflexes
  let lastHurtBy = null
  let lastHurtAt = 0
  let lastEatAttempt = 0
  let busy = false
  let lastFleeNotice = 0
  const ignoreUntil = new Map() // entity id -> timestamp; mobs we couldn't reach
  const notIgnored = (e) => (ignoreUntil.get(e.id) || 0) < Date.now()
  // Combat skill: how fast it reacts, how easily it panics, and which tricks it knows.
  const combat = () => executor.skills?.params('combat') ||
    { reactionMs: 0, panicChance: 0, fleeBonus: 0, attackRange: 3, useShield: false, creeperDodge: false }
  const fleeAt = () => cfg.fleeHealth + (combat().fleeBonus || 0)

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
    lastHurtAt = Date.now()
    // Best guess at the attacker: closest hostile (or neutral mob that's angry) within 6 blocks.
    lastHurtBy = bot.nearestEntity(e => e !== bot.entity && W.isMob(e) &&
      e.position.distanceTo(bot.entity.position) < 6 &&
      (W.isHostile(e) || W.NEUTRAL_MOBS.has(e.name)))
  })

  async function fight (target) {
    const label = W.entityLabel(target)
    const skill = combat()
    const weapon = W.bestWeapon(bot)
    if (weapon && bot.heldItem?.name !== weapon.name) {
      try { await bot.equip(weapon, 'hand') } catch {}
    }
    if (skill.useShield) {
      const shield = bot.inventory.items().find(i => i.name === 'shield')
      if (shield && bot.inventory.slots[45]?.name !== 'shield') { try { await bot.equip(shield, 'off-hand') } catch {} }
    }
    if (bot.pvp) bot.pvp.attackRange = skill.attackRange || 3
    await bot.pvp.attack(target)
    const started = Date.now()
    while (target.isValid && bot.pvp.target === target && Date.now() - started < 30000) {
      if (bot.health <= fleeAt()) break
      // Fighter tier and up: back off when a creeper gets too close, then go back in.
      if (skill.creeperDodge && target.name === 'creeper' && target.position.distanceTo(bot.entity.position) < 2.2) {
        try { bot.pvp.forceStop ? bot.pvp.forceStop() : await bot.pvp.stop() } catch {}
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 5)), true)
        await sleep(900)
        bot.pathfinder.setGoal(null)
        if (!target.isValid) break
        await bot.pvp.attack(target)
      }
      await sleep(200)
    }
    const killed = !target.isValid
    try { bot.pvp.forceStop ? bot.pvp.forceStop() : await bot.pvp.stop() } catch {}
    return { killed, label }
  }

  async function flee (threat) {
    const label = W.entityLabel(threat)
    try { bot.pvp.forceStop ? bot.pvp.forceStop() : await bot.pvp.stop() } catch {}
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 18)), true)
    const started = Date.now()
    while (Date.now() - started < 8000 && threat.isValid && threat.position.distanceTo(bot.entity.position) < 16) {
      await sleep(250)
    }
    bot.pathfinder.setGoal(null)
    await eatIfPossible(true)
    return label
  }

  async function eatIfPossible (urgent = false) {
    if (bot.food >= 20) return false
    const food = W.bestFood(bot, { allowBad: urgent || bot.food < 6 })
    if (!food) return false
    try {
      await bot.equip(food, 'hand')
      await Promise.race([bot.consume(), sleep(5000)])
      return true
    } catch {
      return false
    }
  }

  async function tick () {
    if (busy || !bot.entity || bot.health <= 0 || executor.reflexActive) return
    busy = true
    try {
      const pos = bot.entity.position
      const fightingAlready = executor.isBusyWith('attack') || executor.isBusyWith('guard')

      // 1. Flee: low health and something dangerous nearby.
      const danger = W.nearestHostile(bot, 10)
      if (danger && bot.health <= fleeAt()) {
        await executor.interrupt('flee', async () => {
          log.reflex(`low health (${Math.round(bot.health)}), fleeing from ${W.entityLabel(danger)}`)
          const label = await flee(danger)
          const wake = Date.now() - lastFleeNotice > 30000
          lastFleeNotice = Date.now()
          notify(`[reflex] Health got low (${Math.round(bot.health)}/20) so you ran away from a ${label}.`, wake)
        })
        return
      }

      // 2. Self-defense: fight monsters that come close, or whatever just hit us.
      if (cfg.selfDefense && !fightingAlready) {
        const recentAttacker = lastHurtBy && lastHurtBy.isValid && Date.now() - lastHurtAt < 4000 &&
          lastHurtBy.position.distanceTo(pos) < 8 ? lastHurtBy : null
        const close = W.nearestHostile(bot, cfg.defendRadius, e => !W.NEVER_AUTO_ATTACK.has(e.name) && notIgnored(e))
        const target = recentAttacker || close
        if (target && !W.NEVER_AUTO_ATTACK.has(target.name)) {
          const skill = combat()
          // A beginner sometimes just panics and runs instead of fighting.
          if (!recentAttacker && skill.panicChance && Math.random() < skill.panicChance) {
            await executor.interrupt('panic', async () => {
              log.reflex(`panicked at the sight of a ${W.entityLabel(target)}`)
              const label = await flee(target)
              ignoreUntil.set(target.id, Date.now() + 20000)
              executor.skills?.award('combat', 1)
              notify(`[reflex] A ${label} came close and you panicked and ran (you're still new to fighting).`, false)
            })
            return
          }
          await executor.interrupt('self-defense', async () => {
            log.reflex(`defending against ${W.entityLabel(target)}`)
            if (!recentAttacker && skill.reactionMs) await sleep(skill.reactionMs) // slow to react
            const { killed, label } = await fight(target)
            lastHurtBy = null
            if (!killed) ignoreUntil.set(target.id, Date.now() + 45000)
            executor.skills?.award('combat', killed ? 6 : 2, killed ? `killed a ${label}` : '')
            notify(`[reflex] A ${label} came at you; ${killed ? 'you killed it' : 'you fought it off'}. Health ${Math.round(bot.health)}/20.`, false)
          })
          return
        }
      }

      // 3. Eat when hungry (not in the middle of a fight).
      const hungry = bot.food <= 14 || (bot.health < 14 && bot.food < 20)
      if (cfg.autoEat && hungry && !danger && !fightingAlready && Date.now() - lastEatAttempt > 15000) {
        lastEatAttempt = Date.now()
        if (W.bestFood(bot, { allowBad: bot.food < 6 })) {
          await executor.interrupt('eat', async () => {
            const before = bot.food
            const ate = await eatIfPossible()
            if (ate) log.reflex(`ate (food ${before} -> ${bot.food})`)
          })
        } else if (bot.food <= 6) {
          notify(`[reflex] You are very hungry (food ${bot.food}/20) and have no food.`, true)
          lastEatAttempt = Date.now() + 120000 // don't nag
        }
        return
      }

      // 4. Drowning: swim up.
      if (bot.oxygenLevel !== undefined && bot.oxygenLevel < 8 && bot.entity.isInWater) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 1500)
      }
    } catch (err) {
      log.debug(`reflex tick error: ${err.message}`)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(tick, 250)
  bot.once('end', () => clearInterval(timer))
  return { stop: () => clearInterval(timer) }
}

module.exports = { startReflexes }
