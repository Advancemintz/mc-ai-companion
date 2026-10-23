'use strict'
// Simulated fights: a flat open arena with simple physics (jumping, walking, knockback-free
// mobs that chase and hit), real arrows, and the real combat engine and actions.
// Run with: npm run test:sim
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const P = path.join(__dirname, '..') + '/'
const { Vec3 } = require('vec3')
const { worldBot } = require('./harness')
const C = require(P + 'src/body/combat')
const { SKILLS } = require(P + 'src/skills/registry')
const { Executor } = require(P + 'src/body/executor')
const { actions } = require(P + 'src/body/actions')
const { until } = require(P + 'test/helpers')

const tierParams = (n) => SKILLS.combat.tiers[n - 1].params
const DAMAGE = { iron_sword: 6, diamond_sword: 7, stone_sword: 5 }

// A world with physics, mobs and an arrow simulation. Returns { bot, spawn, stop, log }.
function arena () {
  const bot = worldBot()
  const log = { deaths: [], swings: [], crits: 0, arrows: [], hitsTaken: 0, ate: [], controls: new Set(), looks: [] }
  const ground = 64
  bot.entity.position = new Vec3(0.5, ground, 0.5)
  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.entity.onGround = true
  bot.entity.yaw = 0
  bot.entity.pitch = 0
  bot.entity.height = 1.62
  bot.entities = { [-1]: bot.entity }
  const controls = {}
  bot.setControlState = (k, v) => { controls[k] = v; if (v) log.controls.add(k) }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  bot.lookAt = async (p) => {
    const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
    bot.entity.yaw = Math.atan2(-d.x, -d.z)
    bot.entity.pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z))
  }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; log.looks.push([yaw, pitch]) }
  bot.nearestEntity = (fn = () => true) => Object.values(bot.entities).filter(e => e !== bot.entity && fn(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.inventory.slots = []
  bot.equip = async (item, dest) => { if (dest === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item }
  let drawingSince = 0
  bot.activateItem = (offhand) => { if (!offhand && bot.heldItem?.name === 'bow') drawingSince = Date.now(); if (offhand) log.shield = (log.shield || 0) + 1 }
  bot.deactivateItem = () => {
    if (!drawingSince) return
    const charged = Date.now() - drawingSince >= 900
    drawingSince = 0
    const arrows = bot._items.find(i => i.name === 'arrow')
    if (!arrows) return
    arrows.count--
    if (!arrows.count) bot._items.splice(bot._items.indexOf(arrows), 1)
    // Fly the arrow (Java Edition physics) and see what it hits.
    const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
    let p = bot.entity.position.offset(0, 1.52, 0)
    let v = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(charged ? 3 : 1.5)
    let hit = null
    for (let t = 0; t < 100 && !hit; t++) {
      const next = p.plus(v)
      for (let k = 1; k <= 8 && !hit; k++) {
        const q = p.plus(next.minus(p).scaled(k / 8))
        // Mobs keep moving while the arrow flies.
        const ft = t + k / 8
        hit = Object.values(bot.entities).find(e => {
          if (e === bot.entity) return false
          const ep = e.position.plus((e.velocity || new Vec3(0, 0, 0)).scaled(ft))
          return Math.abs(q.x - ep.x) < 0.5 && Math.abs(q.z - ep.z) < 0.5 && q.y >= ep.y - 0.1 && q.y <= ep.y + (e.height || 1.8) + 0.1
        })
      }
      p = next; v = v.scaled(0.99); v.y -= 0.05
    }
    log.arrows.push({ hit: hit?.name || null, charged })
    if (hit) damage(hit, charged ? 9 : 3)
  }
  bot.attack = (e) => {
    const me = bot.entity
    const crit = me.onGround === false && me.velocity.y < 0
    log.swings.push({ at: Date.now(), target: e.name, crit })
    if (crit) log.crits++
    if (e.position.distanceTo(me.position) > 3.6) return
    damage(e, (DAMAGE[bot.heldItem?.name] || 1) * (crit ? 1.5 : 1))
  }
  bot.consume = async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
    const it = bot.heldItem
    log.ate.push({ name: it?.name, health: bot.health })
    bot.food = Math.min(20, bot.food + 5)
    if (it?.name === 'golden_apple') bot.health = Math.min(20, bot.health + 4)
    if (it) { it.count--; if (!it.count) { bot._items.splice(bot._items.indexOf(it), 1); bot.heldItem = null } }
  }
  let goal = null
  bot.pathfinder.setGoal = (g) => { goal = g }
  bot.pathfinder.goto = async () => {}
  function damage (e, n) {
    e.health -= n
    if (e.health <= 0 && e.isValid) { e.isValid = false; delete bot.entities[e.id]; log.deaths.push(e.name) }
  }
  let nextId = 1
  function spawn (name, x, z, opts = {}) {
    const e = { id: nextId++, name, type: 'hostile', position: new Vec3(x, ground, z), velocity: new Vec3(0, 0, 0), height: 1.8, isValid: true, health: opts.health ?? 20, lastHit: 0, ...opts }
    bot.entities[e.id] = e
    return e
  }
  // 20 ticks a second: gravity and jumping, walking by control states and pathfinder goals, mob AI.
  const timer = setInterval(() => {
    const me = bot.entity
    if (controls.jump && me.onGround) { me.velocity.y = 0.42; me.onGround = false }
    if (!me.onGround) {
      me.position.y += me.velocity.y
      me.velocity.y = (me.velocity.y - 0.08) * 0.98
      if (me.position.y <= ground) { me.position.y = ground; me.velocity.y = 0; me.onGround = true }
    }
    const yaw = me.yaw
    const fwd = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
    const left = new Vec3(-Math.cos(yaw), 0, Math.sin(yaw))
    let move = new Vec3(0, 0, 0)
    if (controls.forward) move = move.plus(fwd)
    if (controls.back) move = move.minus(fwd)
    if (controls.left) move = move.plus(left)
    if (controls.right) move = move.minus(left)
    if (goal && goal.kind === 'GoalFollow') {
      const t = goal.args[0]
      if (t?.position && t.position.distanceTo(me.position) > goal.args[1]) move = t.position.minus(me.position).normalize()
    } else if (goal && goal.kind === 'GoalInvert') {
      const t = goal.args[0].args[0]
      if (t?.position) move = me.position.minus(t.position).normalize()
    }
    if (move.norm() > 0) { const m = move.normalize().scaled(0.22); me.position.x += m.x; me.position.z += m.z }
    for (const e of Object.values(bot.entities)) {
      if (e === me || e.passive) continue
      const d = e.position.distanceTo(me.position)
      const ranged = e.name === 'skeleton'
      const want = ranged ? 8 : 1.2
      const before = e.position.clone()
      if (!e.frozen && d > want) { const step = me.position.minus(e.position); step.y = 0; const m = step.normalize().scaled(e.speed ?? 0.1); e.position.x += m.x; e.position.z += m.z }
      if (!e.frozen) e.velocity = e.position.minus(before)
      const reach = ranged ? 16 : 1.6
      if (d <= reach && Date.now() - e.lastHit > (ranged ? 1500 : 1000) && !e.harmless) {
        e.lastHit = Date.now()
        bot.health -= e.hit ?? 2
        log.hitsTaken++
      }
    }
  }, 50)
  return { bot, spawn, log, stop: () => clearInterval(timer), controls }
}

const give = (bot, name, count = 1) => bot.give(name, count)

test('a beginner flails; a scrapper times its swings to the sword cooldown', async () => {
  for (const [tier, minGap, maxGap] of [[1, 150, 450], [2, 600, 1200]]) {
    const { bot, spawn, log, stop } = arena()
    try {
      give(bot, 'iron_sword')
      const z = spawn('zombie', 2, 0.5, { health: 200, harmless: true, frozen: true })
      await C.engage(bot, z, { skill: tierParams(tier), maxMs: 3500 })
      const gaps = log.swings.slice(1).map((s, i) => s.at - log.swings[i].at)
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
      assert.ok(avg >= minGap && avg <= maxGap, `tier ${tier}: average gap ${Math.round(avg)}ms`)
    } finally { stop() }
  }
})

test('veterans land critical hits by striking on the way down', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword')
    const z = spawn('zombie', 2.2, 0.5, { health: 40, frozen: true, harmless: true })
    const st = await C.engage(bot, z, { skill: { ...tierParams(4), crits: 1 }, maxMs: 10000 })
    assert.ok(st.killed, 'zombie should die')
    assert.ok(log.crits >= 2, `crits: ${log.crits}/${log.swings.length}`)
    assert.strictEqual(st.crits, log.crits)
    // 40 health at 6 per normal hit = 7 hits; crits (9) need fewer.
    assert.ok(log.swings.length <= 6, `took ${log.swings.length} swings`)
  } finally { stop() }
})

