'use strict'

// Turns whatever the model replied with into { thought, say, actions }.
// Models are messy (code fences, <think> blocks, trailing commas, prose around JSON),
// so this is deliberately forgiving. If no JSON can be found at all, the text is
// treated as something to say, so the bot still responds.

function stripNoise (text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim()
}

// Finds the first balanced {...} block, respecting strings.
function extractJsonObject (text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start) // unbalanced; let the repair step try
}

function tryParse (candidate) {
  try {
    return JSON.parse(candidate)
  } catch {}
  // Common small-model mistakes: trailing commas, missing closing braces.
  let fixed = candidate.replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(fixed)
  } catch {}
  const closers = missingClosers(fixed)
  if (closers) {
    fixed = fixed.replace(/,\s*$/, '') + closers
    try {
      return JSON.parse(fixed)
    } catch {}
  }
  return null
}

// Returns the brackets needed to close a truncated JSON string, in the right order.
function missingClosers (text) {
  const stack = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return (inString ? '"' : '') + stack.reverse().join('')
}

function normalizeAction (raw) {
  if (!raw) return null
  if (typeof raw === 'string') return { name: raw.trim(), args: {} }
  if (typeof raw !== 'object') return null
  const name = raw.name || raw.action || raw.tool || raw.command || raw.type
  if (!name || typeof name !== 'string') return null
  let args = raw.args || raw.arguments || raw.params || raw.parameters || raw.input
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = {} }
  }
  if (!args || typeof args !== 'object') {
    // Allow flat style: {"name": "collect_block", "block": "oak_log", "count": 3}
    args = {}
    for (const [k, v] of Object.entries(raw)) {
      if (!['name', 'action', 'tool', 'command', 'type'].includes(k)) args[k] = v
    }
  }
  return { name: name.trim().toLowerCase(), args }
}

function parseResponse (text) {
  const cleaned = stripNoise(text)
  const candidate = extractJsonObject(cleaned)
  const obj = candidate ? tryParse(candidate) : null

  if (!obj || typeof obj !== 'object') {
    // No usable JSON: say the plain text (if it looks like speech) and do nothing.
    const plain = cleaned.replace(/[{}[\]"]/g, '').trim()
    return { thought: '', say: plain.slice(0, 240), actions: [], parseError: true }
  }

  let actions = obj.actions ?? obj.action ?? obj.commands ?? []
  if (!Array.isArray(actions)) actions = [actions]
  actions = actions.map(normalizeAction).filter(Boolean)

  const say = obj.say ?? obj.chat ?? obj.message ?? obj.reply ?? ''
  return {
    thought: typeof obj.thought === 'string' ? obj.thought : '',
    say: typeof say === 'string' ? say.trim() : String(say),
    actions,
    parseError: false
  }
}

module.exports = { parseResponse, extractJsonObject }
