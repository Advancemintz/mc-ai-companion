'use strict'

// Watching other players, for the social system:
//   - who is where (a rolling log, for theft suspects)
//   - who opens which chest (strong evidence, both for theft and for whose base it is)
//   - who keeps hanging around which furniture, or sleeps in which bed (whose base is where)
//   - things that change feelings: gifts, being hit, being killed, someone breaking your base
//   - now and then, ideas: a disliked player is away from their base; you haven't checked your
//     chests in a while
// Nothing here acts on its own; it updates memory and tells the brain.

const W = require('../body/world')
const Z = require('../body/zones')
const SN = require('../body/sneaky')
const log = require('../util/log')

const HOME_BLOCKS = /^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|.*_bed|.*_door|anvil|enchanting_table)$/
const NOT_BUILT = /^(air|cave_air|water|lava|fire|short_grass|tall_grass|snow|.*_leaves)$/

function startSocialSenses (bot, brain, social, config) {
  if (!social) return { stop () {} }
  const mem = social.memory
  const dim = () => String(bot.game?.dimension || 'overworld').replace('minecraft:', '')
  const zones = () => Z.getZones(mem)
  const others = () => Object.values(bot.entities || {}).filter(e => e?.type === 'player' && e.username && e.username !== bot.username && e.position)
  const notice = (text, wake = false) => brain.notify(`[notice] ${text}`, wake && config.bot.autonomous !== false)
  const lastSeenAt = new Map() // player:cell -> time (for home evidence)
  const recentDigs = [] // our own digging, so we don't blame others
  let lastPlayerHurt = null // { name, at }
  const lastGift = new Map()
  let lastHitFeel = 0
  const ideaCooldown = new Map()
  let lastChestNag = 0

  // ---- chests opening: who did it?
  bot.on('chestLidMove', (block, isOpen) => {
    try {
      if (!block || !social.on() || !(isOpen > 0)) return
      if (bot.currentWindow && bot.entity.position.distanceTo(block.position) < 6) return // that's us
      const opener = others().filter(e => e.position.distanceTo(block.position) <= 6)
        .sort((a, b) => a.position.distanceTo(block.position) - b.position.distanceTo(block.position))[0]
      if (!opener) return // probably us
      const key = SN.chestKey(bot, block)
      if (Z.coOwnersAt(mem, block.position).some(n => n.toLowerCase() === opener.username.toLowerCase())) return // our shared chest
      social.recordChestOpen(key, block.position, opener.username)
      const o = social.ownerAt(block.position, dim(), { zones: zones() })
      if (o?.how === 'mine' || social.ledgerEntry(key)) {
        social.event('snooped', opener.username, 'opened my chest')
        notice(`${opener.username} just opened YOUR chest at ${block.position.x} ${block.position.y} ${block.position.z}. Check it (check_chests) if you want to know whether anything is missing.`, true)
      } else if (!o) {
        const claim = social.observeHome(opener.username, block.position, dim(), 2, 'opened a chest there')
        if (claim) notice(`It looks like ${claim.owner} lives around ${claim.x} ${claim.y} ${claim.z} (you saw them use the chests there).`)
      }
    } catch (err) { log.debug('social chest: ' + err.message) }
  })

  // ---- beds: sleeping somewhere is a strong sign it's home
  bot.on('entitySleep', (entity) => {
    try {
      if (!entity || entity.type !== 'player' || entity.username === bot.username || !social.on('ownership')) return
      const claim = social.observeHome(entity.username, entity.position, dim(), 3, 'slept there')
      if (claim) notice(`It looks like ${claim.owner} lives around ${claim.x} ${claim.y} ${claim.z} (they sleep there).`)
    } catch {}
  })

  // ---- feelings from what happens to us
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
    const p = others().filter(e => e.position.distanceTo(bot.entity.position) < 4.5)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!p || W.nearestHostile(bot, 5)) return
    lastPlayerHurt = { name: p.username, at: Date.now() }
    if (Date.now() - lastHitFeel > 5000) { lastHitFeel = Date.now(); social.event('hit', p.username, 'hit me') }
  })
  bot.on('death', () => {
    if (lastPlayerHurt && Date.now() - lastPlayerHurt.at < 10000) {
      social.event('killedMe', lastPlayerHurt.name, 'killed me')
      brain.notify(`[notice] ${lastPlayerHurt.name} killed you. You won't forget that.`, false)
      mem?.addJournal(`${lastPlayerHurt.name} killed me.`)
    }
    lastPlayerHurt = null
  })
  bot.on('playerCollect', (collector) => {
    if (collector !== bot.entity) return
    const giver = others().find(e => e.position.distanceTo(bot.entity.position) < 5)
    if (!giver || Date.now() - (lastGift.get(giver.username) || 0) < 20000) return
    lastGift.set(giver.username, Date.now())
    social.event('gift', giver.username, 'gave me something')
  })

  // ---- someone breaking your base
  bot.on('diggingCompleted', (block) => { if (block?.position) recentDigs.push({ p: block.position.clone(), at: Date.now() }) })
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    try {
      if (!oldBlock || !newBlock || !social.on() || NOT_BUILT.test(oldBlock.name) || !NOT_BUILT.test(newBlock.name)) return
      if (/^(wheat|carrots|potatoes|beetroots|torch|wall_torch)$/.test(oldBlock.name)) return // harvesting and torches come and go
      const p = oldBlock.position
      while (recentDigs.length && Date.now() - recentDigs[0].at > 4000) recentDigs.shift()
      if (recentDigs.some(d => d.p.equals?.(p))) return
      const o = social.ownerAt(p, dim(), { zones: zones() })
      if (o?.how !== 'mine') return
      const culprit = others().filter(e => e.position.distanceTo(p) <= 7)
        .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0]
      if (!culprit) return
      if (Z.coOwnersAt(mem, p).some(n => n.toLowerCase() === culprit.username.toLowerCase())) return // a teammate working on our base
      social.event('griefed', culprit.username, `broke my ${oldBlock.name}`)
      notice(`${culprit.username} broke a ${oldBlock.name} in your base at ${p.x} ${p.y} ${p.z}!`, true)
      mem?.addJournal(`${culprit.username} broke my ${oldBlock.name}.`)
    } catch (err) { log.debug('social blockUpdate: ' + err.message) }
  })

  // ---- every few seconds: who is where, and whose furniture is whose
  function watch () {
    if (!bot.entity || !social.on()) return
    const now = Date.now()
    for (const e of others()) {
      if (e.position.distanceTo(bot.entity.position) > 64) continue
      social.recordSighting(e.username, e.position)
      if (!social.on('ownership') || social.cfg().ownership.learn === false) continue
      // Hanging around furniture that isn't anyone's yet: evidence it's their home.
      const ids = Object.values(bot.registry.blocksByName).filter(b => HOME_BLOCKS.test(b.name)).map(b => b.id)
      let spots = []
      try { spots = bot.findBlocks({ matching: ids, maxDistance: 10, count: 12, point: e.position }) } catch {}
      spots = spots.filter(p => p.distanceTo(e.position) <= 10)
      if (spots.length < 2) continue
      const c = spots[0]
      const cell = `${e.username}:${Math.floor(c.x / 16)},${Math.floor(c.z / 16)}`
      if (now - (lastSeenAt.get(cell) || 0) < 45000) continue
      lastSeenAt.set(cell, now)
      if (social.ownerAt(c, dim(), { zones: zones() })) continue
      const claim = social.observeHome(e.username, c, dim(), 1, 'hanging around there')
      if (claim) notice(`It looks like ${claim.owner} lives around ${claim.x} ${claim.y} ${claim.z} (you keep seeing them there).`)
    }
  }

  // ---- now and then: ideas the personality can take or leave
  function ideas () {
    if (!bot.entity || !social.on() || brain.paused) return
    const now = Date.now()
    // Your chests haven't been checked in a while and you're home.
    const ledger = Object.values(social._store().ledger)
    if (social.on('theftDetection') && ledger.length && now - lastChestNag > 30 * 60000) {
      const near = ledger.filter(l => Math.hypot(l.x - bot.entity.position.x, l.z - bot.entity.position.z) < 24)
      const stale = near.filter(l => now - l.at > 20 * 60000)
      if (stale.length && others().length) {
        lastChestNag = now
        brain.notify(`[notice] You haven't looked in your chests for a while and other players have been around. check_chests would tell you if anything is missing.`, false)
      }
    }
    for (const f of social.feelings()) {
      if (social.isProtected(f.name) || now - (ideaCooldown.get(f.name) || 0) < 45 * 60000) continue
      const base = social.baseOf(f.name)
      if (!base || base.dimension !== dim()) continue
      const victimNear = others().find(e => e.username.toLowerCase() === f.name.toLowerCase() && Math.hypot(e.position.x - base.x, e.position.z - base.z) < 48)
      if (victimNear) continue
      const dist = Math.round(Math.hypot(base.x - bot.entity.position.x, base.z - bot.entity.position.z))
      if (dist > 300) continue
      if (social.canSabotage(f.name).ok) {
        ideaCooldown.set(f.name, now)
        brain.notify(`[revenge idea] You deeply hate ${f.name} (${f.score}) and they seem to be away from their base (${base.x} ${base.y} ${base.z}, ${dist} blocks). If it fits your personality, you could get back at them with sabotage, as long as nobody sees you. Or let it go.`, true)
        return
      }
      if (social.canSteal(f.name).ok) {
        ideaCooldown.set(f.name, now)
        brain.notify(`[sneaky idea] You dislike ${f.name} (${f.score}) and they seem to be away from their base (${base.x} ${base.y} ${base.z}, ${dist} blocks). If it fits your personality, you could help yourself to a little from their chests with steal. Only if nobody is watching, and never more than a little. Or don't.`, true)
        return
      }
    }
  }

  const iv1 = setInterval(() => { try { watch() } catch (err) { log.debug('social watch: ' + err.message) } }, 10000)
  const iv2 = setInterval(() => { try { ideas() } catch (err) { log.debug('social ideas: ' + err.message) } }, 3 * 60000)
  iv1.unref?.(); iv2.unref?.()
  bot.once('end', () => { clearInterval(iv1); clearInterval(iv2) })
  return { watch, ideas, stop () { clearInterval(iv1); clearInterval(iv2) } }
}

module.exports = { startSocialSenses }
