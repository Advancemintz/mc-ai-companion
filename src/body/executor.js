'use strict'

// Runs the plan the brain chose, one action at a time, at full game speed.
// - New plans replace the old one (the brain decides when).
// - Reflexes can interrupt: the current action is paused, the reflex runs, and the
//   action resumes afterwards (with its remaining work, e.g. "3 more logs").
// - Every action gets a cancellation token so stop/replace is instant.

const { EventEmitter } = require('events')
const log = require('../util/log')

class CancelledError extends Error {
  constructor (reason = 'cancelled') {
    super(reason)
    this.name = 'CancelledError'
  }
}

class CancelToken {
  constructor () {
    this.cancelled = false
    this.reason = null
    this._listeners = new Set()
  }

  cancel (reason) {
    if (this.cancelled) return
    this.cancelled = true
    this.reason = reason
    for (const fn of this._listeners) {
      try { fn(reason) } catch {}
    }
    this._listeners.clear()
  }

  onCancel (fn) {
    if (this.cancelled) fn(this.reason)
    else this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  throwIfCancelled () {
    if (this.cancelled) throw new CancelledError(this.reason)
  }
}

function sleep (ms, token) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off?.(); resolve() }, ms)
    const off = token?.onCancel((reason) => { clearTimeout(t); reject(new CancelledError(reason)) })
  })
}

class Executor extends EventEmitter {
  constructor (bot, actions, { memory = null, stuckSeconds = 40, skills = null, social = null, config = null, team = null } = {}) {
    super()
    this.bot = bot
    this.skills = skills // the bot's skill book (tiers change how some actions behave)
    this.stuckMs = stuckSeconds * 1000
    this._activity = 0 // bumped by digging/placing, used by the stuck watchdog
    const bump = () => { this._activity++ }
    bot.on?.('diggingCompleted', bump)
    bot.on?.('blockPlaced', bump)
    bot.on?.('playerCollect', bump)
    this.actions = actions // map name -> definition
    this.team = team // teamwork with other bots (src/brain/team.js), handed to actions as ctx.team
    this.memory = memory // long-term memory, handed to actions as ctx.memory
    this.social = social // feelings, ownership, thefts (src/brain/social.js), handed to actions as ctx.social
    this.config = config // the live config, handed to actions as ctx.config
    this.queue = []
    this.current = null // { name, args, token, startedAt, ctx }
    this.running = false
    this.reflexActive = null // name of running reflex
    this._planResults = []
    this._planNames = []
    this.beforeStep = null // optional async (step, ctx, def) hooks
    this.afterStep = null
  }

  isIdle () {
    return !this.current && this.queue.length === 0
  }

  isBusyWith (name) {
    return this.current?.name === name
  }

  describe () {
    const parts = []
    if (this.reflexActive) parts.push(`(reflex: ${this.reflexActive})`)
    if (this.current) {
      const secs = Math.round((Date.now() - this.current.startedAt) / 1000)
      parts.push(`Current: ${this.current.name} ${JSON.stringify(this.current.args)} for ${secs}s`)
      if (this.current.ctx?.status) parts.push(`progress: ${this.current.ctx.status}`)
    } else {
      parts.push('Current: idle')
    }
    if (this.queue.length) {
      parts.push('Queued: ' + this.queue.map(a => `${a.name} ${JSON.stringify(a.args)}`).join(' -> '))
    }
    return parts.join('. ')
  }

  // Validate and start a new plan. Returns a list of problems (unknown actions etc.).
  setPlan (plan, { append = false } = {}) {
    if (this.dead) return ['the bot is disconnected']
    const problems = []
    const valid = []
    for (const step of plan) {
      const def = this.actions[step.name]
      if (!def) {
        problems.push(`unknown action "${step.name}"`)
        continue
      }
      valid.push({ name: step.name, args: step.args || {} })
    }

    const stopIndex = valid.findIndex(s => s.name === 'stop')
    if (stopIndex !== -1) {
      this.cancelAll('stopped')
      valid.splice(0, stopIndex + 1)
      append = true
    }

    if (!append) this.cancelAll('replaced by a new plan')
    this.queue.push(...valid)
    if (valid.length && !append) { this._planResults = []; this._planNames = [] }
    this._kick()
    return problems
  }

