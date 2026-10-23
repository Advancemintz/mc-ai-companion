'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  minecraft: {
    host: 'localhost',
    port: 25565,
    username: 'Companion',
    auth: 'offline',
    version: false
  },
  bot: {
    personality: 'You are a friendly, helpful Minecraft companion.',
    respondTo: 'all', // "all" | "mention"
    admins: [], // extra people allowed to use ! commands (server OPs are recognized via /say)
    opsFile: '', // optional path to the server's ops.json
    otherBots: [], // names of other AI bots, so bot-to-bot chat can't loop forever
    botChatCooldownSeconds: 30,
    greeting: '',
    autonomous: true,
    idleThinkSeconds: 10,
    planAhead: true, // think about the next step while doing the last one
    autopilot: true, // do something sensible when the model keeps choosing to idle
    stuckSeconds: 40, // give up on an action that makes no progress for this long
    railOffers: { enabled: true, intervalDays: 7, minDistance: 40 }, // offer players railways to their bases
    // Skills grow with practice. mode "natural" = earn XP; "fixed" = stay at startTier(s).
    // affinity > 1 means a natural talent (faster XP), < 1 a weak spot. xpRate scales everything.
    skills: { mode: 'natural', startTier: 1, startTiers: {}, caps: {}, affinity: {}, xpRate: 1 },
    memoryDir: 'memory',
    memoryName: '',
    maxChainedSteps: 10,
    reconnect: true,
    showThoughts: true
  },
  reflexes: {
    autoEat: true,
    selfDefense: true,
    defendRadius: 6,
    fleeHealth: 6,
    autoArmor: true
  },
  llm: {
    provider: 'ollama',
    temperature: 0.6,
    maxHistory: 16,
    timeoutSeconds: 90,
    providers: {}
  }
}

// Environment variables win over the config file, so keys never have to live in it.
const ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY'
}

function isObject (v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge (base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

function loadConfig (file) {
  const configPath = path.resolve(file || process.env.MC_AI_CONFIG || 'config.json')
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`)
  }
  const config = deepMerge(DEFAULTS, raw)

  // Command line / env overrides that are handy when testing.
  if (process.env.MC_HOST) config.minecraft.host = process.env.MC_HOST
  if (process.env.MC_PORT) config.minecraft.port = Number(process.env.MC_PORT)
  if (process.env.MC_VERSION) config.minecraft.version = process.env.MC_VERSION
  if (process.env.LLM_PROVIDER) config.llm.provider = process.env.LLM_PROVIDER

  for (const [provider, envName] of Object.entries(ENV_KEYS)) {
    if (process.env[envName]) {
      config.llm.providers[provider] = { ...(config.llm.providers[provider] || {}), apiKey: process.env[envName] }
    }
  }

  validate(config)
  config._path = configPath
  return config
}

function validate (config) {
  const { provider, providers } = config.llm
  if (!providers[provider]) {
    throw new Error(`llm.provider is "${provider}" but there is no llm.providers["${provider}"] section in the config.`)
  }
  if (!['all', 'mention'].includes(config.bot.respondTo)) {
    throw new Error('bot.respondTo must be "all" or "mention".')
  }
  if (config.bot.owner) {
    console.warn('Note: bot.owner is no longer used (server operators control the bot); ignoring it. Use "admins": ["Name"] for a fixed controller.')
    delete config.bot.owner
  }
  if (!['offline', 'microsoft'].includes(config.minecraft.auth)) {
    throw new Error('minecraft.auth must be "offline" or "microsoft".')
  }
}

module.exports = { loadConfig, deepMerge }
