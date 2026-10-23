'use strict'

// Combat maths that needs no world: arrow ballistics, target priorities, swing timing.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const C = require('../src/body/combat')
const { SKILLS } = require('../src/skills/registry')

// Fly an arrow in 3D with Java Edition physics and report the closest it gets to `target`.
function closestApproach (from, yaw, pitch, target) {
  let p = from.clone()
  let v = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(3)
  let best = Infinity
  for (let t = 0; t < 120; t++) {
    const next = p.plus(v)
    for (let k = 0; k <= 10; k++) {
      const q = p.plus(next.minus(p).scaled(k / 10))
      best = Math.min(best, q.distanceTo(target))
    }
    p = next
    v = v.scaled(0.99)
    v.y -= 0.05
  }
  return best
}

test('aim: the solved angle actually hits targets near and far, above and below', () => {
  const from = new Vec3(0, 65.5, 0)
  for (const [x, dy, z] of [[0, 0, -10], [12, 3, 5], [-20, -4, 14], [0, 2, 30], [25, 0, -18]]) {
    const target = new Vec3(x, from.y + dy, z)
    const a = C.aim(from, target)
    assert.ok(a, `no solution for ${target}`)
    assert.ok(closestApproach(from, a.yaw, a.pitch, target) < 0.35, `missed ${target}`)
  }
  assert.strictEqual(C.aim(from, new Vec3(0, 65, -400)), null) // out of range
})

test('aim: leading a moving target', () => {
  const from = new Vec3(0, 65.5, 0)
  const target = new Vec3(20, 65.5, 0)
  const vel = { x: 0, y: 0, z: 0.2 } // walking sideways
  const lead = C.aim(from, target, vel, true)
  const plain = C.aim(from, target, vel, false)
  // Where will it be when the arrow arrives? The leading shot is aimed there.
  const future = new Vec3(target.x, target.y, target.z + vel.z * lead.ticks)
  assert.ok(closestApproach(from, lead.yaw, lead.pitch, future) < 0.4)
  assert.ok(closestApproach(from, plain.yaw, plain.pitch, future) > 0.6)
})

test('threats: creepers up close and skeletons come first for a trained fighter', () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) } }
  const mob = (id, name, x) => ({ id, name, type: 'hostile', position: new Vec3(x, 64, 0) })
  const zombie = mob(1, 'zombie', 2)
  const creeper = mob(2, 'creeper', 4)
  const skeleton = mob(3, 'skeleton', 10)
  const trained = SKILLS.combat.tiers[1].params
  const beginner = SKILLS.combat.tiers[0].params
  assert.strictEqual(C.pickTarget(bot, [zombie, creeper, skeleton], trained), creeper)
  assert.strictEqual(C.pickTarget(bot, [zombie, skeleton], trained), skeleton)
  assert.strictEqual(C.pickTarget(bot, [skeleton, zombie, creeper], beginner), zombie) // nearest
  // Whatever is hitting us right now gets a bonus.
  const spider = mob(4, 'spider', 3)
  assert.strictEqual(C.pickTarget(bot, [zombie, spider], trained, { attacker: zombie }), zombie)
})

test('swing timing follows the weapon', () => {
  assert.strictEqual(C.attackCooldownMs({ name: 'iron_sword' }), 625)
  assert.strictEqual(C.attackCooldownMs({ name: 'stone_axe' }), 1250)
  assert.strictEqual(C.attackCooldownMs(null), 250)
})

test('combat tiers: the old "future" features are now real tiers', () => {
  const t = SKILLS.combat.tiers.map(x => x.params)
  assert.strictEqual(t.length, 5)
  assert.ok(!t[0].timedSwings && !t[0].prioritize && !t[0].bow && !t[0].crits)
  assert.ok(t[1].timedSwings && t[1].prioritize && t[1].eatAt > 0)
  assert.ok(t[2].bow && t[2].strafe === 'steady' && t[2].useShield)
  assert.ok(t[3].crits > 0 && t[3].bowLead && t[3].bowRange > t[2].bowRange)
  assert.ok(t[4].crits > t[3].crits && t[4].strafe === 'random')
  assert.ok(!SKILLS.combat.tiers.some(x => /future/.test(x.next)))
})