  // The connection ended: cancel everything and refuse new work (a new executor takes over).
  shutdown () {
    this.dead = true
    this.cancelAll('disconnected')
    this.removeAllListeners()
  }

  cancelAll (reason = 'cancelled') {
    this.queue = []
    if (this.current) {
      this.current.cancelReason = reason
      this.current.token.cancel(reason)
    }
    // A running reflex (fleeing, fighting) keeps control of the body until it ends.
    if (!this.reflexActive) this._stopMotion()
  }

  _stopMotion () {
    const bot = this.bot
    try { bot.pathfinder?.stop() } catch {}
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { bot.pvp?.forceStop ? bot.pvp.forceStop() : bot.pvp?.stop() } catch {}
    try { bot.collectBlock?.cancelTask() } catch {}
    try { bot.stopDigging() } catch {}
    try { bot.clearControlStates() } catch {}
    try { bot.deactivateItem?.() } catch {} // lower a raised shield or a drawn bow
  }

  // Pause the current action, run fn (a reflex), then resume.
  async interrupt (name, fn) {
    if (this.reflexActive) return false
    this.reflexActive = name
    const paused = this.current
    if (paused) {
      paused.interrupted = true
      paused.token.cancel(`interrupted by ${name}`)
    }
    this._stopMotion()
    // Wait for the paused action to unwind before taking over the body.
    if (this._loopPromise) {
      await Promise.race([this._idlePromise(), sleep(3000)])
    }
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof CancelledError)) log.warn(`Reflex ${name} failed: ${err.message}`)
    } finally {
      this._stopMotion()
      this.reflexActive = null
      this._kick()
    }
    return true
  }

  // Fails the current action if nothing changes for a while: no movement, no digging or
  // placing, no new items, no status update. The brain then re-plans instead of waiting forever.
  _watch (ctx, current) {
    const bot = this.bot
    const snapshot = () => ({
      pos: bot.entity?.position?.clone?.() || null,
      status: ctx.status,
      activity: this._activity,
      inv: bot.inventory?.items?.().reduce((n, i) => n + i.count, 0) ?? 0
    })
    let last = snapshot()
    let lastChange = Date.now()
    return setInterval(() => {
      if (this.reflexActive) { lastChange = Date.now(); return }
      const now = snapshot()
      const moved = last.pos && now.pos && now.pos.distanceTo(last.pos) > 0.75
      if (moved || now.status !== last.status || now.activity !== last.activity || now.inv !== last.inv) {
        last = now
        lastChange = Date.now()
        return
      }
      if (Date.now() - lastChange > this.stuckMs && this.current === current && !current.stuck) {
        log.warn(`${current.name} looks stuck; giving up on it`)
        current.stuck = true
        current.token.cancel('stuck')
        this._stopMotion()
      }
    }, 2500)
  }

  _idlePromise () {
    return new Promise(resolve => {
      if (!this.current) return resolve()
      this.once('_actionEnded', resolve)
    })
  }

  _kick () {
    if (this.dead || this.running || this.reflexActive) return
    if (!this.queue.length) return
    this.running = true
    this._loopPromise = this._loop().finally(() => {
      this.running = false
      this._loopPromise = null
      if (this.queue.length && !this.reflexActive) this._kick()
    })
  }

  async _loop () {
    while (this.queue.length && !this.reflexActive) {
      const step = this.queue.shift()
      const def = this.actions[step.name]
      const token = new CancelToken()
      const ctx = {
        bot: this.bot,
        memory: this.memory,
        skills: this.skills,
        social: this.social,
        team: this.team,
        config: this.config,
        token,
        status: '',
        resumeArgs: null, // actions set this so an interrupted step can continue where it left off
        sleep: (ms) => sleep(ms, token),
        check: () => token.throwIfCancelled(),
        race: (promise, timeoutMs) => raceCancel(promise, token, timeoutMs),
        setStatus: (s) => { ctx.status = s }
      }
      this.current = { name: step.name, args: step.args, token, startedAt: Date.now(), ctx }
      log.action(`${step.name} ${JSON.stringify(step.args)}`)
      this.emit('actionStarted', { name: step.name, args: step.args, remaining: this.queue.length, persistent: !!def.persistent, instant: !!def.instant })
      const watchdog = (def.persistent || def.noWatchdog || def.instant || !this.stuckMs) ? null : this._watch(ctx, this.current)

      let result = null
      let error = null
      let finished = false
      try {
        const timeoutMs = def.persistent ? 0 : (def.timeoutSeconds || 300) * 1000
        this.skills?.gate(step.name, step.args) // "I haven't learned that yet"
        // Mannerisms (src/body/mannerisms.js): a short pause before, a look at the result after.
        if (this.beforeStep) await raceCancel(Promise.resolve(this.beforeStep(step, ctx, def)), token, 5000).catch(err => { if (err instanceof CancelledError) throw err })
        result = await raceCancel(def.run(ctx, step.args), token, timeoutMs)
        finished = true
        // The job is done; a flourish afterwards can be cut short without undoing it.
        if (this.afterStep) {
          try { await raceCancel(Promise.resolve(this.afterStep(step, result, ctx, def)), token, 15000) } catch {}
        }
      } catch (err) {
        error = err
      } finally {
        if (watchdog) clearInterval(watchdog)
        token.cancel('finished') // release any listeners the action registered
      }

      const wasInterrupted = this.current.interrupted && !finished
      const wasStuck = this.current.stuck
      const cancelReason = finished ? null : this.current.cancelReason
      this.current = null
      this.emit('_actionEnded')

      if (wasInterrupted) {
        // Put it back at the front so it resumes after the reflex.
        this.queue.unshift({ name: step.name, args: ctx.resumeArgs || step.args })
        log.action(`${step.name} paused for reflex`)
        return
      }

      if (wasStuck) {
        error = new Error(`got stuck: no progress for ${Math.round(this.stuckMs / 1000)}s (blocked path, unreachable target, or waiting on something)`)
      }
      if (error) {
        if (!wasStuck && (error instanceof CancelledError || cancelReason)) {
          log.action(`${step.name} cancelled (${cancelReason || error.message})`)
          // A cancel always comes from setPlan/stop, which already decided what is next.
          continue
        }
        const msg = error.message || String(error)
        log.warn(`${step.name} failed: ${msg}`)
        this._stopMotion()
        const skipped = this.queue.map(s => s.name)
        this.queue = []
        this._planResults.push(`${step.name} FAILED: ${msg}`)
        this.emit('actionFailed', { name: step.name, args: step.args, error: msg, skipped, results: this._planResults })
        this._planResults = []
        this._planNames = []
        return
      }

      const text = typeof result === 'string' ? result : 'done'
      log.action(`${step.name} -> ${text}`)
      this._planResults.push(`${step.name}: ${text}`)
      this._planNames.push(step.name)
      this.emit('actionDone', { name: step.name, args: step.args, result: text })
    }

    if (!this.queue.length && this._planResults.length && !this.reflexActive) {
      const results = this._planResults
      const names = this._planNames
      this._planResults = []
      this._planNames = []
      const instantOnly = names.every(n => this.actions[n]?.instant)
      this.emit('planFinished', { results, names, instantOnly })
    }
  }
}

function raceCancel (promise, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null
    const off = token.onCancel((reason) => {
      if (timer) clearTimeout(timer)
      reject(new CancelledError(reason))
    })
    if (timeoutMs) {
      timer = setTimeout(() => {
        off()
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    }
    Promise.resolve(promise).then(
      (v) => { off(); if (timer) clearTimeout(timer); resolve(v) },
      (e) => { off(); if (timer) clearTimeout(timer); reject(e) }
    )
  })
}

module.exports = { Executor, CancelToken, CancelledError, sleep, raceCancel }
