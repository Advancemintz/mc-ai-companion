'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SkillBook } = require('../src/skills/skillbook')
const { Memory } = require('../src/brain/memory')
const { Executor } = require('../src/body/executor')
const { fakeBot, until } = require('./helpers')

const cfg = (skills = {}) => ({ bot: { skills } })

test('everyone starts as a beginner; advanced skills start locked', () => {
  const sb = new SkillBook(null, cfg())
  assert.strictEqual(sb.tier('building'), 1)
  assert.strictEqual(sb.tier('mining'), 1)
  assert.strictEqual(sb.tier('combat'), 1)
  assert.strictEqual(sb.tier('railways'), 0)
  assert.strictEqual(sb.tier('nether'), 0)
  assert.strictEqual(sb.info('building').name, 'Dirt-hut novice')
})

test('XP levels skills up; tier requirements and skill unlocks chain together', () => {
  const sb = new SkillBook(null, cfg())
  const ups = []
  sb.on('levelUp', (u) => ups.push(`${u.skill}:${u.tier}`))
  sb.award('building', 500) // enough XP for tier 3, but tier 3 needs mining tier 2
  assert.strictEqual(sb.tier('building'), 2)
  sb.award('mining', 60) // mining tier 2 -> building can now climb, railways unlock
  assert.strictEqual(sb.tier('mining'), 2)
  assert.strictEqual(sb.tier('building'), 3)
  assert.strictEqual(sb.tier('railways'), 1)
  assert.deepStrictEqual(ups.sort(), ['building:2', 'building:3', 'mining:2', 'railways:1'].sort())
})

test('affinity makes a bot learn some skills faster', () => {
  const builder = new SkillBook(null, cfg({ affinity: { building: 2, combat: 0.5 } }))
  builder.award('building', 50)
  builder.award('combat', 50)
  assert.strictEqual(builder.state('building').xp, 100)
  assert.strictEqual(builder.state('combat').xp, 25)
  assert.match(builder.describe(), /Building tier 2\/4 "Cabin builder" \(a natural talent\)/)
  assert.match(builder.describe(), /Combat tier 1\/5 "Panicky" \(not your strength\)/)
})

test('trying something too advanced gives a friendly, actionable error', () => {
  const sb = new SkillBook(null, cfg())
  assert.throws(() => sb.gate('build_base', {}), /haven't learned build base yet: it needs building tier 2 "Cabin builder", and I'm tier 1 "Dirt-hut novice". To improve: build huts and walls/)
  assert.throws(() => sb.gate('build_railway', {}), /not learned yet\. To improve: first get building tier 2 and mining tier 2/)
  assert.doesNotThrow(() => sb.gate('collect_block', { block: 'oak_log' })) // universal
  assert.doesNotThrow(() => sb.gate('collect_block', { block: 'iron_ore' })) // mining tier 1
  assert.doesNotThrow(() => sb.gate('follow_player', {}))
})

test('operators can fix, cap, lock and reset skills', () => {
  const sb = new SkillBook(null, cfg())
  sb.setFixed('building', 4)
  assert.strictEqual(sb.tier('building'), 4)
  sb.setCap('building', 2)
  assert.strictEqual(sb.tier('building'), 2)
  sb.setCap('building', null)
  sb.setFixed('building', null)
  assert.strictEqual(sb.tier('building'), 1)
  sb.setLocked('mining', true)
  sb.award('mining', 1000)
  assert.strictEqual(sb.tier('mining'), 1, 'locked skills do not gain XP')
  sb.setLocked('mining', false)
  sb.setXp('mining', 300)
  assert.strictEqual(sb.tier('mining'), 3)
  sb.reset()
  assert.strictEqual(sb.tier('mining'), 1)
  assert.strictEqual(sb.state('mining').xp, 0)
})

test('config can start a bot at higher tiers or keep it fixed', () => {
  const vet = new SkillBook(null, cfg({ startTiers: { building: 3, mining: 3 } }))
  assert.strictEqual(vet.tier('building'), 3)
  assert.strictEqual(vet.tier('railways'), 1, 'prerequisites met, so railways is unlocked')
  const fixed = new SkillBook(null, cfg({ mode: 'fixed', startTier: 2 }))
  fixed.award('building', 5000)
  assert.strictEqual(fixed.tier('building'), 2)
})

