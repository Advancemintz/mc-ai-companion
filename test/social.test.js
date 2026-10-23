'use strict'

// The social system as data: feelings, ownership, chest audits and suspects, loot choice,
// and the operator switches. No world needed.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { Social, chooseLoot, itemValue, levelOf } = require('../src/brain/social')
const { Memory } = require('../src/brain/memory')

function make (social = {}) {
  const memory = new Memory(null)
  const config = { social }
  return { memory, config, s: new Social(memory, config, { botName: 'Buddy' }) }
}

test('feelings: levels, events, clamping and your own name', () => {
  const { s } = make()
  assert.strictEqual(s.feeling('slip'), 0)
  assert.strictEqual(s.level('slip'), 'neutral')
  s.event('gift', 'mike')
  assert.strictEqual(s.feeling('mike'), 4)
  s.event('caughtStealing', 'slip')
  s.event('killedMe', 'slip')
  s.event('hit', 'slip')
  assert.strictEqual(s.feeling('slip'), -61)
  assert.strictEqual(s.level('slip'), 'hate')
  s.adjust('slip', -500)
  assert.strictEqual(s.feeling('slip'), -100)
  assert.strictEqual(s.level('slip'), 'deep hatred')
  assert.strictEqual(s.adjust('Buddy', -50), null) // never about yourself
  assert.deepStrictEqual([levelOf(-90), levelOf(-30), levelOf(0), levelOf(30), levelOf(60), levelOf(95)],
    ['deep hatred', 'dislike', 'neutral', 'like', 'friend', 'best friend'])
})

test('feelings: the model can nudge them, but only so far per hour', () => {
  const { s } = make()
  let r = s.adjust('boot', -40, 'insulted me', { source: 'model' })
  assert.strictEqual(r.score, -15) // one call moves at most 15
  s.adjust('boot', -15, 'again', { source: 'model' })
  r = s.adjust('boot', -15, 'and again', { source: 'model' })
  assert.strictEqual(r.score, -30) // the hourly budget (30) is used up
  r = s.adjust('boot', -10, 'more', { source: 'model' })
  assert.ok(r.capped)
  assert.strictEqual(s.feeling('boot'), -30)
  s.event('hit', 'boot') // real events still count
  assert.strictEqual(s.feeling('boot'), -36)
})

test('feelings drift back toward neutral over days', () => {
  const { s, memory } = make()
  s.setFeeling('em', -50)
  const k = Object.keys(memory.data.social.feelings)[0]
  memory.data.social.feelings[k].updatedAt = Date.now() - 5 * 24 * 3600 * 1000
  assert.strictEqual(s.feeling('em'), -40) // 2 points a day
})

test('protected players: never stolen from or sabotaged, and never at sabotage-level hatred', () => {
  const { s } = make({ protected: ['Steve'] })
  s.adjust('Steve', -100)
  assert.strictEqual(s.feeling('Steve'), -50)
  assert.match(s.canSteal('Steve').why, /protected/)
  assert.match(s.canSabotage('steve').why, /protected/)
  s.adjust('em', -100)
  s.protect('em')
  assert.strictEqual(s.feeling('em'), -50)
  assert.ok(!s.canSteal('em').ok)
  s.protect('em', false)
  s.adjust('em', -60)
  assert.ok(s.canSabotage('em').ok)
})

