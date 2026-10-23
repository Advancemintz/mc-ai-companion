'use strict'

// Tiny colored console logger. No dependencies.

const COLORS = {
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const debugEnabled = !!process.env.DEBUG

function paint (color, text) {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text
}

function stamp () {
  return new Date().toTimeString().slice(0, 8)
}

function make (tag, color) {
  return (...args) => console.log(paint('gray', stamp()), paint(color, `[${tag}]`), ...args)
}

module.exports = {
  info: make('info', 'cyan'),
  chat: make('chat', 'green'),
  brain: make('brain', 'magenta'),
  action: make('action', 'blue'),
  reflex: make('reflex', 'yellow'),
  warn: make('warn', 'yellow'),
  error: make('error', 'red'),
  debug: debugEnabled ? make('debug', 'gray') : () => {}
}
