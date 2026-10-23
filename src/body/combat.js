'use strict'

// The fighting engine, shared by the self-defense reflex and the attack, guard and Nether actions.
//
// How well it fights comes from the combat skill tier (src/skills/registry.js):
//   - timed swings: waits for the weapon's attack cooldown so every hit does full damage
//   - priorities: deals with the most dangerous monster first (a creeper about to blow,
//     skeletons and witches) instead of whatever is nearest
//   - backing off to eat when a fight goes badly
//   - shield, creeper dodging, strafing around the target instead of standing still
//   - a bow for skeletons, creepers and other mobs best kept at a distance
//   - critical hits: jump, and strike while falling (+50% damage)
//
// Everything is driven by plain control states (forward/left/right/back/jump), look angles and
// bot.attack(), so it works on any server without extra plugins.

const { goals } = require('mineflayer-pathfinder')
const W = require('./world')

// Used when a bot has no skill book (tests, or skills turned off): a solid, unflashy fighter.
const DEFAULT_SKILL = {
  reactionMs: 0, panicChance: 0, fleeBonus: 0, attackRange: 3, timedSwings: true, prioritize: true, eatAt: 10,
  useShield: true, creeperDodge: true, strafe: 'steady', bow: true, bowRange: 16, bowLead: false, crits: 0
}

// Mobs that are best fought from a distance (they shoot back, or explode).
const SHOOT_FIRST = new Set(['skeleton', 'stray', 'bogged', 'creeper', 'witch', 'pillager', 'blaze', 'ghast', 'evoker', 'breeze', 'phantom'])

// How dangerous each kind of enemy is (bigger = deal with it first).
const THREAT = {
  creeper: 9, evoker: 10, ravager: 9, vindicator: 9, piglin_brute: 9, warden: 0, wither_skeleton: 9,
  skeleton: 8, stray: 8, bogged: 8, pillager: 8, blaze: 8, breeze: 8, witch: 7, hoglin: 7, zoglin: 7,
  enderman: 7, vex: 6, cave_spider: 6, zombified_piglin: 6, piglin: 6, guardian: 6, phantom: 5,
  spider: 5, zombie: 4, husk: 4, drowned: 4, zombie_villager: 4, slime: 2, magma_cube: 3,
  silverfish: 2, endermite: 2, ghast: 5, shulker: 5, creaking: 5
}

function threatScore (bot, e, { attacker = null } = {}) {
  const d = e.position.distanceTo(bot.entity.position)
  const base = e.type === 'player' ? 6 : (THREAT[e.name] ?? (W.isHostile(e) ? 4 : 1))
  let s = base * (1 + 6 / (d + 1))
  if (attacker && attacker.id === e.id) s += 8 // it's hitting us right now
  if (e.name === 'creeper' && d < 5) s += 25 // about to blow: everything else can wait
  if (SHOOT_FIRST.has(e.name) && d > 4) s += 3 // ranged attackers keep hurting you until dealt with
  return s
}

// Pick a target from candidates: the most dangerous one if the bot has learned to prioritise,
// otherwise simply the nearest.
function pickTarget (bot, candidates, skill = DEFAULT_SKILL, opts = {}) {
  const list = candidates.filter(Boolean)
  if (!list.length) return null
  const me = bot.entity.position
  if (!skill.prioritize) return list.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  return list.sort((a, b) => threatScore(bot, b, opts) - threatScore(bot, a, opts))[0]
}

// Every hostile within radius (same height band as the bot), optionally filtered.
function nearbyThreats (bot, radius, filter = () => true) {
  const me = bot.entity.position
  return Object.values(bot.entities || {}).filter(e => e && e !== bot.entity && e.position && W.isHostile(e) &&
    e.position.distanceTo(me) <= radius && Math.abs(e.position.y - me.y) < 6 && filter(e))
}

// Time between full-strength swings (ms), from Java Edition attack speeds.
function attackCooldownMs (item) {
  const n = item?.name || ''
  if (n.endsWith('_sword')) return 625
  if (n.endsWith('_axe')) return /^(wooden|stone)_/.test(n) ? 1250 : /^iron_/.test(n) ? 1110 : 1000
  if (n === 'trident') return 910
  if (n === 'mace') return 1670
  if (n.endsWith('_pickaxe')) return 833
  if (n.endsWith('_shovel')) return 1000
  if (n.endsWith('_hoe')) return 500
  return 250 // fist or anything else
}

// ------------------------------------------------------------------ archery

const ARROW = { speed: 3.0, drag: 0.99, gravity: 0.05 } // blocks per tick at full draw (Java Edition)