test('skills, lessons and counters are saved with memory and survive a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')), 'bot.json')
  const mem = new Memory(file)
  const sb = new SkillBook(mem, cfg())
  sb.award('building', 120)
  sb.addLesson('building', 'gather blocks before starting')
  mem.saveNow()
  const sb2 = new SkillBook(new Memory(file), cfg())
  assert.strictEqual(sb2.tier('building'), 2)
  assert.deepStrictEqual(sb2.state('building').lessons, ['gather blocks before starting'])
  assert.match(sb2.describe(), /lessons: gather blocks before starting/)
})

test('a memory wipe brings skills back to the start', () => {
  const mem = new Memory(null)
  const sb = new SkillBook(mem, cfg())
  sb.award('building', 150)
  mem.wipe()
  assert.strictEqual(sb.tier('building'), 1)
})

test('the executor refuses skill actions above the bot\'s tier and counts attempts', async () => {
  const bot = fakeBot()
  const sb = new SkillBook(null, cfg())
  const actions = {
    build_base: { run: async () => 'built' },
    build: { run: async () => 'hut done' }
  }
  const ex = new Executor(bot, actions, {})
  sb.attach(ex)
  let failed = null
  let finished = null
  ex.on('actionFailed', (e) => { failed = e })
  ex.on('planFinished', (e) => { finished = e })
  ex.setPlan([{ name: 'build_base', args: {} }])
  await until(() => failed)
  assert.match(failed.error, /haven't learned/)
  assert.strictEqual(sb.state('building').attempts, 0, 'not counted as a real attempt')
  ex.setPlan([{ name: 'build', args: { structure: 'hut' } }])
  await until(() => finished)
  assert.strictEqual(sb.state('building').successes, 1)
})

test('v0.8: farming starts at tier 1; the Nether unlocks after combat 3 and mining 3', () => {
  const sb = new SkillBook(null, cfg())
  assert.strictEqual(sb.tier('farming'), 1)
  assert.deepStrictEqual(sb.params('farming').crops, ['wheat'])
  assert.strictEqual(sb.tier('nether'), 0)
  sb.setFixed('combat', 3); sb.setFixed('mining', 3)
  const ups = sb.award('farming', 1) // any XP re-checks unlocks
  assert.ok(ups.some(u => u.skill === 'nether' && u.unlocked))
  assert.strictEqual(sb.tier('nether'), 1)
  assert.strictEqual(sb.params('nether').radius, 12)
})

test('v0.8: building tiers widen the designs and upgrades a bot knows', () => {
  const at = (t) => new SkillBook(null, cfg({ startTiers: { building: t, mining: 3 } })).params('building')
  assert.deepStrictEqual(at(1).variants, [])
  assert.deepStrictEqual(at(2).variants.sort(), ['cellar', 'cottage', 'hall', 'longhouse'])
  assert.deepStrictEqual(at(2).upgrades, ['storage_room'])
  assert.ok(at(3).upgrades.includes('bunker'))
  assert.deepStrictEqual(at(4).upgrades.sort(), ['bunker', 'enchanting_room', 'second_storey', 'storage_room'])
})

test('v0.8: needs suggest upgrading a finished base and tending the farm', () => {
  const { assessNeeds } = require('../src/brain/drives')
  const bot = fakeBot()
  bot.inventory.emptySlotCount = () => 30
  bot.registry.foodsByName = { bread: { foodPoints: 5 } }
  for (const name of ['iron_pickaxe', 'iron_sword', 'torch', 'diamond']) bot._items.push({ name, count: 1 })
  bot._items.push({ name: 'bread', count: 10 })
  bot.inventory.slots[5] = { name: 'iron_helmet' }
  const mem = new Memory(null)
  mem.setPlace('home', { x: 0, y: 64, z: -3 })
  const sb = new SkillBook(mem, cfg({ startTiers: { building: 3, mining: 2 } }))
  mem.saveProject('base', { style: 'surface', size: 'small', variant: 'cottage', upgrades: ['storage_room'], status: 'done', origin: { x: 0, y: 63, z: 0 }, f: { x: 0, z: -1 } })
  mem.saveProject('farm', { style: 'farm', center: { x: 5, y: 63, z: 5 }, radius: 2, lastRound: new Date(Date.now() - 3600000).toISOString() })
  const text = assessNeeds(bot, { memory: mem, skills: sb }).map(n => n.text).join(' | ')
  assert.match(text, /upgrade_base \(bunker\)/)
  assert.match(text, /tend it with farm/)
  assert.match(mem.summary({ pos: bot.entity.position, dimension: 'overworld' }), /Your base "base": small surface cottage .*upgrades: storage room/)
})
