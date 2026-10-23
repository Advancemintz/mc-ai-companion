'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Executor } = require('../src/body/executor')
const { fakeBot, until, wait } = require('./helpers')

function testActions (log) {
  return {
    stop: { run: async () => 'stopped' },
    quick: { run: async (ctx, a) => { log.push('quick:' + a.n); return 'ok ' + a.n } },
    slow: {
      run: async (ctx, a) => {
        const total = a.count
        for (let done = 0; done < total; done++) {
          await ctx.sleep(30)
          ctx.resumeArgs = { count: total - done - 1 }
          log.push('slow-step')
        }
        return `did ${total}`
      }
    },
    forever: { persistent: true, run: async (ctx) => { for (;;) await ctx.sleep(20) } },
    boom: { run: async () => { throw new Error('no path to the destination') } }
  }
}

test('runs a plan in order and reports results', async () => {
  const log = []
  const ex = new Executor(fakeBot(), testActions(log))
  let finished = null
  ex.on('planFinished', (e) => { finished = e })
  ex.setPlan([{ name: 'quick', args: { n: 1 } }, { name: 'quick', args: { n: 2 } }])
  await until(() => finished)
  assert.deepStrictEqual(log, ['quick:1', 'quick:2'])
  assert.deepStrictEqual(finished.results, ['quick: ok 1', 'quick: ok 2'])
  assert.ok(ex.isIdle())
})

test('unknown actions are reported and skipped', () => {
  const ex = new Executor(fakeBot(), testActions([]))
  const problems = ex.setPlan([{ name: 'fly', args: {} }])
  assert.deepStrictEqual(problems, ['unknown action "fly"'])
})

test('a new plan replaces a running persistent action', async () => {
  const log = []
  const ex = new Executor(fakeBot(), testActions(log))
  ex.setPlan([{ name: 'forever', args: {} }])
  await until(() => ex.isBusyWith('forever'))
  ex.setPlan([{ name: 'quick', args: { n: 7 } }])
  await until(() => log.includes('quick:7'))
  await until(() => ex.isIdle())
})

test('failure clears the rest of the plan and emits actionFailed', async () => {
  const ex = new Executor(fakeBot(), testActions([]))
  let failed = null
  ex.on('actionFailed', (e) => { failed = e })
  ex.setPlan([{ name: 'quick', args: { n: 1 } }, { name: 'boom', args: {} }, { name: 'quick', args: { n: 2 } }])
  await until(() => failed)
  assert.strictEqual(failed.name, 'boom')
  assert.deepStrictEqual(failed.skipped, ['quick'])
  assert.match(failed.results.join('|'), /quick: ok 1\|boom FAILED: no path/)
  assert.ok(ex.isIdle())
})

test('stop cancels everything', async () => {
  const ex = new Executor(fakeBot(), testActions([]))
  ex.setPlan([{ name: 'forever', args: {} }, { name: 'quick', args: { n: 1 } }])
  await until(() => ex.isBusyWith('forever'))
  ex.setPlan([{ name: 'stop', args: {} }])
  await until(() => ex.isIdle())
})

test('a reflex interrupts and the action resumes with its remaining work', async () => {
  const log = []
  const ex = new Executor(fakeBot(), testActions(log))
  let finished = null
  ex.on('planFinished', (e) => { finished = e })
  ex.setPlan([{ name: 'slow', args: { count: 6 } }])
  await until(() => log.filter(x => x === 'slow-step').length >= 2)
  await ex.interrupt('eat', async () => { log.push('REFLEX'); await wait(20) })
  await until(() => finished)
  const steps = log.filter(x => x === 'slow-step').length
  assert.ok(log.includes('REFLEX'))
  assert.strictEqual(steps, 6, 'resumed with the remaining count instead of starting over')
  assert.match(finished.results[0], /^slow: did \d$/)
})

test('an action that makes no progress is failed by the watchdog', async () => {
  const bot = fakeBot()
  const acts = { hang: { run: async (ctx) => { for (;;) await ctx.sleep(100) } } }
  const ex = new Executor(bot, acts, { stuckSeconds: 1 })
  let failed = null
  ex.on('actionFailed', (e) => { failed = e })
  ex.setPlan([{ name: 'hang', args: {} }])
  await until(() => failed, 8000)
  assert.match(failed.error, /got stuck: no progress/)
  assert.ok(ex.isIdle())
})

test('actions that report progress are not considered stuck', async () => {
  const bot = fakeBot()
  const acts = { busy: { run: async (ctx) => { for (let i = 0; i < 12; i++) { ctx.setStatus(`step ${i}`); await ctx.sleep(300) } return 'done' } } }
  const ex = new Executor(bot, acts, { stuckSeconds: 1 })
  let finished = null
  ex.on('planFinished', (e) => { finished = e })
  ex.setPlan([{ name: 'busy', args: {} }])
  await until(() => finished, 8000)
  assert.deepStrictEqual(finished.results, ['busy: done'])
})
