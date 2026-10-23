'use strict'
// Stands in for src/index.js in the setup-page tests: reports status and echoes commands.
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
console.log(`fake bot ${cfg.minecraft.username} started`)
const status = () => process.send({ type: 'status', connected: true, health: 18, food: 15, position: { x: 1, y: 64, z: 2 }, activity: 'Current: idle', paused: false })
status()
const iv = setInterval(status, 100)
process.on('message', (m) => {
  if (m.type === 'command') console.log(`got command: ${m.text}`)
  if (m.type === 'quit') { console.log('logging off'); clearInterval(iv); process.exit(0) }
})
process.on('disconnect', () => process.exit(0))
