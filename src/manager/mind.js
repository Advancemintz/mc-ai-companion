'use strict'

// What a bot knows and feels, read from its memory file for the setup page.
// Read-only: it never writes to the file (the running bot owns it).

const fs = require('fs')
const { Memory } = require('../brain/memory')
const { SkillBook } = require('../skills/skillbook')
const { SKILLS } = require('../skills/registry')
const { Social } = require('../brain/social')

function readMind (roster, bot) {
  const file = roster.memoryFile(bot)
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (!raw) return { exists: false, file }
  const memory = new Memory(null) // no file: nothing here is ever saved
  memory.data = { ...memory.data, ...raw }
  const config = roster.buildConfig(bot)
  const skillBook = new SkillBook(memory, config)
  const social = new Social(memory, config, { botName: bot.name })

  const skills = skillBook.ids().map(id => {
    const s = skillBook.state(id)
    const t = skillBook.tier(id)
    const def = SKILLS[id]
    const next = def.tiers[t]
    return {
      id,
      label: def.label,
      tier: t,
      max: def.tiers.length,
      name: t ? def.tiers[t - 1].name : 'not learned yet',
      xp: Math.floor(s.xp),
      nextXp: next ? next.xp : null,
      nextName: next ? next.name : null,
      fixed: s.fixed !== null && s.fixed !== undefined,
      locked: !!s.locked,
      talent: config.bot.skills?.affinity?.[id] ?? 1
    }
  })
  const pos = memory.getPlace('home') || { x: 0, y: 64, z: 0 }
  return {
    exists: true,
    file,
    skills,
    feelings: social.feelings().map(f => ({ ...f, protected: social.isProtected(f.name) })),
    goals: memory.activeGoals().map(g => ({ id: g.id, text: g.text, why: g.why })),
    journal: memory.recentJournal(8).map(j => ({ at: j.at, text: j.text })),
    home: memory.getPlace('home'),
    places: Object.keys(memory.data.places || {}).length,
    finds: memory.discoveriesNear(pos, 'overworld', 8),
    explored: memory.data.explored ? Math.round(memory.exploredShare(pos, 192, 'overworld') * 100) : 0,
    thefts: social.thefts().map(t => social.describeTheft(t)),
    myThefts: social.myThefts().slice(-5).map(t => ({ victim: t.victim, items: t.items, at: t.at })),
    sabotage: social.mySabotage().slice(-5).map(t => ({ victim: t.victim, kind: t.kind, at: t.at }))
  }
}

module.exports = { readMind }
