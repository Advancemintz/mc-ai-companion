'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const R = require('../src/body/railway')
const { Memory } = require('../src/brain/memory')

test('L-shaped route covers every column once and turns once', () => {
  const cols = R.lRoute(new Vec3(0, 64, 0), new Vec3(5, 64, -3))
  assert.strictEqual(cols.length, 5 + 3 + 1)
  assert.deepStrictEqual([cols[0].x, cols[0].z], [0, 0])
  assert.deepStrictEqual([cols.at(-1).x, cols.at(-1).z], [5, -3])
  for (let i = 1; i < cols.length; i++) assert.strictEqual(Math.abs(cols[i].x - cols[i - 1].x) + Math.abs(cols[i].z - cols[i - 1].z), 1)
})

test('stations sit outside protected bases', () => {
  const mem = new Memory(null)
  mem.addZone('home_base', new Vec3(0, 64, 0), 10)
  mem.addZone('steve', new Vec3(100, 64, 0), 8)
  const route = R.planRoute(mem, new Vec3(0, 64, 0), new Vec3(100, 64, 0))
  assert.ok(route.start.x > 10 && route.end.x < 92, `${route.start} -> ${route.end}`)
  assert.strictEqual(route.blocked, 0)
})

test('material estimate scales with length', () => {
  const short = R.estimate(48)
  const long = R.estimate(240)
  assert.ok(long.rails > short.rails && long.powered > short.powered)
  assert.strictEqual(long.iron % 6, 0)
  assert.strictEqual(long.buttons, 2)
})
