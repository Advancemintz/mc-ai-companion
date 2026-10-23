'use strict'

// The "brain": wakes up on meaningful events, asks the LLM what to do, then
// hands the plan to the executor. It never blocks the body, which keeps
// moving and reacting while the model thinks.

const { parseResponse } = require('./parse')
const { buildSystemPrompt, buildTurn } = require('./prompt')
const perception = require('../body/perception')
const { assessNeeds, describeNeeds } = require('./drives')
const { chooseActivity } = require('./autopilot')
const log = require('../util/log')

class Brain {
  constructor ({ bot, llm, executor, actions, config, memory = null, admin = null, skills = null, social = null }) {
    this.bot = bot
    this.skills = skills || executor.skills || null
    this.social = social || executor.social || null
    this.memory = memory
    this.admin = admin
    this.paused = false
    this.onQuit = null // set by index.js
    this.lastBotChatWake = 0
    this.idleStreak = 0 // how many times in a row the model chose to do nothing while idle
    this.lookaheadFor = null // the action we already planned ahead for
    this.llm = llm
    this.executor = executor
    this.actions = actions
    this.config = config
    this.events = [] // { text, wake }
    this.history = []
    this.thinking = false
    this.timer = null
    this.chained = 0
    this.lastThinkAt = Date.now()
    this.lastErrorNotice = 0
    this.lastChatAt = Date.now()
    this.refreshSystemPrompt()
    this._wireExecutor()
    this._startIdleLoop()
  }

  // ---------------------------------------------------------------- inputs

  onPlayerChat (username, message, { whisper = false, fromConsole = false, viaSay = false } = {}) {
    if (!message || username === this.bot.username) return
    const text = String(message).trim()
    if (!text) return

    if (text.startsWith('!') && this._command(username, text, { fromConsole, viaSay })) return
    if (viaSay) return // /say announcements that aren't commands are just server noise
    if (this.paused) return

    if (!fromConsole && !whisper && this.config.bot.respondTo === 'mention' &&
      !text.toLowerCase().includes(this.bot.username.toLowerCase())) return

    const how = whisper ? 'whispers to you' : 'says'
    const line = `${username} ${how}: "${text.slice(0, 400)}"`
    if (this.isOtherBot(username)) {
      // Another AI bot: answer at most once per cooldown so two bots can't chat forever.
      const cooldown = (this.config.bot.botChatCooldownSeconds ?? 30) * 1000
      const wake = Date.now() - this.lastBotChatWake > cooldown
      if (wake) this.lastBotChatWake = Date.now()
      this.notify(`(bot) ${line}`, wake, 600)
      return
    }
    this.chained = 0
    this.idleStreak = 0
    this.lastChatAt = Date.now()
    this.notify(line, true, 350, 'chat')
    // Turn to face whoever is talking, if we're not busy.
    const speaker = this.bot.players?.[username]?.entity
    if (speaker && this.executor.isIdle() && typeof this.bot.lookAt === 'function') {
      Promise.resolve().then(() => this.bot.lookAt(speaker.position.offset(0, 1.6, 0))).catch(() => {})
    }
  }

  // Actions the model is told about: social actions the operators switched off are left out.
  visibleActions () {
    return Object.fromEntries(Object.entries(this.actions).filter(([, def]) => !def.enabled || def.enabled(this.config, this.social) !== false))
  }

  refreshSystemPrompt () {
    this.system = buildSystemPrompt({ config: this.config, botName: this.bot.username, version: this.bot.version, actions: this.visibleActions(), social: this.social })
  }

  isOtherBot (username) {
    const n = String(username).toLowerCase()
    return (this.config.bot.otherBots || []).some(b => String(b).toLowerCase() === n)
  }

  // Add an event. wake=true makes the brain think soon; otherwise it is
  // included the next time it thinks anyway.
  notify (text, wake = false, delayMs = 150, kind = 'event') {
    this.events.push({ text, wake, kind })
    if (this.events.length > 30) this.events.splice(0, this.events.length - 30)
    if (wake) this._schedule(delayMs)
  }

  // ---------------------------------------------------------------- wiring

