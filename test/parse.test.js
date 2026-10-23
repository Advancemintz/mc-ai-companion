'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseResponse } = require('../src/brain/parse')

test('clean JSON', () => {
  const r = parseResponse('{"thought":"ok","say":"On it!","actions":[{"name":"collect_block","args":{"block":"oak_log","count":3}}]}')
  assert.strictEqual(r.say, 'On it!')
  assert.deepStrictEqual(r.actions, [{ name: 'collect_block', args: { block: 'oak_log', count: 3 } }])
})

test('code fences, think blocks and prose around JSON', () => {
  const r = parseResponse('<think>hmm {not json}</think>Sure!\n```json\n{"say": "hi", "actions": []}\n```')
  assert.strictEqual(r.say, 'hi')
  assert.strictEqual(r.parseError, false)
})

test('trailing commas and missing closing braces', () => {
  const r = parseResponse('{"say": "ok", "actions": [{"name": "stop", "args": {},},],')
  assert.strictEqual(r.say, 'ok')
  assert.strictEqual(r.actions[0].name, 'stop')
})

test('alternative action shapes', () => {
  const r = parseResponse(JSON.stringify({
    message: 'yo',
    action: { action: 'Follow_Player', player: 'Steve' }
  }))
  assert.strictEqual(r.say, 'yo')
  assert.deepStrictEqual(r.actions, [{ name: 'follow_player', args: { player: 'Steve' } }])
})

test('string args get parsed', () => {
  const r = parseResponse('{"say":"","actions":[{"tool":"craft","arguments":"{\\"item\\":\\"stick\\"}"}]}')
  assert.deepStrictEqual(r.actions, [{ name: 'craft', args: { item: 'stick' } }])
})

test('braces inside strings do not confuse the extractor', () => {
  const r = parseResponse('{"say":"I like {curly} things","actions":[]} trailing {junk}')
  assert.strictEqual(r.say, 'I like {curly} things')
})

test('plain text becomes speech', () => {
  const r = parseResponse('Hello there, friend!')
  assert.strictEqual(r.parseError, true)
  assert.strictEqual(r.say, 'Hello there, friend!')
  assert.deepStrictEqual(r.actions, [])
})