test('a fighter shoots a skeleton at range instead of walking into its arrows', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bow'); give(bot, 'arrow', 16)
    const sk = spawn('skeleton', 0.5, -12.5, { health: 20, frozen: true })
    const st = await C.engage(bot, sk, { skill: tierParams(3), maxMs: 12000 })
    assert.ok(st.killed, 'skeleton should die')
    assert.ok(st.arrows >= 3, `arrows: ${st.arrows}`)
    assert.ok(log.arrows.filter(a => a.hit === 'skeleton').length >= 3, JSON.stringify(log.arrows))
    assert.strictEqual(log.swings.length, 0) // never needed to walk up and swing
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) < 3)
  } finally { stop() }
})

test('without arrows (or below Fighter) it closes in with the sword', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bow')
    const sk = spawn('skeleton', 0.5, -10.5, { health: 12, frozen: true, harmless: true })
    const st = await C.engage(bot, sk, { skill: tierParams(3), maxMs: 12000 })
    assert.ok(st.killed)
    assert.strictEqual(st.arrows, 0)
    assert.ok(log.swings.length >= 2)
  } finally { stop() }
})

test('veterans lead a moving creeper and drop it before it arrives', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bow'); give(bot, 'arrow', 16)
    // Walking across the bot's field of view, 20 blocks out.
    const cr = spawn('creeper', -8, -20, { health: 20, frozen: true, harmless: true })
    const mover = setInterval(() => { if (cr.isValid) { cr.position.x += 0.1; cr.velocity = new Vec3(0.1, 0, 0) } }, 50)
    const st = await C.engage(bot, cr, { skill: tierParams(4), maxMs: 12000 })
    clearInterval(mover)
    assert.ok(st.killed, 'creeper should die: ' + JSON.stringify({ st, arrows: log.arrows, pos: cr.position }))
    const hits = log.arrows.filter(a => a.hit === 'creeper').length
    assert.ok(hits >= 3 && hits >= log.arrows.length - 1, JSON.stringify(log.arrows))
  } finally { stop() }
})

