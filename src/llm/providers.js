'use strict'

// One adapter per LLM API. Every adapter exposes the same interface:
//   complete({ system, messages }) -> Promise<string>
// where messages is [{ role: 'user' | 'assistant', content: string }].
// The brain asks every model for the same JSON reply format, so no provider-specific
// tool-calling is needed. That keeps small local models working too.

const { postJson, normalizeMessages, requireKey } = require('./http')

function trimSlash (url) {
  return String(url || '').replace(/\/+$/, '')
}

// ---------------------------------------------------------------- Ollama (local)
function ollama (cfg, common) {
  const baseUrl = trimSlash(cfg.baseUrl || 'http://localhost:11434')
  let sendThink = cfg.think !== undefined && cfg.think !== null

  return {
    name: 'ollama',
    model: cfg.model,
    async complete ({ system, messages }) {
      const body = {
        model: cfg.model,
        messages: [{ role: 'system', content: system }, ...normalizeMessages(messages)],
        stream: false,
        format: 'json',
        keep_alive: cfg.keepAlive || '30m',
        options: { temperature: common.temperature, ...(cfg.options || {}) }
      }
      if (sendThink) body.think = !!cfg.think
      let data
      try {
        data = await postJson(`${baseUrl}/api/chat`, { body, timeoutMs: common.timeoutMs })
      } catch (err) {
        // Older Ollama versions or non-thinking models may reject the "think" flag.
        if (sendThink && /think/i.test(err.message)) {
          sendThink = false
          delete body.think
          data = await postJson(`${baseUrl}/api/chat`, { body, timeoutMs: common.timeoutMs })
        } else if (/not found/i.test(err.message)) {
          throw new Error(`${err.message} - run "ollama pull ${cfg.model}" first.`)
        } else {
          throw err
        }
      }
      return data.message?.content || ''
    }
  }
}

// ---------------------------------------------------------------- OpenAI (Responses API)
function openai (cfg, common) {
  requireKey(cfg, 'openai')
  const baseUrl = trimSlash(cfg.baseUrl || 'https://api.openai.com/v1')

  return {
    name: 'openai',
    model: cfg.model,
    async complete ({ system, messages }) {
      const body = {
        model: cfg.model,
        instructions: system,
        input: normalizeMessages(messages).map(m => ({ role: m.role, content: m.content })),
        max_output_tokens: cfg.maxTokens || 2048
      }
      if (cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort }
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature
      const data = await postJson(`${baseUrl}/responses`, {
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body,
        timeoutMs: common.timeoutMs
      })
      if (typeof data.output_text === 'string') return data.output_text
      const parts = []
      for (const item of data.output || []) {
        if (item.type !== 'message') continue
        for (const c of item.content || []) {
          if (c.type === 'output_text' && c.text) parts.push(c.text)
        }
      }
      return parts.join('')
    }
  }
}

// ---------------------------------------------------------------- Any OpenAI-compatible server
// LM Studio, OpenRouter, Groq, DeepSeek, Mistral, xAI, vLLM, llama.cpp server...
function openaiCompatible (cfg, common) {
  const baseUrl = trimSlash(cfg.baseUrl)
  if (!baseUrl) throw new Error('openai-compatible provider needs a baseUrl, e.g. http://localhost:1234/v1')

  return {
    name: 'openai-compatible',
    model: cfg.model,
    async complete ({ system, messages }) {
      const body = {
        model: cfg.model,
        messages: [{ role: 'system', content: system }, ...normalizeMessages(messages)],
        temperature: cfg.temperature ?? common.temperature,
        max_tokens: cfg.maxTokens || 1024
      }
      if (cfg.jsonMode) body.response_format = { type: 'json_object' }
      const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}
      Object.assign(headers, cfg.headers || {})
      const data = await postJson(`${baseUrl}/chat/completions`, { headers, body, timeoutMs: common.timeoutMs })
      return data.choices?.[0]?.message?.content || ''
    }
  }
}

// ---------------------------------------------------------------- Anthropic (Claude)
function anthropic (cfg, common) {
  requireKey(cfg, 'anthropic')
  const baseUrl = trimSlash(cfg.baseUrl || 'https://api.anthropic.com')

  return {
    name: 'anthropic',
    model: cfg.model,
    async complete ({ system, messages }) {
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens || 1024,
        system,
        messages: normalizeMessages(messages)
      }
      const temperature = cfg.temperature ?? common.temperature
      if (temperature !== undefined) body.temperature = temperature
      const data = await postJson(`${baseUrl}/v1/messages`, {
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': cfg.apiVersion || '2023-06-01'
        },
        body,
        timeoutMs: common.timeoutMs
      })
      return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
    }
  }
}

// ---------------------------------------------------------------- Google Gemini
function gemini (cfg, common) {
  requireKey(cfg, 'gemini')
  const baseUrl = trimSlash(cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')

  return {
    name: 'gemini',
    model: cfg.model,
    async complete ({ system, messages }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: normalizeMessages(messages).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: {
          temperature: cfg.temperature ?? common.temperature,
          responseMimeType: 'application/json'
        }
      }
      const data = await postJson(`${baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        headers: { 'x-goog-api-key': cfg.apiKey },
        body,
        timeoutMs: common.timeoutMs
      })
      const parts = data.candidates?.[0]?.content?.parts || []
      return parts.filter(p => !p.thought && p.text).map(p => p.text).join('')
    }
  }
}

const FACTORIES = {
  ollama,
  openai,
  'openai-compatible': openaiCompatible,
  anthropic,
  claude: anthropic,
  gemini,
  google: gemini
}

function createLLM (llmConfig) {
  const name = llmConfig.provider
  const factory = FACTORIES[name]
  if (!factory) {
    throw new Error(`Unknown LLM provider "${name}". Use one of: ${Object.keys(FACTORIES).join(', ')}`)
  }
  const cfg = llmConfig.providers[name] || {}
  if (!cfg.model) throw new Error(`llm.providers.${name}.model is not set.`)
  return factory(cfg, {
    temperature: llmConfig.temperature,
    timeoutMs: (llmConfig.timeoutSeconds || 90) * 1000
  })
}

module.exports = { createLLM, FACTORIES }