test('stealing and sabotage thresholds, cooldowns and operator switches', () => {
  const { s } = make()
  assert.match(s.canSteal('slip').why, /don't dislike slip enough/)
  s.adjust('slip', -25)
  assert.ok(s.canSteal('slip').ok)
  assert.match(s.canSabotage('slip').why, /only for deep hatred/)
  s.adjust('slip', -60)
  assert.ok(s.canSabotage('slip').ok)
  s.recordMyTheft('slip', { iron_ingot: 2 }, new Vec3(0, 64, 0))
  assert.match(s.canSteal('slip').why, /lie low/)
  s.setFeature('stealing', false)
  assert.match(s.canSteal('boot').why, /switched off/)
  assert.ok(s.canSabotage('slip').ok)
  s.setFeature('all', false)
  assert.ok(!s.canSabotage('slip').ok)
  assert.strictEqual(s.describe({}), '')
  s.setFeature('all', true)
  assert.throws(() => s.setFeature('arson', true), /unknown feature/)
  assert.match(s.status(), /stealing off/)
})

test('loot: a modest share of the most useful things, never emptying the chest', () => {
  const chest = { diamond: 8, iron_ingot: 20, bread: 12, cobblestone: 64, dirt: 30, torch: 16 }
  const loot = chooseLoot(chest, { maxShare: 0.25, maxItemTypes: 3 })
  assert.deepStrictEqual(Object.keys(loot), ['diamond', 'iron_ingot', 'bread'])
  assert.deepStrictEqual(loot, { diamond: 2, iron_ingot: 5, bread: 3 })
  const total = Object.values(chest).reduce((a, b) => a + b, 0)
  assert.ok(Object.values(loot).reduce((a, b) => a + b, 0) <= total * 0.25)
  // Small chests: never the last of anything; a lone treasure only if there's plenty else.
  assert.deepStrictEqual(chooseLoot({ diamond: 1, iron_ingot: 2 }), {})
  assert.deepStrictEqual(chooseLoot({ diamond: 1, cobblestone: 30 }), { diamond: 1 })
  assert.deepStrictEqual(chooseLoot({ cobblestone: 64, dirt: 64 }), {}) // junk isn't worth it
  assert.ok(itemValue('diamond_sword') > itemValue('iron_ingot'))
})

test('ownership: your bases, bases you were told about, and bases worked out by watching', () => {
  const { s, memory } = make()
  // A place with an owner.
  memory.setPlace('slip_base', new Vec3(100, 64, 100), 'overworld', '', 'slip')
  assert.strictEqual(s.ownerAt(new Vec3(105, 64, 96)).owner, 'slip')
  assert.strictEqual(s.ownerAt(new Vec3(130, 64, 100)), null)
  // Your own base zone.
  const zones = [{ name: 'home', kind: 'radius', center: new Vec3(0, 64, 0), radius: 7 }]
  assert.strictEqual(s.ownerAt(new Vec3(2, 64, 2), 'overworld', { zones }).how, 'mine')
  // Watching boot: hanging around twice and opening a chest -> it's boot's.
  const spot = new Vec3(-200, 70, 50)
  assert.strictEqual(s.observeHome('boot', spot, 'overworld', 1), null)
  assert.strictEqual(s.observeHome('boot', spot.offset(3, 0, 0), 'overworld', 1), null)
  const claim = s.observeHome('boot', spot.offset(1, 0, 2), 'overworld', 2, 'opened a chest there')
  assert.ok(claim && claim.owner === 'boot')
  assert.deepStrictEqual(s.ownerAt(spot.offset(-4, 0, 0)), { owner: 'boot', how: 'seen', name: 'boot_base' })
  assert.strictEqual(s.baseOf('boot').how, 'seen')
  assert.match(s.describe({}), /Bases you worked out: boot's around -200 70 50/)
  // Never learns a claim on top of a known base.
  assert.strictEqual(s.observeHome('em', new Vec3(101, 64, 101), 'overworld', 10), null)
})

test('theft detection: a chest comes up short and the suspects are ranked', () => {
  const { s } = make()
  const pos = new Vec3(5, 64, 5)
  assert.strictEqual(s.auditChest('5,64,5', pos, { iron_ingot: 10, bread: 4 }), null) // first look: just remember it
  const t0 = Date.now()
  s.recordSighting('boot', new Vec3(8, 64, 2), t0 + 1)
  s.recordSighting('em', new Vec3(60, 64, 60), t0 + 1) // far away: not a suspect
  s.recordChestOpen('5,64,5', pos, 'slip', t0 + 2)
  s.recordSighting('slip', new Vec3(6, 64, 5), t0 + 2)
  const theft = s.auditChest('5,64,5', pos, { iron_ingot: 6, bread: 4 })
  assert.deepStrictEqual(theft.missing, { iron_ingot: 4 })
  assert.deepStrictEqual(theft.suspects.map(x => x.name), ['slip', 'boot'])
  assert.match(theft.suspects[0].reasons[0], /seen opening it/)
  assert.strictEqual(s.feeling('slip'), -30) // caught, as good as
  assert.strictEqual(s.feeling('boot'), 0) // only the one seen opening it is blamed
  assert.match(s.describeTheft(theft), /missing 4 iron_ingot .*Suspects: slip \(seen opening it/)
  assert.match(s.describe({}), /THEFT: your chest at 5 64 5 is missing 4 iron_ingot/)
  // Next look, nothing else gone: no new theft.
  assert.strictEqual(s.auditChest('5,64,5', pos, { iron_ingot: 6, bread: 4 }), null)
})

test('theft detection: with nobody seen opening it, everyone around shares a little blame', () => {
  const { s } = make()
  const pos = new Vec3(0, 64, 0)
  s.auditChest('k', pos, { diamond: 5 })
  s.recordSighting('boot', new Vec3(3, 64, 3), Date.now() + 1)
  s.recordSighting('mike', new Vec3(-4, 64, 1), Date.now() + 1)
  const theft = s.auditChest('k', pos, { diamond: 3 })
  assert.strictEqual(theft.suspects.length, 2)
  assert.strictEqual(s.feeling('boot'), -6)
  assert.strictEqual(s.feeling('mike'), -6)
  s.setFeature('theftDetection', false)
  s.auditChest('k', pos, { diamond: 3 })
  assert.strictEqual(s.auditChest('k', pos, { diamond: 0 }), null)
})

test('memory survives: social data is saved with the memory file and wiped with it', () => {
  const { s, memory } = make()
  s.event('gift', 'mike')
  assert.ok(memory.data.social.feelings.mike)
  memory.wipe()
  assert.strictEqual(s.feeling('mike'), 0)
})
