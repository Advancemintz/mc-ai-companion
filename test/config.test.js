'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { loadConfig } = require('../src/config')

test('the shipped config.json loads and has sane defaults', () => {
  const cfg = loadConfig(require('path').join(__dirname, '..', 'config.json'))
  assert.strictEqual(cfg.bot.autonomous, true)
  assert.ok(Array.isArray(cfg.bot.admins))
  assert.ok(cfg.llm.providers[cfg.llm.provider])
  assert.strictEqual(cfg.bot.owner, undefined)
})
