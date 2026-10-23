'use strict'

// Shared helpers for the LLM providers. Uses Node's built-in fetch (Node 18+).

class LLMError extends Error {
  constructor (message, { status, retryable } = {}) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.retryable = !!retryable
  }
}

async function postJson (url, { headers = {}, body, timeoutMs = 60000 }) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    if (err.name === 'TimeoutError') throw new LLMError(`Request timed out after ${timeoutMs / 1000}s`, { retryable: true })
    throw new LLMError(`Could not reach ${new URL(url).host}: ${err.cause?.code || err.message}`, { retryable: true })
  }

  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      detail = parsed.error?.message || parsed.error || parsed.message || text
    } catch {}
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
    throw new LLMError(`HTTP ${res.status}: ${detail.slice(0, 400)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new LLMError(`Provider returned invalid JSON: ${text.slice(0, 200)}`)
  }
}

// Most providers need strictly alternating user/assistant turns that start with "user".
function normalizeMessages (messages) {
  const out = []
  for (const m of messages) {
    if (!m.content) continue
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content += '\n\n' + m.content
    } else {
      out.push({ role, content: m.content })
    }
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

function requireKey (cfg, name) {
  if (!cfg.apiKey) {
    throw new Error(`The "${name}" provider needs an API key. Put it in config.json (llm.providers.${name}.apiKey) or set the environment variable.`)
  }
}

module.exports = { postJson, normalizeMessages, requireKey, LLMError }