// Fly an arrow shot at `pitch` (radians, up = positive) and return its height relative to the
// shooter once it has travelled `horiz` blocks, plus how many ticks that took. null = falls short.
function simulateArrow (pitch, horiz, { speed = ARROW.speed, maxTicks = 120 } = {}) {
  let x = 0; let y = 0
  let vx = speed * Math.cos(pitch); let vy = speed * Math.sin(pitch)
  for (let t = 1; t <= maxTicks; t++) {
    const nx = x + vx; const ny = y + vy
    if (nx >= horiz) {
      const f = (horiz - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vx *= ARROW.drag; vy *= ARROW.drag; vy -= ARROW.gravity
    if (vx < 0.05) return null
  }
  return null
}

// The low-arc pitch that lands an arrow `horiz` blocks away and `dy` blocks up (or down).
// Returns { pitch, ticks } or null when the target is out of range.
function solvePitch (horiz, dy) {
  let lo = -1.2; let hi = 0.7 // the low arc is monotonic in this band
  const at = (p) => simulateArrow(p, horiz)
  const top = at(hi)
  if (!top || top.y < dy) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const r = at(mid)
    if (!r || r.y < dy) lo = mid
    else hi = mid
  }
  const r = at(hi)
  return r ? { pitch: hi, ticks: r.ticks } : null
}

// Where to look to hit a target: yaw/pitch in mineflayer's convention (yaw 0 = north, -z).
// With lead=true it aims at where the target will be when the arrow arrives.
function aim (from, targetPos, velocity = null, lead = false) {
  let tp = targetPos
  let sol = null
  for (let i = 0; i < (lead ? 3 : 1); i++) {
    const dx = tp.x - from.x; const dz = tp.z - from.z
    const horiz = Math.sqrt(dx * dx + dz * dz)
    sol = solvePitch(Math.max(horiz, 0.5), tp.y - from.y)
    if (!sol) return null
    if (!lead || !velocity) break
    const v = velocity
    tp = { x: targetPos.x + (v.x || 0) * sol.ticks, y: targetPos.y, z: targetPos.z + (v.z || 0) * sol.ticks }
  }
  const dx = tp.x - from.x; const dz = tp.z - from.z
  return { yaw: Math.atan2(-dx, -dz), pitch: sol.pitch, ticks: sol.ticks, point: tp }
}

function hasBowAndArrows (bot) {
  const items = bot.inventory.items()
  const bow = items.find(i => i.name === 'bow')
  const arrows = items.some(i => /(^|_)arrow$/.test(i.name))
  return bow && arrows ? bow : null
}

// ------------------------------------------------------------------ helpers

const isAlive = (e) => !!e && e.isValid !== false && !(typeof e.health === 'number' && e.health <= 0 && e.type !== 'player')
const dist = (bot, e) => e.position.distanceTo(bot.entity.position)
const aimPoint = (e) => e.position.offset(0, (e.height || 1.8) * 0.75, 0)
const eyes = (bot) => bot.entity.position.offset(0, (bot.entity.height || 1.62) - 0.1, 0)

function setControls (bot, states) {
  for (const [k, v] of Object.entries(states)) {
    try { bot.setControlState(k, v) } catch {}
  }
}

const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
function releaseMovement (bot) {
  setControls(bot, Object.fromEntries(MOVE_KEYS.map(k => [k, false])))
}

async function ensureMelee (bot) {
  const weapon = W.bestWeapon(bot)
  if (weapon && bot.heldItem?.name !== weapon.name) {
    try { await bot.equip(weapon, 'hand') } catch {}
  }
}

async function ensureShield (bot) {
  const shield = bot.inventory.items().find(i => i.name === 'shield')
  if (shield && bot.inventory.slots?.[45]?.name !== 'shield') {
    try { await bot.equip(shield, 'off-hand') } catch {}
  }
  return bot.inventory.slots?.[45]?.name === 'shield' || !!shield
}

// Food to grab mid-fight: a golden apple when it's getting serious, otherwise the best food.
function fightFood (bot) {
  if (bot.health <= 8) {
    const g = bot.inventory.items().find(i => i.name === 'enchanted_golden_apple' || i.name === 'golden_apple')
    if (g) return g
  }
  if (bot.food >= 20) return null // eating does nothing for health at a full belly (except golden apples)
  return W.bestFood(bot, { allowBad: bot.food < 6 })
}

// ------------------------------------------------------------------ the fight

// Fight `target` until it dies, the time runs out, health drops to stopHealth, or (in the
// reflex) it's no longer worth it. Returns stats: { killed, kills, label, hits, crits, arrows, ate, switched }.
//
// opts:
//   skill          combat tier params (defaults to a solid fighter)
//   sleep, check   cancellable wait / cancellation check from the action context
//   maxMs          give up after this long (default 30 s)
//   stopHealth     stop at or below this health (so the flee reflex can take over)
//   switchTargets  allow switching to a more dangerous enemy mid-fight (default true)
//   radius         how far around the bot it looks for other enemies when switching
//   onStatus       called with a short progress string
async function engage (bot, target, opts = {}) {
  const skill = { ...DEFAULT_SKILL, ...(opts.skill || {}) }
  const sleep = opts.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  const check = opts.check || (() => {})
  const maxMs = opts.maxMs ?? 30000
  const stopHealth = opts.stopHealth ?? 0
  const switchTargets = opts.switchTargets !== false
  const radius = opts.radius || 12
  const status = opts.onStatus || (() => {})
  const original = target
  const stats = { label: W.entityLabel(target), killed: false, kills: 0, hits: 0, crits: 0, arrows: 0, ate: 0, switched: 0, brokeOff: false, labels: [] }

  let cur = target
  let lastSwing = 0
  let lastSwitchCheck = 0
  let lastAte = 0
  let strafeDir = Math.random() < 0.5 ? 1 : -1
  let strafeUntil = 0
  let shieldUp = false
  let drawing = false
  const started = Date.now()
  const hasShield = skill.useShield ? await ensureShield(bot) : false
  await ensureMelee(bot)

  const lowerShield = () => { if (shieldUp) { try { bot.deactivateItem() } catch {} shieldUp = false } }
  const raiseShield = () => { if (hasShield && !shieldUp && !drawing) { try { bot.activateItem(true) } catch {} shieldUp = true } }
  const stopPathing = () => { try { bot.pathfinder.setGoal(null) } catch {} }

  async function backOffAndEat () {
    const food = fightFood(bot)
    if (!food) return false
    lowerShield()
    status(`backing off to eat (health ${Math.round(bot.health)})`)
    if (isAlive(cur)) {
      releaseMovement(bot)
      try { bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(cur, 8)), true) } catch {}
      const t0 = Date.now()
      while (Date.now() - t0 < 2500 && isAlive(cur) && dist(bot, cur) < 7) { check(); await sleep(100) }
      stopPathing()
    }
    try {
      await bot.equip(food, 'hand')
      await Promise.race([bot.consume(), sleep(3500)])
      stats.ate++
    } catch {}
    lastAte = Date.now()
    await ensureMelee(bot)
    return true
  }

  async function shoot (bow) {
    lowerShield()
    stopPathing()
    if (bot.heldItem?.name !== 'bow') { try { await bot.equip(bow, 'hand') } catch {} }
    releaseMovement(bot)
    status(`shooting at ${W.entityLabel(cur)}`)
    const doAim = async () => {
      const a = aim(eyes(bot), aimPoint(cur), cur.velocity, skill.bowLead)
      if (a) { try { await bot.look(a.yaw, a.pitch, true) } catch {} }
      return a
    }
    if (!await doAim()) return false
    try { bot.activateItem() } catch {}
    drawing = true
    const t0 = Date.now()
    // Champions keep moving sideways while they draw.
    if (skill.strafe === 'random') setControls(bot, { [strafeDir > 0 ? 'left' : 'right']: true })
    while (Date.now() - t0 < 1100) {
      check()
      if (!isAlive(cur)) break
      await sleep(100)
      await doAim()
    }
    releaseMovement(bot)
    if (isAlive(cur)) await doAim()
    try { bot.deactivateItem() } catch {}
    drawing = false
    stats.arrows++
    await sleep(250)
    return true
  }

  async function swing () {
    lowerShield()
    try { await bot.lookAt(aimPoint(cur), true) } catch {}
    let crit = false
    if (skill.crits && Math.random() < skill.crits && bot.entity.onGround !== false && !bot.entity.isInWater) {
      // Jump, then strike while falling: a critical hit.
      setControls(bot, { sprint: false, jump: true })
      const t0 = Date.now()
      let left = false
      while (Date.now() - t0 < 600) {
        await sleep(30)
        if (bot.entity.onGround === false) left = true
        if (left && (bot.entity.velocity?.y ?? 0) < -0.01) { crit = true; break }
      }
      setControls(bot, { jump: false })
      if (!isAlive(cur) || dist(bot, cur) > skill.attackRange + 0.6) return
    }
    try { await bot.lookAt(aimPoint(cur), true) } catch {}
    bot.attack(cur)
    lastSwing = Date.now()
    stats.hits++
    if (crit) stats.crits++
    status(`fighting ${W.entityLabel(cur)} (${stats.hits} hits${stats.crits ? `, ${stats.crits} crits` : ''})`)
    // Hit and step back from creepers, so the fuse never finishes.
    if (skill.creeperDodge && cur.name === 'creeper') {
      setControls(bot, { forward: false, back: true })
      await sleep(450)
      setControls(bot, { back: false })
    }
  }

  try {
    while (Date.now() - started < maxMs) {
      check()
      if (cur.type === 'player' && W.playerInvulnerable(bot, cur.username)) { stats.brokeOff = true; stats.invulnerable = W.playerInvulnerable(bot, cur.username); break }
      if (!isAlive(cur)) {
        stats.kills++
        stats.labels.push(W.entityLabel(cur))
        if (cur === original) stats.killed = true
        // Anyone else still going for us? Finish the fight instead of standing in it.
        const next = switchTargets ? pickTarget(bot, nearbyThreats(bot, Math.min(radius, 8), e => !W.NEVER_AUTO_ATTACK.has(e.name)), skill) : null
        if (!next) break
        cur = next
        stats.switched++
        continue
      }
      if (stopHealth && bot.health <= stopHealth) { stats.brokeOff = true; break }

      // Back off and eat when it's going badly (never with a creeper right next to us).
      if (skill.eatAt && bot.health <= skill.eatAt && Date.now() - lastAte > 8000 && fightFood(bot) &&
        !(cur.name === 'creeper' && dist(bot, cur) < 3)) {
        if (await backOffAndEat()) continue
      }

      // Something more dangerous turned up?
      if (switchTargets && skill.prioritize && Date.now() - lastSwitchCheck > 700) {
        lastSwitchCheck = Date.now()
        const better = pickTarget(bot, [cur, ...nearbyThreats(bot, radius, e => !W.NEVER_AUTO_ATTACK.has(e.name))], skill)
        if (better && better !== cur && threatScore(bot, better) > threatScore(bot, cur) * 1.3) {
          cur = better
          stats.switched++
          status(`switching to the ${W.entityLabel(cur)}`)
        }
      }

      const d = dist(bot, cur)
      if (d > 32) { stats.gotAway = true; break }

      // Bow: skeletons, creepers and friends, while they're still at a distance.
      const bow = skill.bow && SHOOT_FIRST.has(cur.name) && d >= (cur.name === 'creeper' ? 5 : 6) && d <= skill.bowRange && hasBowAndArrows(bot)
      if (bow && W.lineOfSight(bot, eyes(bot), aimPoint(cur))) {
        await shoot(bow)
        continue
      }
      if (bot.heldItem?.name === 'bow') await ensureMelee(bot)

      // Close the distance.
      const reach = skill.attackRange || 3
      if (d > reach + 2.5) {
        lowerShield()
        releaseMovement(bot)
        try { bot.pathfinder.setGoal(new goals.GoalFollow(cur, Math.max(1, reach - 1)), true) } catch {}
        await sleep(150)
        continue
      }
      stopPathing()
      try { await bot.lookAt(aimPoint(cur), true) } catch {}

      // Footwork in melee range: step in or out, and strafe instead of standing still.
      const cooldown = skill.timedSwings ? attackCooldownMs(bot.heldItem) : 250
      const ready = Date.now() - lastSwing >= cooldown
      const creeperClose = skill.creeperDodge && cur.name === 'creeper' && d < 2.5
      const moves = { forward: d > reach - 0.4 && !creeperClose, back: d < 1.2 || (creeperClose && !ready), left: false, right: false, sprint: d > reach }
      if (skill.strafe !== 'none' && d <= reach + 0.5) {
        if (Date.now() > strafeUntil) {
          if (skill.strafe === 'random') strafeDir = Math.random() < 0.5 ? 1 : -1
          else strafeDir = -strafeDir
          strafeUntil = Date.now() + (skill.strafe === 'random' ? 300 + Math.random() * 900 : 1200)
        }
        moves[strafeDir > 0 ? 'left' : 'right'] = true
      }
      setControls(bot, moves)

      if (ready && d <= reach + 0.3) {
        await swing()
      } else if (!ready && skill.useShield && !SHOOT_FIRST.has(cur.name)) {
        raiseShield() // block between swings
      }
      await sleep(100)
    }
  } finally {
    lowerShield()
    if (drawing) { try { bot.deactivateItem() } catch {} }
    releaseMovement(bot)
    stopPathing()
  }
  if (!isAlive(original)) stats.killed = true
  return stats
}

module.exports = {
  DEFAULT_SKILL,
  SHOOT_FIRST,
  THREAT,
  threatScore,
  pickTarget,
  nearbyThreats,
  attackCooldownMs,
  simulateArrow,
  solvePitch,
  aim,
  hasBowAndArrows,
  isAlive,
  engage
}
