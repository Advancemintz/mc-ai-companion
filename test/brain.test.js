'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Brain } = require('../src/brain/brain')
const { Executor } = require('../src/body/executor')
const { fakeBot, scriptedLLM, until, wait } = require('./helpers')

const config = {
  bot: { personality: 'test', respondTo: 'all', autonomous: false, idleThinkSeconds: 90, maxChainedSteps: 3, showThoughts: false },
  llm: { maxHistory: 6 }
}

function setup (replies, cfg = config) {
  const bot = fakeBot()
  const ran = []
  const actions = {
    stop: { description: 'stop', params: {}, run: async () => 'stopped' },
    collect_block: { description: 'mine', params: { block: 'b', count: 'n' }, run: async (ctx, a) => { ran.push(a); return `collected ${a.count} ${a.block}` } },
    craft: { description: 'craft', params: { item: 'i' }, run: async (ctx, a) => { ran.push(a); return `crafted ${a.item}` } },
    go_to_player: { description: 'go', params: { player: 'p' }, run: async (ctx, a) => { ran.push(a); return 'reached' } }
  }
  const executor = new Executor(bot, actions)
  const llm = scriptedLLM(replies)
  const brain = new Brain({ bot, llm, executor, actions, config: cfg })
  return { bot, brain, llm, executor, ran }
}

test('chat -> LLM -> say + plan -> results fed back -> follow-up', async () => {
  const { bot, brain, llm, ran } = setup([
    { thought: 'get wood', say: 'Sure, grabbing wood!', actions: [{ name: 'collect_block', args: { block: 'oak_log', count: 3 } }] },
    { say: '', actions: [{ name: 'craft', args: { item: 'oak_planks' } }] },
    { say: 'Done, got planks.', actions: [] }
  ])
  brain.onPlayerChat('Steve', 'can you get me some wood?')
  await until(() => llm.calls.length === 3)
  await wait(20)
  assert.deepStrictEqual(ran, [{ block: 'oak_log', count: 3 }, { item: 'oak_planks' }])
  assert.deepStrictEqual(bot.said, ['Sure, grabbing wood!', 'Done, got planks.'])

  const first = llm.calls[0]
  assert.match(first.system, /collect_block\(block: b; count: n\)/)
  assert.match(first.system, /Nobody owns you/)
  const lastMsg = first.messages[first.messages.length - 1].content
  assert.match(lastMsg, /Steve says: "can you get me some wood\?"/)
  assert.match(lastMsg, /STATE:\nPosition: 0 64 0/)
  assert.match(llm.calls[1].messages.at(-1).content, /\[done\] collect_block: collected 3 oak_log/)
  // Older turns keep only the events (not the big state block) to save tokens.
  assert.doesNotMatch(llm.calls[2].messages[0].content, /STATE:/)
})

test('chat-only reply keeps the current activity', async () => {
  const { brain, llm, executor } = setup([{ say: 'Doing great!', actions: [] }])
  executor.actions.forever = { persistent: true, run: async (ctx) => { for (;;) await ctx.sleep(20) } }
  executor.setPlan([{ name: 'forever', args: {} }])
  await until(() => executor.isBusyWith('forever'))
  brain.onPlayerChat('Steve', 'how are you?')
  await until(() => llm.calls.length === 1)
  await wait(50)
  assert.ok(executor.isBusyWith('forever'))
  executor.cancelAll()
})

test('self-triggered re-planning is capped by maxChainedSteps', async () => {
  const loop = () => ({ say: '', actions: [{ name: 'craft', args: { item: 'stick' } }] })
  const { brain, llm } = setup([loop(), loop(), loop(), loop(), loop(), loop(), loop()])
  brain.onPlayerChat('Steve', 'keep crafting forever')
  await until(() => llm.calls.length >= 4)
  await wait(600)
  assert.strictEqual(llm.calls.length, 4) // 1 from chat + 3 chained
})

test('quick commands skip the LLM', async () => {
  const { bot, brain, llm, ran } = setup([])
  brain.onPlayerChat('Alex', '!come')
  await until(() => ran.length === 1)
  assert.deepStrictEqual(ran[0], { player: 'Alex' })
  assert.deepStrictEqual(bot.said, ['On my way.'])
  await wait(300)
  // plan finishing wakes the brain once; the scripted LLM returns an empty reply
  assert.ok(llm.calls.length <= 1)
})

