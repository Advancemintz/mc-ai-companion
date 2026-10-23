'use strict'

// Entry point: connects the bot, loads the body (plugins, actions, reflexes)
// and the brain (LLM loop), and reconnects if the connection drops.

const readline = require('readline')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const { plugin: tool } = require('mineflayer-tool')

const { loadConfig } = require('./config')
const { createLLM } = require('./llm/providers')
const { Executor } = require('./body/executor')
const { actions } = require('./body/actions')
const { startReflexes } = require('./body/reflexes')
const { Brain } = require('./brain/brain')
const { Memory } = require('./brain/memory')
const { startSenses } = require('./brain/senses')
const { protectMovements } = require('./body/zones')
const { startIdleBehaviors } = require('./body/idle')
const { startRailOffers } = require('./brain/railOffers')
const { SkillBook } = require('./skills/skillbook')
const { AdminControl, parseSayCommand } = require('./brain/admin')
const log = require('./util/log')

let config
try {
  config = loadConfig(process.argv[2])
} catch (err) {
  log.error(err.message)
  process.exit(1)
}

let llm
try {
  llm = createLLM(config.llm)
} catch (err) {
  log.error(err.message)
  process.exit(1)
}

// Long-term memory lives outside the bot so it survives reconnects.
const memory = Memory.forBot(config)
log.info(`Memory file: ${memory.file}`)
const admin = new AdminControl(config, memory)
const skills = new SkillBook(memory, config)
log.info(`Skills: ${skills.summaryShort()}`)

let current = null // { bot, brain, executor }
let reconnectDelay = 5000
let shuttingDown = false

function createBot () {
  const mc = config.minecraft
  log.info(`Connecting to ${mc.host}:${mc.port} as ${mc.username} (${mc.auth}, version ${mc.version || 'auto'})...`)
  const bot = mineflayer.createBot({
    host: mc.host,
    port: mc.port,
    username: mc.username,
    auth: mc.auth,
    version: mc.version || false,
    checkTimeoutInterval: 60 * 1000,
    hideErrors: false
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(tool)
  bot.loadPlugin(pvp)
  bot.loadPlugin(collectBlock)
  if (config.reflexes.autoArmor) {
    try {
      bot.loadPlugin(require('mineflayer-armor-manager'))
    } catch (err) {
      log.warn('Armor manager not available: ' + err.message)
    }
  }

  bot.once('spawn', () => {
    reconnectDelay = 5000
    log.info(`Spawned in ${bot.game.dimension} (Minecraft ${bot.version}). Brain: ${llm.name} / ${llm.model}`)

    const movements = new Movements(bot)
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.canDig = true
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.thinkTimeout = 10000

    const buildMovements = new Movements(bot)
    buildMovements.canDig = false
    bot._buildMovements = buildMovements
    // Never break other people's blocks, don't dig or pillar inside bases, open doors.
    protectMovements(bot, [movements], memory)
    protectMovements(bot, [buildMovements], memory, { useZones: false })

    // Fight using the same movement rules.
    bot.pvp.movements = movements
    bot.pvp.attackRange = 3

    const executor = new Executor(bot, actions, { memory, stuckSeconds: config.bot.stuckSeconds })
    skills.attach(executor)
    const brain = new Brain({ bot, llm, executor, actions, config, memory, admin, skills })
    skills.removeAllListeners('levelUp')
    skills.on('levelUp', (u) => {
      const label = require('./skills/registry').SKILLS[u.skill].label
      log.info(`LEVEL UP: ${label} -> tier ${u.tier} "${u.name}"`)
      brain.notify(`[level up] ${u.unlocked ? `You've unlocked a new skill: ${label}` : `Your ${label.toLowerCase()} skill reached tier ${u.tier}`} "${u.name}": now you can do ${u.can}. Feel free to celebrate briefly.`, true)
    })
    brain.onQuit = shutdown
    startReflexes(bot, executor, config, (text, wake) => brain.notify(text, wake))
    startSenses(bot, brain, config)
    startIdleBehaviors(bot, executor)
    startRailOffers(bot, brain, memory, config)
    current = { bot, brain, executor }

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      log.chat(`<${username}> ${message}`)
      brain.onPlayerChat(username, message)
    })
    // "/say !command" from an operator (only OPs can use /say).
    bot.on('message', (jsonMsg) => {
      const said = parseSayCommand(jsonMsg)
      if (!said || said.sender === bot.username || !said.text.startsWith('!')) return
      log.chat(`[${said.sender} via /say] ${said.text}`)
      brain.onPlayerChat(said.sender, said.text, { viaSay: true })
    })
    bot.on('whisper', (username, message) => {
      if (username === bot.username) return
      log.chat(`<${username} whispers> ${message}`)
      brain.onPlayerChat(username, message, { whisper: true })
    })

    bot.on('death', () => {
      log.warn('Died!')
      executor.cancelAll('died')
      const p = bot.entity?.position
      if (p) memory.setPlace('death_spot', p, bot.game?.dimension, 'where I last died; my items may still be there for ~5 minutes')
      memory.addJournal('I died.')
      brain.notify('[event] You died and respawned. Your items were dropped where you died (saved as death_spot, they vanish after ~5 minutes).', true)
    })

    if (config.bot.greeting) setTimeout(() => brain.say(config.bot.greeting), 1500)
  })

  bot.on('kicked', (reason) => {
    let text = reason
    try { text = typeof reason === 'string' ? reason : JSON.stringify(reason) } catch {}
    log.warn(`Kicked: ${text}`)
    if (/verify username|not authenticated|invalid session/i.test(text)) {
      log.warn('The server checks Minecraft accounts (online-mode). See README "Connecting" for options.')
    }
  })

  bot.on('error', (err) => {
    log.error(`Connection error: ${err.message}`)
    if (err.code === 'ECONNREFUSED') {
      log.warn(`Nothing is listening on ${mc.host}:${mc.port}. Is the world open to LAN / the server running, and is the port right?`)
    }
    if (/unsupported|version/i.test(err.message)) {
      log.warn('Try setting minecraft.version in config.json (e.g. "1.21.4").')
    }
  })

  bot.on('end', (reason) => {
    log.warn(`Disconnected (${reason}).`)
    current = null
    if (shuttingDown || !config.bot.reconnect) return
    log.info(`Reconnecting in ${reconnectDelay / 1000}s...`)
    setTimeout(createBot, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })

  return bot
}

// Type in the terminal to talk to the bot (counts as a server operator).
function startConsole () {
  if (!process.stdin.isTTY) return
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    if (!current) return log.warn('Bot is not connected yet.')
    if (text === '/quit' || text === '/exit') return shutdown()
    current.brain.onPlayerChat('Console', text, { fromConsole: true })
  })
  log.info('Type in this window to talk to the bot (as an operator, so ! commands work). Type /quit to exit.')
}

function shutdown () {
  shuttingDown = true
  log.info('Shutting down...')
  memory.saveNow()
  try { current?.bot.quit('bye') } catch {}
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => log.debug('unhandled rejection: ' + (err?.message || err)))
process.on('uncaughtException', (err) => log.error('uncaught exception:', err))

createBot()
startConsole()
