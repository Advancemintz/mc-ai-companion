'use strict'

// Runs every provider adapter against a local fake HTTP server that mimics
// each API's request and response format.

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { createLLM } = require('../src/llm/providers')

function fakeServer (handler) {
  return new Promise(resolve => {
    const seen = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null
        seen.push({ url: req.url, headers: req.headers, body: parsed })
        const { status = 200, json } = handler(req, parsed)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const REPLY = '{"say":"hi","actions":[]}'
const history = [
  { role: 'user', content: 'a' },
  { role: 'assistant', content: 'b' },
  { role: 'user', content: 'c' },
  { role: 'user', content: 'd' } // consecutive user turns get merged
]

function llmConfig (provider, cfg) {
  return { provider, temperature: 0.5, timeoutSeconds: 5, providers: { [provider]: cfg } }
}

test('ollama', async () => {
  const { server, seen, base } = await fakeServer(() => ({ json: { message: { role: 'assistant', content: REPLY } } }))
  const llm = createLLM(llmConfig('ollama', { baseUrl: base, model: 'qwen3:8b', think: false }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  const req = seen[0]
  assert.strictEqual(req.url, '/api/chat')
  assert.strictEqual(req.body.format, 'json')
  assert.strictEqual(req.body.stream, false)
  assert.strictEqual(req.body.think, false)
  assert.deepStrictEqual(req.body.messages[0], { role: 'system', content: 'SYS' })
  assert.strictEqual(req.body.messages.length, 4)
  assert.strictEqual(req.body.messages[3].content, 'c\n\nd')
  server.close()
})

test('ollama retries without "think" when the model rejects it', async () => {
  let n = 0
  const { server, seen, base } = await fakeServer(() => (++n === 1
    ? { status: 400, json: { error: 'model does not support thinking' } }
    : { json: { message: { content: REPLY } } }))
  const llm = createLLM(llmConfig('ollama', { baseUrl: base, model: 'llama3.1:8b', think: false }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  assert.strictEqual('think' in seen[1].body, false)
  server.close()
})

test('openai (Responses API)', async () => {
  const { server, seen, base } = await fakeServer(() => ({
    json: { output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: REPLY }] }] }
  }))
  const llm = createLLM(llmConfig('openai', { baseUrl: base, apiKey: 'sk-test', model: 'gpt-x', reasoningEffort: 'low' }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  const req = seen[0]
  assert.strictEqual(req.url, '/responses')
  assert.strictEqual(req.headers.authorization, 'Bearer sk-test')
  assert.strictEqual(req.body.instructions, 'SYS')
  assert.deepStrictEqual(req.body.reasoning, { effort: 'low' })
  assert.strictEqual(req.body.input.length, 3)
  assert.strictEqual('temperature' in req.body, false)
  server.close()
})

test('openai-compatible (chat completions)', async () => {
  const { server, seen, base } = await fakeServer(() => ({ json: { choices: [{ message: { content: REPLY } }] } }))
  const llm = createLLM(llmConfig('openai-compatible', { baseUrl: base + '/v1/', model: 'local', jsonMode: true }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  assert.strictEqual(seen[0].url, '/v1/chat/completions')
  assert.deepStrictEqual(seen[0].body.response_format, { type: 'json_object' })
  assert.strictEqual(seen[0].headers.authorization, undefined)
  server.close()
})

test('anthropic', async () => {
  const { server, seen, base } = await fakeServer(() => ({ json: { content: [{ type: 'text', text: REPLY }] } }))
  const llm = createLLM(llmConfig('anthropic', { baseUrl: base, apiKey: 'ak', model: 'claude-x', maxTokens: 500 }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  const req = seen[0]
  assert.strictEqual(req.url, '/v1/messages')
  assert.strictEqual(req.headers['x-api-key'], 'ak')
  assert.strictEqual(req.headers['anthropic-version'], '2023-06-01')
  assert.strictEqual(req.body.system, 'SYS')
  assert.strictEqual(req.body.max_tokens, 500)
  assert.strictEqual(req.body.messages[0].role, 'user')
  server.close()
})

test('gemini', async () => {
  const { server, seen, base } = await fakeServer(() => ({
    json: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: REPLY }] } }] }
  }))
  const llm = createLLM(llmConfig('gemini', { baseUrl: base, apiKey: 'gk', model: 'gemini-x' }))
  assert.strictEqual(await llm.complete({ system: 'SYS', messages: history }), REPLY)
  const req = seen[0]
  assert.strictEqual(req.url, '/models/gemini-x:generateContent')
  assert.strictEqual(req.headers['x-goog-api-key'], 'gk')
  assert.strictEqual(req.body.contents[1].role, 'model')
  assert.strictEqual(req.body.generationConfig.responseMimeType, 'application/json')
  server.close()
})

test('HTTP errors surface the provider message', async () => {
  const { server, base } = await fakeServer(() => ({ status: 401, json: { error: { message: 'invalid x-api-key' } } }))
  const llm = createLLM(llmConfig('anthropic', { baseUrl: base, apiKey: 'bad', model: 'm' }))
  await assert.rejects(llm.complete({ system: 's', messages: history }), /401: invalid x-api-key/)
  server.close()
})

test('missing API key fails fast with a helpful message', () => {
  assert.throws(() => createLLM(llmConfig('openai', { model: 'm' })), /needs an API key/)
})