test('respondTo=mention only answers messages with the bot name', async () => {
  const cfg = { ...config, bot: { ...config.bot, respondTo: 'mention' } }
  const { brain, llm } = setup([{ say: 'hi', actions: [] }], cfg)
  brain.onPlayerChat('Random', 'nice weather')
  await wait(500)
  assert.strictEqual(llm.calls.length, 0)
  brain.onPlayerChat('Random', 'hey buddy, come here')
  await until(() => llm.calls.length === 1)
})

test('LLM errors are reported once and the chat is retried later', async () => {
  const { bot, brain, llm } = setup([new Error('connection refused'), { say: 'back!', actions: [] }])
  brain.onPlayerChat('Steve', 'hello?')
  await until(() => bot.said.length === 1)
  assert.match(bot.said[0], /can't reach my AI brain/)
  brain.onPlayerChat('Steve', 'hello again')
  await until(() => llm.calls.length === 2)
  const last = llm.calls[1].messages.at(-1).content
  assert.match(last, /hello\?/)
  assert.match(last, /hello again/)
})

test('chat output is sanitized and split', async () => {
  const { bot, brain } = setup([])
  brain.say('/op Steve\nplease')
  brain.say('word '.repeat(80))
  await wait(900)
  assert.strictEqual(bot.said[0], 'op Steve please')
  assert.ok(bot.said.slice(1).every(m => m.length <= 240))
  assert.ok(bot.said.length >= 3)
})

test('invalid action names trigger a correction turn', async () => {
  const { brain, llm } = setup([
    { say: '', actions: [{ name: 'teleport', args: {} }] },
    { say: 'oops', actions: [] }
  ])
  brain.onPlayerChat('Steve', 'come here')
  await until(() => llm.calls.length === 2)
  assert.match(llm.calls[1].messages.at(-1).content, /Invalid plan: unknown action "teleport"/)
})

// ---------------------------------------------------------------- initiative
const { Memory } = require('../src/brain/memory')
const { startSenses } = require('../src/brain/senses')

function setupWithMemory (replies, botCfg = {}) {
  const cfg = { ...config, bot: { ...config.bot, ...botCfg } }
  const bot = fakeBot()
  const memory = new Memory(null)
  const actions = {
    stop: { description: 'stop', params: {}, run: async () => 'stopped' },
    set_goal: { description: 'goal', params: { goal: 'g' }, instant: true, run: async (ctx, a) => `goal #${ctx.memory.addGoal(a.goal).id} set` },
    craft: { description: 'craft', params: { item: 'i' }, run: async (ctx, a) => `crafted ${a.item}` }
  }
  const executor = new Executor(bot, actions, { memory })
  const llm = scriptedLLM(replies)
  const brain = new Brain({ bot, llm, executor, actions, config: cfg, memory })
  return { bot, brain, llm, executor, memory }
}

test('autonomous bot thinks for itself when idle, and state shows needs, home and goals', async () => {
  const { llm } = setupWithMemory([{ say: '', actions: [] }], { autonomous: true, idleThinkSeconds: 0.2 })
  await until(() => llm.calls.length === 1, 3000)
  const msg = llm.calls[0].messages.at(-1).content
  assert.match(msg, /\[idle\] Nobody needs you/)
  assert.match(msg, /Needs: /)
  assert.match(msg, /Home: none yet/)
  assert.match(msg, /Your goals: none/)
  assert.match(msg, /Surroundings: outdoors under open sky/)
  assert.match(llm.calls[0].system, /fellow player with your own life/)
})

test('non-autonomous bot stays quiet when idle', async () => {
  const { llm } = setupWithMemory([], { autonomous: false, idleThinkSeconds: 0.2 })
  await wait(600)
  assert.strictEqual(llm.calls.length, 0)
})

test('memory-only plans do not trigger another LLM call; goals show up next turn', async () => {
  const { brain, llm, memory } = setupWithMemory([
    { say: 'I want a home!', actions: [{ name: 'set_goal', args: { goal: 'build a cozy home' } }] },
    { say: '', actions: [] }
  ], { autonomous: false })
  brain.onPlayerChat('Steve', 'what do you want to do?')
  await until(() => memory.activeGoals().length === 1)
  await wait(300)
  assert.strictEqual(llm.calls.length, 1)
  brain.onPlayerChat('Steve', 'cool')
  await until(() => llm.calls.length === 2)
  const msg = llm.calls[1].messages.at(-1).content
  assert.match(msg, /\[done\] set_goal: goal #1 set/)
  assert.match(msg, /Your goals: #1 build a cozy home/)
})

test('senses: a player joining wakes the brain; sunset is noticed', async () => {
  const bot = fakeBot()
  const events = []
  const brain = { notify: (text, wake) => events.push({ text, wake }) }
  bot.time.timeOfDay = 11000
  startSenses(bot, brain, { bot: { autonomous: true } })
  bot.emit('playerJoined', { username: 'Alex' })
  assert.deepStrictEqual(events[0], { text: '[notice] Alex joined the game', wake: true })
  bot.time.timeOfDay = 11600
  await wait(2200)
  assert.ok(events.some(e => /sun is starting to set/.test(e.text)), JSON.stringify(events))
  bot.emit('end')
})

// ---------------------------------------------------------------- operators
const { AdminControl, parseSayCommand } = require('../src/brain/admin')

function setupAdmin (botCfg = {}) {
  const cfg = { ...config, bot: { ...config.bot, admins: ['Mod'], ...botCfg } }
  const bot = fakeBot()
  const memory = new Memory(null)
  const admin = new AdminControl(cfg, memory)
  const actions = {
    stop: { description: 'stop', params: {}, run: async () => 'stopped' },
    forever: { persistent: true, description: 'x', params: {}, run: async (ctx) => { for (;;) await ctx.sleep(20) } }
  }
  const executor = new Executor(bot, actions, { memory })
  const llm = scriptedLLM([{ say: 'ok', actions: [] }, { say: 'ok', actions: [] }, { say: 'ok', actions: [] }])
  const brain = new Brain({ bot, llm, executor, actions, config: cfg, memory, admin })
  return { bot, brain, llm, executor, memory, admin }
}

test('control commands are operator-only; /say proves operator status', async () => {
  const { bot, brain, executor, admin } = setupAdmin()
  executor.setPlan([{ name: 'forever', args: {} }])
  await until(() => executor.isBusyWith('forever'))
  brain.onPlayerChat('Griefer', '!stop')
  assert.ok(executor.isBusyWith('forever'))
  assert.match(bot.said.at(-1), /Only server operators can use !stop/)
  brain.onPlayerChat('Griefer', '!status') // public
  assert.match(bot.said.at(-1), /^Health 20\/20/)
  brain.onPlayerChat('Alex', '!stop', { viaSay: true })
  await until(() => executor.isIdle())
  assert.ok(admin.isAdmin('alex'), 'remembered as operator')
  assert.ok(admin.isAdmin('MOD'), 'config admins work')
  assert.ok(!admin.isAdmin('Griefer'))
})

test('!wipe needs confirm and keeps operators; !pause silences the brain', async () => {
  const { brain, memory, llm, bot } = setupAdmin()
  memory.addGoal('get rich'); memory.notePlayer('Steve', 'stole my iron')
  memory.data.operators.push('alex')
  brain.onPlayerChat('Mod', '!wipe')
  assert.strictEqual(memory.activeGoals().length, 1)
  brain.onPlayerChat('Mod', '!wipe confirm')
  assert.strictEqual(memory.activeGoals().length, 0)
  assert.deepStrictEqual(memory.data.players, {})
  assert.deepStrictEqual(memory.data.operators, ['alex'])
  brain.onPlayerChat('Mod', '!pause')
  brain.onPlayerChat('Steve', 'hello?')
  await wait(500)
  assert.strictEqual(llm.calls.length, 0)
  brain.onPlayerChat('Mod', '!resume')
  brain.onPlayerChat('Steve', 'hello again')
  await until(() => llm.calls.length === 1)
  assert.match(bot.said.join('|'), /Paused/)
})

test('chat from other AI bots is rate-limited so bots cannot loop forever', async () => {
  const { brain, llm } = setupAdmin({ otherBots: ['mike'], botChatCooldownSeconds: 30 })
  brain.onPlayerChat('mike', 'hey you')
  await until(() => llm.calls.length === 1)
  brain.onPlayerChat('mike', 'answer me')
  brain.onPlayerChat('mike', 'hello??')
  await wait(800)
  assert.strictEqual(llm.calls.length, 1)
  assert.match(llm.calls[0].messages.at(-1).content, /\(bot\) mike says: "hey you"/)
})

test('parseSayCommand recognizes vanilla /say messages only', () => {
  const say = { translate: '[%s] %s', with: [{ toString: () => 'Alex' }, { toString: () => '!stop' }] }
  assert.deepStrictEqual(parseSayCommand(say), { sender: 'Alex', text: '!stop' })
  const chat = { translate: '<%s> %s', with: [{ toString: () => 'Bob' }, { toString: () => '[Alex] !stop' }] }
  assert.strictEqual(parseSayCommand(chat), null)
  assert.strictEqual(parseSayCommand({ text: '[Alex] !stop' }), null)
})

// ---------------------------------------------------------------- staying busy
test('plans ahead during the last step so the next one starts without a pause', async () => {
  const bot = fakeBot()
  const ran = []
  const actions = {
    stop: { description: 's', params: {}, run: async () => 'stopped' },
    chop: { description: 'c', params: {}, run: async (ctx) => { ran.push('chop'); await ctx.sleep(2500); return 'chopped' } },
    craft: { description: 'c', params: {}, run: async () => { ran.push('craft'); return 'crafted' } }
  }
  const executor = new Executor(bot, actions)
  const llm = scriptedLLM([
    { say: '', actions: [{ name: 'chop', args: {} }] },
    { say: '', actions: [{ name: 'craft', args: {} }] }, // the plan-ahead answer
    { say: 'all done', actions: [] }
  ])
  const cfg = { ...config, bot: { ...config.bot, autonomous: true, idleThinkSeconds: 600, planAhead: true, maxChainedSteps: 10 } }
  const brain = new Brain({ bot, llm, executor, actions, config: cfg })
  brain.onPlayerChat('Steve', 'make me something')
  await until(() => ran.includes('craft'), 8000)
  assert.match(llm.calls[1].messages.at(-1).content, /\[planning ahead\]/)
  assert.deepStrictEqual(ran, ['chop', 'craft'])
  // The craft was queued after the chop (no replacement), and both results come back together.
  await until(() => llm.calls.length === 3, 5000)
  assert.match(llm.calls[2].messages.at(-1).content, /chop: chopped; craft: crafted/)
})

test('autopilot takes over when the model keeps choosing to do nothing', async () => {
  const bot = fakeBot()
  const ran = []
  const actions = {
    stop: { description: 's', params: {}, run: async () => 'stopped' },
    go_to: { description: 'g', params: {}, run: async (ctx, a) => { ran.push(a); return 'arrived' } }
  }
  const executor = new Executor(bot, actions)
  const llm = scriptedLLM(Array.from({ length: 10 }, () => ({ say: '', actions: [] })))
  const cfg = { ...config, bot: { ...config.bot, autonomous: true, idleThinkSeconds: 0.2, autopilot: true } }
  const brain = new Brain({ bot, llm, executor, actions, config: cfg, memory: new Memory(null) })
  await until(() => ran.length === 1, 6000)
  assert.ok(Number.isFinite(ran[0].x) && Number.isFinite(ran[0].z))
  assert.ok(llm.calls.length >= 2)
  brain.config.bot.autonomous = false
})

test('skills show up in the state and operators can change them with !skill', async () => {
  const { SkillBook } = require('../src/skills/skillbook')
  const { AdminControl } = require('../src/brain/admin')
  const bot = fakeBot()
  const memory = new Memory(null)
  const skills = new SkillBook(memory, { bot: { skills: {} } })
  const cfgA = { ...config, bot: { ...config.bot, admins: ['Mod'] } }
  const executor = new Executor(bot, { stop: { description: 's', params: {}, run: async () => 'stopped' } }, { memory })
  skills.attach(executor)
  const llm = scriptedLLM([{ say: '', actions: [] }])
  const brain = new Brain({ bot, llm, executor, actions: executor.actions, config: cfgA, memory, admin: new AdminControl(cfgA, memory), skills })
  brain.onPlayerChat('Steve', '!skills')
  assert.match(bot.said.at(-1), /Skills: Building 1 \(Dirt-hut novice\)/)
  brain.onPlayerChat('Steve', '!skill building tier 3')
  assert.match(bot.said.at(-1), /Only server operators/)
  brain.onPlayerChat('Mod', '!skill building tier 3')
  assert.strictEqual(skills.tier('building'), 3)
  brain.onPlayerChat('Mod', '!skill all cap 2')
  assert.strictEqual(skills.tier('building'), 2)
  brain.onPlayerChat('Steve', 'how good are you at building?')
  await until(() => llm.calls.length === 1)
  assert.match(llm.calls[0].messages.at(-1).content, /Your skills:\n- Building tier 2\/4 "Cabin builder"/)
  assert.match(llm.calls[0].system, /You get better by doing/)
})

test('social: feelings and rules reach the model, operators control it all with ! commands', async () => {
  const { Social } = require('../src/brain/social')
  const { AdminControl } = require('../src/brain/admin')
  const sn = require('../src/body/sneaky')
  const bot = fakeBot()
  const memory = new Memory(null)
  const cfgA = { ...config, bot: { ...config.bot, admins: ['Mod'] }, social: {} }
  const social = new Social(memory, cfgA, { botName: bot.username })
  const actions = { stop: { description: 's', params: {}, run: async () => 'stopped' }, steal: sn.stealAction, sabotage: sn.sabotageAction, adjust_feelings: sn.adjustFeelingsAction }
  const executor = new Executor(bot, actions, { memory, social })
  const llm = scriptedLLM([{ say: '', actions: [] }, { say: '', actions: [] }])
  const brain = new Brain({ bot, llm, executor, actions, config: cfgA, memory, admin: new AdminControl(cfgA, memory), social })
  assert.match(brain.system, /- steal\(/)
  assert.match(brain.system, /Stealing is possible but it's a big step/)

  brain.onPlayerChat('Steve', '!feel slip -90')
  assert.match(bot.said.at(-1), /Only server operators/)
  brain.onPlayerChat('Mod', '!feel slip -90')
  assert.match(bot.said.at(-1), /I now feel -90 \(deep hatred\) about slip/)
  brain.onPlayerChat('Mod', '!protect slip')
  assert.strictEqual(social.feeling('slip'), -50)
  assert.match(bot.said.at(-1), /slip is protected/)
  brain.onPlayerChat('Mod', '!feelings')
  assert.match(bot.said.at(-1), /Feelings: slip -50 \(hate, protected\)/)
  brain.onPlayerChat('Mod', '!social stealing off')
  assert.match(bot.said.at(-1), /stealing off/)
  assert.doesNotMatch(brain.system, /- steal\(/) // the model isn't even told about it
  assert.doesNotMatch(brain.system, /Stealing is possible/)
  assert.match(brain.system, /- sabotage\(/)
  brain.onPlayerChat('Mod', '!social all off')
  assert.doesNotMatch(brain.system, /- (sabotage|adjust_feelings)\(/)
  brain.onPlayerChat('Mod', '!social all on')
  brain.onPlayerChat('Mod', '!social stealing on')
  assert.match(brain.system, /- steal\(/)
  brain.onPlayerChat('Mod', '!suspects')
  assert.match(bot.said.at(-1), /Nothing has gone missing/)
  brain.onPlayerChat('Mod', '!confess')
  assert.match(bot.said.at(-1), /I haven't done anything/)
  brain.onPlayerChat('Mod', '!forget slip')
  assert.strictEqual(social.feeling('slip'), 0)

  social.adjust('boot', -30, 'stole my wheat')
  bot.players.boot = { username: 'boot', entity: { type: 'player', username: 'boot', position: bot.entity.position.offset(3, 0, 0) } }
  brain.onPlayerChat('boot', 'hey')
  await until(() => llm.calls.length === 1)
  const state = llm.calls[0].messages.at(-1).content
  assert.match(state, /How you feel about people: boot -30 \(dislike\) \[stole my wheat\]/)
  assert.match(state, /Social rules: stealing allowed from people at -20 or worse/)
})
