'use strict'

// Animal husbandry as logic: reading animals, what a ranch round should do, and which animals
// are off limits for hunting.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const HB = require('../src/body/husbandry')
const { SKILLS, ACTION_SKILLS } = require('../src/skills/registry')
const { fakeBot } = require('./helpers')

const M = HB.META
const animal = (name, meta = {}, pos = new Vec3(0, 64, 0), id = 1) => {
  const metadata = []
  for (const [k, v] of Object.entries(meta)) metadata[M[k] ?? Number(k)] = v
  return { id, name, type: 'animal', position: pos, metadata }
}

test('reading animals: babies, sheared sheep and their colour, pets and their owner, names', () => {
  assert.strictEqual(HB.animalState(animal('cow', { baby: true })).baby, true)
  assert.strictEqual(HB.animalState(animal('cow')).baby, false)
  const s = HB.animalState(animal('sheep', { sheep: 0x10 | 14 }))
  assert.deepStrictEqual([s.sheared, s.color], [true, 'red'])
  assert.strictEqual(HB.animalState(animal('sheep', { sheep: 0 })).sheared, false)
  const dog = HB.animalState(animal('wolf', { tameFlags: 0x04 | 0x01, owner: 'abc-123' }))
  assert.deepStrictEqual([dog.tamed, dog.sitting, dog.owner], [true, true, 'abc-123'])
  assert.strictEqual(HB.animalState(animal('cow', { name: '{"text":"Daisy"}' })).name, 'Daisy')
  assert.strictEqual(HB.chatText({ text: 'Bo', extra: [{ text: 'b' }] }), 'Bob')
  assert.deepStrictEqual(['cows', 'Sheep', 'chicks', 'dogs', 'kitten', 'wolves'].map(HB.kindOf), ['cow', 'sheep', 'chicken', 'wolf', 'cat', 'wolf'])
})

test('round plan: breed only with room, food and after the cooldown', () => {
  const base = { kind: 'cow', adults: 4, babies: 0, food: 10, minutesSinceBred: 30, params: { cap: 8 } }
  assert.strictEqual(HB.planRound(base).breedPairs, 2)
  assert.strictEqual(HB.planRound({ ...base, babies: 3 }).breedPairs, 1, 'only one more fits')
  assert.strictEqual(HB.planRound({ ...base, food: 3 }).breedPairs, 1, 'two food per pair')
  const soon = HB.planRound({ ...base, minutesSinceBred: 2 })
  assert.strictEqual(soon.breedPairs, 0)
  assert.match(soon.notes.join(), /need about 5 minutes/)
  assert.strictEqual(HB.planRound({ ...base, adults: 1 }).breedPairs, 0)
  assert.match(HB.planRound({ ...base, food: 0 }).notes.join(), /no food/)
})

test('round plan: culling keeps the young and a breeding pair, and only for skilled farmers', () => {
  const crowded = { kind: 'pig', adults: 9, babies: 2, food: 10, params: { cap: 8, cull: true } }
  const p = HB.planRound(crowded)
  assert.strictEqual(p.cull, 3)
  assert.strictEqual(p.breedPairs, 0, 'no breeding while thinning the herd')
  assert.strictEqual(HB.planRound({ ...crowded, adults: 3, babies: 7 }).cull, 1, 'never below two adults')
  assert.strictEqual(HB.planRound({ ...crowded, adults: 2, babies: 8 }).cull, 0)
  const novice = HB.planRound({ ...crowded, params: { cap: 8, cull: false } })
  assert.strictEqual(novice.cull, 0)
  assert.match(novice.notes.join(), /crowded \(11\/8\)/)
  assert.strictEqual(HB.planRound({ kind: 'cow', adults: 6, babies: 0, params: { cap: 8, cull: true }, wantMeat: true }).cull, 1, 'hungry: one for the pot')
  assert.strictEqual(HB.planRound({ kind: 'cow', adults: 4, babies: 0, params: { cap: 8, cull: true }, wantMeat: true }).cull, 0, 'but not from a small herd')
})

test('round plan: shearing, milking, eggs', () => {
  const sheep = HB.planRound({ kind: 'sheep', adults: 4, babies: 0, unsheared: 3, shears: true, minutesSinceBred: 1 })
  assert.strictEqual(sheep.shear, 3)
  assert.match(HB.planRound({ kind: 'sheep', adults: 4, babies: 0, unsheared: 3, shears: false }).notes.join(), /no shears/)
  assert.strictEqual(HB.planRound({ kind: 'cow', adults: 2, babies: 0, buckets: 1 }).milk, true)
  assert.strictEqual(HB.planRound({ kind: 'cow', adults: 2, babies: 0, buckets: 1, hasMilk: true }).milk, false)
  const hens = HB.planRound({ kind: 'chicken', adults: 3, babies: 0, eggs: 12, params: { cap: 8, eggThrow: true } })
  assert.strictEqual(hens.collect, true)
  assert.strictEqual(hens.throwEggs, 8)
  assert.strictEqual(HB.planRound({ kind: 'chicken', adults: 3, babies: 0, eggs: 12 }).throwEggs, 0, 'only skilled farmers throw eggs')
})

test('hunting: your pen, pets and named animals are off limits; wild ones are fair game', () => {
  const bot = fakeBot()
  bot.player = { uuid: 'me' }
  const memory = { data: { projects: { pen_cow: { style: 'pen', kind: 'cow', corner: { x: 10, y: 63, z: 10 } } } } }
  const ctx = { bot, memory }
  assert.match(HB.protectedReason(ctx, animal('cow', {}, new Vec3(13.5, 64, 13.5))), /in your pen/)
  assert.strictEqual(HB.protectedReason(ctx, animal('cow', {}, new Vec3(30, 64, 30))), null)
  assert.strictEqual(HB.protectedReason(ctx, animal('cow', {}, new Vec3(13.5, 64, 13.5)), { ignorePens: true }), null)
  assert.match(HB.protectedReason(ctx, animal('wolf', { tameFlags: 4, owner: 'me' })), /your pet/)
  assert.match(HB.protectedReason(ctx, animal('cat', { tameFlags: 4, owner: 'other' })), /someone's pet/)
  assert.match(HB.protectedReason(ctx, animal('pig', { name: 'Wilbur' })), /named "Wilbur"/)
  assert.ok(HB.isMyPet(bot, animal('wolf', { tameFlags: 4, owner: 'ME' })))
  assert.match(HB.animalTag(bot, animal('cow', { baby: true }, new Vec3(13.5, 64, 13.5)), memory), /baby, in your pen/)
})

test('skills: rancher tends pens, agronomist manages the herd', () => {
  const t = SKILLS.farming.tiers
  assert.deepStrictEqual(ACTION_SKILLS.tend_animals, { skill: 'farming', minTier: 3 })
  assert.ok(t[2].params.breed && !t[2].params.cull && !t[2].params.leads)
  assert.ok(t[3].params.cull && t[3].params.leads && t[3].params.eggThrow)
  const ctx = { skills: { params: () => t[2].params }, config: { ranch: { herdSize: 6 } } }
  assert.deepStrictEqual(HB.ranchParams(ctx), { breed: true, cull: false, cap: 6, keepAdults: 2, shear: true, milk: true, eggThrow: false, leads: false })
  const pro = { skills: { params: () => t[3].params }, config: { ranch: { cull: false } } }
  assert.strictEqual(HB.ranchParams(pro).cull, false, 'the operator can turn culling off')
  assert.strictEqual(HB.ranchParams({ skills: { params: () => t[3].params } }, { cull: 'no' }).cull, false)
})
