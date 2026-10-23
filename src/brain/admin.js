'use strict'

// Who is allowed to control the bot with "!" commands: the server's operators.
//
// Minecraft doesn't tell a client who is OP, so there are three ways to be recognized:
//   1. Use /say (it needs OP permission): "/say !stop" or "/say !wipe confirm".
//      Anyone who does this is remembered as an operator from then on.
//   2. Be listed in config "admins": ["Name", ...].
//   3. Point config "opsFile" at the server's ops.json (when the bot runs on the
//      same machine as the server). It is re-read every minute.
// The terminal window always counts as an operator.

const fs = require('fs')
const log = require('../util/log')

class AdminControl {
  constructor (config, memory) {
    this.config = config
    this.memory = memory
    this.fileOps = new Set()
    this._lastRead = 0
    this._readOpsFile()
  }

  _readOpsFile () {
    const file = this.config.bot.opsFile
    if (!file) return
    this._lastRead = Date.now()
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.fileOps = new Set(list.map(o => String(o.name).toLowerCase()))
    } catch (err) {
      log.warn(`Could not read opsFile ${file}: ${err.message}`)
    }
  }

  _known () {
    if (!this.memory) return []
    this.memory.data.operators = this.memory.data.operators || []
    return this.memory.data.operators
  }

  isAdmin (name) {
    if (!name) return false
    const n = String(name).toLowerCase()
    if (n === 'console') return true
    if (this.config.bot.opsFile && Date.now() - this._lastRead > 60000) this._readOpsFile()
    if ((this.config.bot.admins || []).some(a => String(a).toLowerCase() === n)) return true
    if (this.fileOps.has(n)) return true
    return this._known().includes(n)
  }

  // Someone proved they are OP (used /say) or an admin promoted them.
  grant (name) {
    const n = String(name).toLowerCase()
    const list = this._known()
    if (!list.includes(n)) {
      list.push(n)
      this.memory?.save()
      log.info(`${name} is now recognized as an operator.`)
    }
  }

  revoke (name) {
    const n = String(name).toLowerCase()
    const list = this._known()
    const i = list.indexOf(n)
    if (i !== -1) {
      list.splice(i, 1)
      this.memory?.save()
      return true
    }
    return false
  }
}

function textOf (part) {
  if (part == null) return ''
  if (typeof part === 'string') return part
  if (typeof part.toString === 'function' && part.toString !== Object.prototype.toString) return part.toString()
  return part.text || ''
}

// If a chat message came from the vanilla /say command, return { sender, text }.
// Normal players cannot produce this message type, so it proves operator rights.
function parseSayCommand (jsonMsg) {
  if (!jsonMsg) return null
  const t = jsonMsg.translate
  if (t !== '[%s] %s' && t !== 'chat.type.announcement') return null
  const args = jsonMsg.with || []
  if (args.length < 2) return null
  const sender = textOf(args[0]).trim()
  const text = textOf(args[1]).trim()
  if (!/^\w{1,16}$/.test(sender)) return null
  return { sender, text }
}

module.exports = { AdminControl, parseSayCommand }