  _wireExecutor () {
    // Plan ahead: while the LAST step of a plan runs, think about what comes next so the
    // bot can move straight on instead of standing around waiting for the model.
    this.executor.on('actionStarted', ({ name, args, remaining, persistent, instant }) => {
      const cfg = this.config.bot
      if (remaining !== 0 || persistent || instant || !cfg.autonomous || cfg.planAhead === false || this.paused) return
      const token = `${name}:${JSON.stringify(args)}:${Date.now()}`
      this.lookaheadFor = token
      setTimeout(() => {
        if (this.lookaheadFor !== token || !this.executor.isBusyWith(name)) return // already finished
        this.chained++
        if (this.chained > cfg.maxChainedSteps) return
        this.notify(`[planning ahead] You are now doing the last step of your plan: ${name} ${JSON.stringify(args)}. Decide what you'll do right AFTER it finishes. Actions you return now are queued after it (they won't interrupt it). Return [] to wait for the result instead.`, true, 0, 'lookahead')
      }, 1500)
    })

    this.executor.on('planFinished', ({ results, instantOnly }) => {
      // Plans that only touched memory (set_goal, remember_place...) don't need a follow-up thought.
      if (instantOnly) return this.notify(`[done] ${results.join('; ')}`, false)
      this.memory?.addJournal(`Did: ${results.join('; ')}`.slice(0, 200))
      this._selfWake(`[done] ${results.join('; ')}`)
    })
    this.executor.on('actionFailed', ({ name, results, skipped, error }) => {
      let tail = skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''
      const skill = require('../skills/registry').ACTION_SKILLS[name]?.skill
      if (skill && this.skills && !/haven't learned/.test(error || '')) tail += ` (if there's a lesson in this, save it with note_lesson for ${skill})`
      this.memory?.addJournal(`Failed: ${results[results.length - 1]}`.slice(0, 200))
      this._selfWake(`[failed] ${results.join('; ')}${tail}`)
    })
  }

  // Wakes caused by the bot's own progress are capped so it can't loop forever
  // without a player saying something.
  _selfWake (text) {
    this.chained++
    if (this.chained > this.config.bot.maxChainedSteps) {
      log.brain(`not re-planning (chain limit ${this.config.bot.maxChainedSteps} reached): ${text}`)
      this.notify(text, false)
      return
    }
    this.notify(text, true)
  }

  _startIdleLoop () {
    const iv = setInterval(() => {
      const { autonomous, idleThinkSeconds } = this.config.bot
      if (!autonomous || this.paused || this.thinking || !this.executor.isIdle() || this.executor.reflexActive) return
      if (Date.now() - this.lastThinkAt < idleThinkSeconds * 1000) return
      // The model keeps choosing to do nothing (or can't be reached): let the body do something normal.
      const llmDown = Date.now() - this.lastErrorNotice < 120000
      if (this.config.bot.autopilot !== false && (this.idleStreak >= 2 || llmDown)) {
        const pick = chooseActivity(this.bot, { memory: this.memory, skills: this.skills })
        if (pick) {
          this.idleStreak = 0
          this.lastThinkAt = Date.now()
          log.brain(`autopilot: ${pick.why}`)
          this.notify(`[autopilot] You were idle, so you started ${pick.why}.`, false)
          this.executor.setPlan(pick.plan)
          return
        }
      }
      this.chained = 0
      this.notify('[idle] Nobody needs you right now and you are not doing anything. Decide what YOU want to do next: handle your Needs, work on a goal (or set a new one), explore, or hang out with a friend. Say something if it fits.', true)
    }, Math.max(50, Math.min(5000, this.config.bot.idleThinkSeconds * 500)))
    iv.unref?.()
    this.bot.once('end', () => clearInterval(iv))
  }

  _schedule (delayMs) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this._think().catch(err => log.error('brain crashed:', err))
    }, delayMs)
  }

  // ---------------------------------------------------------------- thinking

  async _think () {
    if (this.thinking) return // _think re-checks pending events when it finishes
    if (this.paused) { this.events = []; return }
    if (!this.events.some(e => e.wake)) return
    this.thinking = true
    this.lastThinkAt = Date.now()

    let batch = this.events.splice(0)
    // A plan-ahead request is pointless once the step it was about has already finished.
    if (batch.some(e => e.kind === 'lookahead') && this.executor.isIdle()) {
      batch = batch.filter(e => e.kind !== 'lookahead')
      if (!batch.some(e => e.wake)) { this.events.unshift(...batch); this.thinking = false; return }
    }
    const appendMode = batch.some(e => e.kind === 'lookahead') && !batch.some(e => e.kind === 'chat' || /^\[failed\]/.test(e.text))
    const turn = buildTurn(batch.map(e => e.text), this.describeState())
    const messages = [...this.history, { role: 'user', content: turn.full }]

    log.debug('LLM input:\n' + turn.full)
    const started = Date.now()
    let raw
    try {
      raw = await this.llm.complete({ system: this.system, messages })
    } catch (err) {
      log.error(`LLM call failed (${this.llm.name}/${this.llm.model}): ${err.message}`)
      if (Date.now() - this.lastErrorNotice > 60000) {
        this.lastErrorNotice = Date.now()
        this.say("Sorry, I can't reach my AI brain right now (see the console).")
      }
      // Keep chat events so they're answered when the model is back; drop the rest.
      const chats = batch.filter(e => / (says|whispers to you): /.test(e.text)).map(e => ({ ...e, wake: false }))
      this.events.unshift(...chats)
      this.thinking = false
      return
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1)
    const reply = parseResponse(raw)
    if (reply.parseError) log.warn(`model did not return JSON; raw reply: ${String(raw).slice(0, 200)}`)
    if (this.config.bot.showThoughts && reply.thought) log.brain(`(${secs}s) ${reply.thought}`)
    else log.brain(`(${secs}s) replied`)

    if (reply.say) this.say(reply.say)

    if (reply.actions.length) {
      log.brain((appendMode ? 'next: ' : 'plan: ') + reply.actions.map(a => `${a.name} ${JSON.stringify(a.args)}`).join(' -> '))
      const problems = this.executor.setPlan(reply.actions, { append: appendMode })
      if (problems.length) {
        this._selfWake(`[system] Invalid plan: ${problems.join('; ')}. Use only the listed ACTIONS.`)
      }
      this.idleStreak = 0
    } else if (reply.parseError && !reply.say) {
      this._selfWake('[system] Your last reply was not valid JSON. Answer with exactly one JSON object: {"thought": "...", "say": "...", "actions": [...]}')
    } else if (this.executor.isIdle() && !appendMode) {
      this.idleStreak++
    }

    this.history.push(
      { role: 'user', content: turn.short },
      { role: 'assistant', content: JSON.stringify({ thought: reply.thought, say: reply.say, actions: reply.actions }) }
    )
    const max = Math.max(2, this.config.llm.maxHistory)
    if (this.history.length > max) this.history.splice(0, this.history.length - max)
    if (this.history[0]?.role !== 'user') this.history.shift()

    this.thinking = false
    if (this.events.some(e => e.wake)) this._schedule(100)
  }

  describeState () {
    const bot = this.bot
    const parts = [perception.describe(bot, { executor: this.executor })]
    try {
      const needs = assessNeeds(bot, { memory: this.memory, lastChatAt: this.lastChatAt, skills: this.skills })
      parts.push(describeNeeds(needs))
    } catch (err) {
      log.debug('needs failed: ' + err.message)
    }
    if (this.skills) parts.push(this.skills.describe())
    if (this.memory) {
      const nearby = Object.values(bot.players)
        .filter(p => p.entity && p.username !== bot.username && p.entity.position.distanceTo(bot.entity.position) < 32)
        .map(p => p.username)
      parts.push(this.memory.summary({ pos: bot.entity.position, dimension: bot.game?.dimension || 'overworld', playersNearby: nearby }))
      if (this.social) {
        try {
          const Z = require('../body/zones')
          const text = this.social.describe({ nearby, pos: bot.entity.position.floored(), dimension: bot.game?.dimension || 'overworld', zones: Z.getZones(this.memory) })
          if (text) parts.push(text)
        } catch (err) {
          log.debug('social describe failed: ' + err.message)
        }
      }
    }
    return parts.join('\n')
  }

  // ---------------------------------------------------------------- outputs

  say (text) {
    // Never let model output run server commands, and respect the 256-char chat limit.
    let clean = String(text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    clean = clean.replace(/^[/\\.!]+/, '').slice(0, 700)
    if (!clean) return
    const chunks = []
    while (clean.length > 240) {
      let cut = clean.lastIndexOf(' ', 240)
      if (cut < 100) cut = 240
      chunks.push(clean.slice(0, cut))
      clean = clean.slice(cut).trim().replace(/^[/\\]+/, '')
    }
    if (clean) chunks.push(clean)
    const send = (c) => { try { this.bot.chat(c) } catch {} }
    chunks.forEach((c, i) => (i === 0 ? send(c) : setTimeout(() => send(c), i * 400)))
    log.chat(`<${this.bot.username}> ${chunks.join(' ')}`)
  }

  // "!" commands skip the LLM entirely. Control commands are for server operators only.
  _command (username, text, { fromConsole = false, viaSay = false } = {}) {
    const [rawCmd, ...rest] = text.slice(1).trim().split(/\s+/)
    const cmd = (rawCmd || '').toLowerCase()
    const arg = rest.join(' ')
    const PUBLIC = ['help', 'status', 'goals', 'skills']
    const ADMIN = ['stop', 'come', 'follow', 'think', 'reset', 'pause', 'resume', 'autonomy', 'forget', 'wipe', 'op', 'deop', 'quit', 'skill', 'resetskills',
      'feelings', 'feel', 'protect', 'unprotect', 'social', 'suspects', 'confess']
    if (!PUBLIC.includes(cmd) && !ADMIN.includes(cmd)) return false // not a command: normal chat

    const who = fromConsole ? 'Console' : username
    if (viaSay && this.admin && !fromConsole) this.admin.grant(username) // /say needs OP, so this proves it
    const isAdmin = fromConsole || viaSay || !this.admin || this.admin.isAdmin(username)
    if (ADMIN.includes(cmd) && !isAdmin) {
      this.say(`Only server operators can use !${cmd}. (OPs: "/say !${cmd}" once and I'll remember you.)`)
      this.notify(`${username} tried to use the operator command !${cmd} on you (they are not an operator).`, false)
      return true
    }
    const tellBrain = (t) => this.notify(`[operator] ${t}`, false)

    switch (cmd) {
      case 'help':
        this.say('Talk to me normally. Anyone: !status, !goals, !skills. Operators: !stop, !come, !follow, !think, !pause, !resume, !autonomy on|off, !reset, !forget <player>, !wipe confirm, !op/!deop <name>, !quit, !skill <name|all> tier|cap|xp <n> / natural / nocap / lock / unlock / reset, !resetskills confirm. Social: !social [feature on|off], !feelings [player], !feel <player> <-100..100|reset>, !protect/!unprotect <player>, !suspects, !confess')
        return true
      case 'social': {
        if (!this.social) { this.say('I have no social system.'); return true }
        const [feature, state] = rest.map(x => x.toLowerCase())
        if (!feature) { this.say(this.social.status()); return true }
        const names = { theft: 'theftDetection', thefts: 'theftDetection', theftdetection: 'theftDetection', detection: 'theftDetection', steal: 'stealing', feeling: 'feelings', owner: 'ownership', sabotaging: 'sabotage' }
        const f = names[feature] || feature
        if (!/^(on|off)$/.test(state || '')) { this.say('Usage: !social <all|feelings|ownership|stealing|theft|sabotage> on|off'); return true }
        try {
          this.social.setFeature(f, state === 'on')
          this.refreshSystemPrompt()
          tellBrain(`${who} (a server operator) switched ${f === 'all' ? 'your whole social side (feelings, stealing, sabotage...)' : f} ${state}.`)
          this.say(this.social.status())
        } catch (err) {
          this.say(err.message)
        }
        return true
      }
      case 'feelings': {
        if (!this.social) { this.say('I have no social system.'); return true }
        const list = this.social.feelings().filter(f => !arg || f.name.toLowerCase() === arg.toLowerCase())
        if (!list.length) { this.say(arg ? `No feelings about ${arg} yet.` : 'No strong feelings about anyone yet.'); return true }
        this.say('Feelings: ' + list.slice(0, 10).map(f => `${f.name} ${f.score} (${f.level}${this.social.isProtected(f.name) ? ', protected' : ''})${arg && f.why.length ? ` because: ${f.why.join('; ')}` : ''}`).join(', '))
        return true
      }
      case 'feel': {
        if (!this.social) { this.say('I have no social system.'); return true }
        const [player, value] = rest
        if (!player || value === undefined) { this.say('Usage: !feel <player> <-100..100> or !feel <player> reset'); return true }
        if (/^reset$/i.test(value)) {
          this.social.resetFeeling(player)
          tellBrain(`${who} (a server operator) reset your feelings about ${player} to neutral.`)
          this.say(`Feelings about ${player} reset.`)
          return true
        }
        const n = Number(value)
        if (!Number.isFinite(n)) { this.say('Usage: !feel <player> <-100..100>'); return true }
        const score = this.social.setFeeling(player, n)
        tellBrain(`${who} (a server operator) set how you feel about ${player} to ${score} (${this.social.level(player)}).`)
        this.say(`I now feel ${score} (${this.social.level(player)}) about ${player}.`)
        return true
      }
      case 'protect':
      case 'unprotect': {
        if (!this.social) { this.say('I have no social system.'); return true }
        if (!arg) { this.say(`Usage: !${cmd} <player>`); return true }
        this.social.protect(arg, cmd === 'protect')
        this.refreshSystemPrompt()
        tellBrain(cmd === 'protect' ? `${who} (a server operator) protected ${arg}: you must never steal from or sabotage them.` : `${who} (a server operator) removed ${arg}'s protection.`)
        this.say(cmd === 'protect' ? `${arg} is protected: I'll never steal from or sabotage them.` : `${arg} is no longer protected${this.social.cfg().protected.some(p => p.toLowerCase() === arg.toLowerCase()) ? ' (but the config still lists them)' : ''}.`)
        return true
      }
      case 'suspects': {
        if (!this.social) { this.say('I have no social system.'); return true }
        const list = this.social.thefts(7 * 24 * 3600 * 1000)
        this.say(list.length ? 'Thefts from me: ' + list.slice(-3).map(t => this.social.describeTheft(t)).join(' | ') : 'Nothing has gone missing from my chests (that I know of).')
        return true
      }
      case 'confess': {
        if (!this.social) { this.say('I have no social system.'); return true }
        const took = this.social.myThefts().slice(-4).map(t => `took ${Object.entries(t.items).map(([n, c]) => `${c} ${n}`).join(', ')} from ${t.victim}`)
        const sab = this.social.mySabotage().slice(-3).map(t => `sabotaged ${t.victim} (${t.kind})`)
        this.say(took.length || sab.length ? `Fine... I ${[...took, ...sab].join('; ')}.` : "I haven't done anything! (Really.)")
        return true
      }
      case 'skills':
        this.say(this.skills ? 'Skills: ' + this.skills.summaryShort() : 'I have no skill system.')
        return true
      case 'skill': {
        if (!this.skills) { this.say('I have no skill system.'); return true }
        const [which, op, value] = rest.map(x => x.toLowerCase())
        const ids = which === 'all' ? this.skills.ids() : [which]
        try {
          for (const id of ids) {
            this.skills.state(id) // validates the name
            if (op === 'tier') this.skills.setFixed(id, Number(value))
            else if (op === 'natural') this.skills.setFixed(id, null)
            else if (op === 'cap') this.skills.setCap(id, Number(value))
            else if (op === 'nocap') this.skills.setCap(id, null)
            else if (op === 'xp') this.skills.setXp(id, Number(value))
            else if (op === 'lock' || op === 'unlock') this.skills.setLocked(id, op === 'lock')
            else if (op === 'reset') this.skills.reset(id)
            else throw new Error('usage: !skill <name|all> tier <n> | natural | cap <n> | nocap | xp <n> | lock | unlock | reset')
          }
          tellBrain(`${who} (a server operator) changed your ${which} skill (${op}${value ? ' ' + value : ''}).`)
          this.say('Skills: ' + this.skills.summaryShort())
        } catch (err) {
          this.say(err.message)
        }
        return true
      }
      case 'resetskills':
        if (!this.skills) { this.say('I have no skill system.'); return true }
        if (arg.toLowerCase() !== 'confirm') { this.say('This puts every skill back to the start. Type !resetskills confirm to do it.'); return true }
        this.skills.reset()
        tellBrain(`${who} (a server operator) reset all your skills. You feel like a beginner again.`)
        this.say('Back to basics. Skills: ' + this.skills.summaryShort())
        return true
      case 'status':
        this.say(`Health ${Math.round(this.bot.health)}/20, food ${this.bot.food}/20.${this.paused ? ' (paused)' : ''} ${this.executor.describe()}`)
        return true
      case 'goals': {
        const goals = this.memory?.activeGoals() || []
        this.say(goals.length ? 'My goals: ' + goals.map(g => `#${g.id} ${g.text}`).join('; ') : "I don't have any goals right now.")
        return true
      }
      case 'stop':
        this.executor.cancelAll('stopped by ' + who)
        tellBrain(`${who} (a server operator) forced you to stop everything.`)
        this.say('Stopping.')
        return true
      case 'come':
        this.executor.setPlan([{ name: 'go_to_player', args: { player: arg || username } }])
        tellBrain(`${who} (a server operator) made you walk over to ${arg || username}.`)
        this.say('On my way.')
        return true
      case 'follow':
        this.executor.setPlan([{ name: 'follow_player', args: { player: arg || username } }])
        tellBrain(`${who} (a server operator) made you follow ${arg || username}.`)
        this.say('Following.')
        return true
      case 'think':
        this.chained = 0
        this.notify(`${who} wants you to decide what to do next on your own.`, true)
        return true
      case 'pause':
        this.paused = true
        this.executor.cancelAll('paused')
        this.events = []
        this.say('Paused. I will only defend myself until someone uses !resume.')
        return true
      case 'resume':
        this.paused = false
        this.lastThinkAt = 0
        this.say('Back to it.')
        return true
      case 'autonomy': {
        const on = /^(on|true|yes|1)$/i.test(arg)
        const off = /^(off|false|no|0)$/i.test(arg)
        if (!on && !off) { this.say(`Autonomy is ${this.config.bot.autonomous ? 'on' : 'off'}. Use !autonomy on or !autonomy off.`); return true }
        this.config.bot.autonomous = on
        this.say(on ? 'I will act on my own again.' : 'I will wait to be asked.')
        return true
      }
      case 'reset':
        this.history = []
        this.events = []
        this.executor.cancelAll('reset')
        this.say('Conversation cleared (long-term memory kept).')
        return true
      case 'forget': {
        if (!arg) { this.say('Usage: !forget <player>'); return true }
        const ok = this.memory?.forgetPlayer(arg)
        this.social?.resetFeeling(arg)
        this.history = []
        this.say(ok ? `I have forgotten everything about ${arg}.` : `I had nothing on ${arg}.`)
        return true
      }
      case 'wipe':
        if (arg.toLowerCase() !== 'confirm') {
          this.say('This erases ALL my memories (places, goals, journal, opinions of players). Type !wipe confirm to do it.')
          return true
        }
        this.memory?.wipe()
        this.skills?.reset()
        this.history = []
        this.events = []
        this.executor.cancelAll('wiped')
        log.warn(`Memory wiped by ${who}.`)
        this.say('...Where am I? Everything is blank.')
        return true
      case 'op':
      case 'deop': {
        if (!arg || !this.admin) { this.say(`Usage: !${cmd} <name>`); return true }
        if (cmd === 'op') this.admin.grant(arg)
        else this.admin.revoke(arg)
        this.say(cmd === 'op' ? `${arg} can now control me.` : `${arg} can no longer control me (unless they're in the config or ops.json).`)
        return true
      }
      case 'quit':
        this.say('Logging off.')
        log.warn(`Quit requested by ${who}.`)
        setTimeout(() => (this.onQuit ? this.onQuit() : this.bot.quit('quit')), 800)
        return true
    }
    return false
  }
}

module.exports = { Brain }