test('the most dangerous enemy first: a creeper walking up gets dealt with before the zombie', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword')
    const z = spawn('zombie', 2, 0.5, { health: 60, frozen: true, harmless: true })
    const cr = spawn('creeper', 0.5, 6, { health: 12, harmless: true, speed: 0.15 })
    const st = await C.engage(bot, z, { skill: tierParams(2), maxMs: 6000 })
    assert.ok(!cr.isValid, 'creeper should be dead')
    assert.ok(st.switched >= 1)
    const firstCreeperSwing = log.swings.findIndex(s => s.target === 'creeper')
    assert.ok(firstCreeperSwing >= 0 && firstCreeperSwing < 3, `first creeper swing at #${firstCreeperSwing}`)
  } finally { stop() }
})

test('a beginner just hits whatever it was fighting', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword')
    const z = spawn('zombie', 2, 0.5, { health: 60, frozen: true, harmless: true })
    spawn('creeper', 0.5, 6, { health: 12, harmless: true, speed: 0.15 })
    await C.engage(bot, z, { skill: tierParams(1), maxMs: 2500 })
    assert.ok(log.swings.length && log.swings.every(s => s.target === 'zombie'))
  } finally { stop() }
})

test('fighters strafe; scrappers stand still', async () => {
  for (const [tier, expect] of [[3, true], [2, false]]) {
    const { bot, spawn, log, stop } = arena()
    try {
      give(bot, 'iron_sword')
      const z = spawn('zombie', 2, 0.5, { health: 200, frozen: true, harmless: true })
      await C.engage(bot, z, { skill: tierParams(tier), maxMs: 3000 })
      const strafed = log.controls.has('left') || log.controls.has('right')
      assert.strictEqual(strafed, expect, `tier ${tier}`)
      if (expect) assert.ok(log.controls.has('left') && log.controls.has('right'), 'switches direction')
    } finally { stop() }
  }
})

test('backs off to eat when hurt, then finishes the fight', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bread', 3)
    bot.health = 8; bot.food = 14
    const z = spawn('zombie', 2, 0.5, { health: 30, harmless: true })
    const st = await C.engage(bot, z, { skill: tierParams(2), maxMs: 15000 })
    assert.ok(st.ate >= 1 && log.ate.length >= 1)
    assert.ok(st.killed)
    // It ate away from the zombie, not in its face.
    assert.ok(log.ate[0].name === 'bread')
  } finally { stop() }
})

test('a beginner never stops to eat mid-fight', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bread', 3)
    bot.health = 8; bot.food = 14
    const z = spawn('zombie', 2, 0.5, { health: 30, harmless: true, frozen: true })
    await C.engage(bot, z, { skill: tierParams(1), maxMs: 6000 })
    assert.strictEqual(log.ate.length, 0)
  } finally { stop() }
})

test('attack "hostile" goes for the skeleton before the nearer zombie, and reports its tricks', async () => {
  const { bot, spawn, log, stop } = arena()
  try {
    give(bot, 'iron_sword'); give(bot, 'bow'); give(bot, 'arrow', 20)
    const z = spawn('zombie', 3, 0.5, { health: 10, frozen: true, harmless: true })
    const sk = spawn('skeleton', 0.5, -11.5, { health: 20, frozen: true, harmless: true })
    const skills = { params: () => tierParams(3), award: () => [], gate: () => {} }
    const ex = new Executor(bot, actions, { skills: null })
    ex.skills = skills
    let out = null
    ex.on('planFinished', e => { out = e.results[0] })
    ex.on('actionFailed', e => { out = 'FAILED ' + e.error })
    ex.setPlan([{ name: 'attack', args: { target: 'hostile' } }])
    await until(() => out, 15000)
    assert.match(out, /killed \d hostile \(.*arrows shot/)
    assert.strictEqual(log.deaths[0], 'skeleton')
  } finally { stop() }
})

module.exports = { arena }
