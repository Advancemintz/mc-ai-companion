'use strict'

// The body side of the bot's social life: whose chest is this, keeping tabs on your own chests,
// and (when feelings run that low and the operators allow it) a little stealing or sabotage.
//
// Rules the code enforces, whatever the model asks for:
//   - Stealing: only from players the bot dislikes enough (config social.stealing.feelingAtMost),
//     never from protected players, only when nobody is watching, only a modest share of the most
//     useful items, and never emptying a chest.
//   - Sabotage: only at deep hatred, never against protected players, small and non-destructive:
//     taking a few torches, harvesting ripe crops without replanting, or blocking a doorway with
//     one block. Never lava, fire, TNT or breaking walls.
//   - Every part can be switched off by the operators (config or ! commands).

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const Z = require('./zones')
const T = require('./terrain')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel']
const LIGHTS = /^(torch|wall_torch|lantern|soul_torch|soul_wall_torch|soul_lantern)$/
const RIPE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }

const fmt = (p) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
const dim = (bot) => String(bot.game?.dimension || 'overworld').replace('minecraft:', '')
const lc = (s) => String(s || '').toLowerCase()

function socialOf (ctx) {
  if (!ctx.social) throw new Error('the social system is not available')
  return ctx.social
}

// Who owns the block at pos (uses your zones for your own bases).
function ownerOf (ctx, pos) {
  if (!ctx.social) return null
  return ctx.social.ownerAt(pos, dim(ctx.bot), { zones: Z.getZones(ctx.memory) })
}

// A stable key for a chest: both halves of a double chest share one key.
function chestKey (bot, block) {
  const p = block.position
  const props = block.getProperties?.() || {}
  let best = `${p.x},${p.y},${p.z}`
  if (props.type === 'left' || props.type === 'right') {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = bot.blockAt(p.offset(d[0], 0, d[1]))
      const np = n?.getProperties?.() || {}
      if (n && n.name === block.name && np.facing === props.facing && np.type && np.type !== 'single' && np.type !== props.type) {
        const k = `${n.position.x},${n.position.y},${n.position.z}`
        if (k < best) best = k
      }
    }
  }
  return best
}

function containerCounts (container) {
  const counts = {}
  for (const i of container.containerItems()) counts[i.name] = (counts[i.name] || 0) + i.count
  return counts
}

function isMine (ctx, block) {
  const o = ownerOf(ctx, block.position)
  if (o) return o.how === 'mine'
  return !!ctx.social?.ledgerEntry(chestKey(ctx.bot, block)) // a chest you've been keeping things in
}

// Before using one of your own chests: did anything go missing since last time?
function auditOnOpen (ctx, block, container) {
  if (!ctx.social || !isMine(ctx, block)) return null
  if (Z.coOwnersAt(ctx.memory, block.position).length) { // a shared chest: others take from it too
    ctx.social.snapshotChest(chestKey(ctx.bot, block), block.position, containerCounts(container))
    return null
  }
  return ctx.social.auditChest(chestKey(ctx.bot, block), block.position, containerCounts(container))
}

// After using one of your own chests: remember how you left it. claim=true (you just put your
// things in a chest nobody owns) makes it yours from now on.
function snapshotOnClose (ctx, block, container, { claim = false } = {}) {
  if (!ctx.social) return
  const o = ownerOf(ctx, block.position)
  if (!(isMine(ctx, block) || (claim && !o))) return
  ctx.social.snapshotChest(chestKey(ctx.bot, block), block.position, containerCounts(container))
}

// The nearest chest or barrel that isn't somebody else's. Throws a helpful error otherwise.
function usableContainer (ctx, radius = 32) {
  const { bot } = ctx
  const ids = CONTAINERS.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 24 }).map(p => bot.blockAt(p)).filter(Boolean)
  if (!found.length) return null
  const others = []
  for (const b of found) {
    const o = ownerOf(ctx, b.position)
    if (!o || o.how === 'mine') return b
    others.push(o.owner)
  }
  const err = new Error(`the chests near here belong to ${[...new Set(others)].join(', ')}, not you`)
  err.othersOnly = true
  throw err
}

// Anyone (other than you) who could see `pos` or you right now. Returns names.
// checkMe=false only asks whether they can see the spot (before you've walked over there).
function witnesses (bot, pos, radius = 24, { exclude = [], checkMe = true } = {}) {
  const me = bot.entity.position
  const myEyes = me.offset(0, 1.6, 0)
  const spot = pos.offset ? pos.offset(0.5, 0.5, 0.5) : pos
  const skip = new Set(exclude.map(lc))
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.type !== 'player' || !e.username || skip.has(lc(e.username)) || e.username === bot.username) continue
    const d = checkMe ? Math.min(e.position.distanceTo(me), e.position.distanceTo(spot)) : e.position.distanceTo(spot)
    if (d > radius) continue
    const eyes = e.position.offset(0, 1.6, 0)
    if (d <= 5 || (checkMe && W.lineOfSight(bot, eyes, myEyes)) || W.lineOfSight(bot, eyes, spot)) out.push(e.username)
  }
  return out
}

// Wait (up to maxMs) for the coast to clear. Returns the remaining witnesses ([] = all clear).
async function waitForPrivacy (ctx, pos, radius, maxMs = 20000) {
  const started = Date.now()
  const look = () => witnesses(ctx.bot, pos, radius, { checkMe: false })
  let seen = look()
  while (seen.length && Date.now() - started < maxMs) {
    ctx.setStatus(`waiting for ${seen.join(', ')} to look away`)
    await ctx.sleep(Math.min(2000, maxMs))
    seen = look()
  }
  return seen
}

function setSneak (bot, on) {
  try { bot.setControlState('sneak', on) } catch {}
}

// Go near somebody's base if it's far away. Returns the base, or null if unknown.
async function approachBase (ctx, who, stopAt = 10) {
  const base = ctx.social.baseOf(who)
  if (!base) return null
  if (base.dimension && base.dimension !== dim(ctx.bot)) throw new Error(`${who}'s base is in the ${base.dimension}`)
  const here = ctx.bot.entity.position
  if (Math.hypot(base.x - here.x, base.z - here.z) > stopAt + 4) {
    ctx.setStatus(`heading toward ${who}'s base`)
    await goto(ctx, new goals.GoalNear(base.x, base.y, base.z, stopAt), 300000)
  }
  return base
}

function blocksOwnedBy (ctx, who, test, radius = 40, center = null) {
  const { bot } = ctx
  const ids = Object.values(bot.registry.blocksByName).filter(b => test(b.name)).map(b => b.id)
  if (!ids.length) return []
  const opts = { matching: ids, maxDistance: radius, count: 64 }
  if (center) opts.point = center
  return bot.findBlocks(opts).map(p => bot.blockAt(p)).filter(b => b && lc(ownerOf(ctx, b.position)?.owner) === lc(who))
}

// ------------------------------------------------------------------ actions

const stealAction = {
  description: 'Sneak a little from someone else\'s chest: checks nobody is watching, takes a modest share of the most useful items, and never empties the chest. Only works on players you dislike enough (see Social rules in STATE), never on protected players, and only when the operators allow it. With no chest given, picks one of their chests nearby (or goes to their base if you know where it is).',
  params: { from: 'whose things (player name)', x: 'optional chest x', y: 'optional', z: 'optional' },
  timeoutSeconds: 420,
  enabled: (config, social) => !social || social.on('stealing'),
  run: async (ctx, { from, x, y, z }) => {
    const { bot } = ctx
    const social = socialOf(ctx)
    const c = social.cfg()
    let victim = from
    let chest = null
    if ([x, y, z].every(v => Number.isFinite(Number(v)))) {
      chest = bot.blockAt(new Vec3(Number(x), Number(y), Number(z)))
      if (!chest || !CONTAINERS.includes(chest.name)) throw new Error(`there's no chest at ${x} ${y} ${z}`)
      const o = ownerOf(ctx, chest.position)
      if (!o || o.how === 'mine') throw new Error(o ? "that's your own chest" : "that chest isn't anyone's as far as you know; just use withdraw")
      if (victim && lc(o.owner) !== lc(victim)) throw new Error(`that chest is ${o.owner}'s, not ${victim}'s`)
      victim = o.owner
    }
    if (!victim) throw new Error('steal needs to know whose things (from)')
    const allowed = social.canSteal(victim)
    if (!allowed.ok) throw new Error(`not stealing: ${allowed.why}`)

    if (!chest) {
      let theirs = blocksOwnedBy(ctx, victim, n => CONTAINERS.includes(n), 48)
      if (!theirs.length) {
        const base = await approachBase(ctx, victim)
        if (!base) throw new Error(`I don't know where ${victim} keeps their things (no known base or chests nearby)`)
        theirs = blocksOwnedBy(ctx, victim, n => CONTAINERS.includes(n), 32, new Vec3(base.x, base.y, base.z))
      }
      if (!theirs.length) throw new Error(`couldn't find any of ${victim}'s chests`)
      const me = bot.entity.position
      chest = theirs.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    }

    // Is anyone watching? Give them a little while to wander off, otherwise back out.
    const radius = c.stealing.witnessRadius || 24
    let seen = await waitForPrivacy(ctx, chest.position, radius, (c.stealing.patienceSeconds ?? 20) * 1000)
    if (seen.length) throw new Error(`too risky: ${seen.join(', ')} could see you. Try another time`)

    ctx.setStatus(`sneaking up to ${victim}'s chest`)
    await goto(ctx, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 60000)
    setSneak(bot, true)
    try {
      seen = witnesses(bot, chest.position, radius)
      if (seen.length) throw new Error(`backed off: ${seen.join(', ')} showed up`)
      const container = await ctx.race(bot.openContainer(chest), 10000)
      const taken = {}
      try {
        const counts = containerCounts(container)
        const total = Object.values(counts).reduce((a, b) => a + b, 0)
        if (total < (c.stealing.minChestItems || 4)) throw new Error(`${victim}'s chest is nearly empty; not worth the risk`)
        const { chooseLoot } = require('../brain/social')
        const loot = chooseLoot(counts, { maxShare: c.stealing.maxShare, maxItemTypes: c.stealing.maxItemTypes })
        if (!Object.keys(loot).length) throw new Error(`nothing worth taking in ${victim}'s chest`)
        for (const [name, n] of Object.entries(loot)) {
          const item = container.containerItems().find(i => i.name === name)
          if (!item) continue
          try {
            await container.withdraw(item.type, null, n)
            taken[name] = n
          } catch (err) {
            if (/full|space/i.test(err.message)) break
          }
        }
      } finally {
        try { container.close() } catch {}
      }
      if (!Object.keys(taken).length) throw new Error(`couldn't take anything from ${victim}'s chest (my inventory may be full)`)
      // Walk off casually; whoever turned up in the meantime may have seen something.
      await ctx.sleep(400)
      const after = witnesses(bot, chest.position, radius)
      social.recordMyTheft(victim, taken, chest.position, after)
      const what = Object.entries(taken).map(([n, k]) => `${k} ${n}`).join(', ')
      return `quietly took ${what} from ${victim}'s chest at ${fmt(chest.position)}. ${after.length ? `${after.join(', ')} might have seen you` : 'Nobody saw.'}`
    } finally {
      setSneak(bot, false)
    }
  }
}

const sabotageAction = {
  description: 'Get back at someone you deeply hate, in a small way: kind "torches" (take a few of their torches), "crops" (harvest their ripe crops without replanting), "doorway" (block their door with one block), or "auto". Only at deep hatred, never against protected players, only when nobody is watching, and only if the operators allow it. Never destroys builds.',
  params: { target: 'player name', kind: 'torches | crops | doorway | auto (default)' },
  timeoutSeconds: 420,
  enabled: (config, social) => !social || social.on('sabotage'),
  run: async (ctx, { target, kind }) => {
    const { bot } = ctx
    const social = socialOf(ctx)
    const c = social.cfg()
    const allowed = social.canSabotage(target)
    if (!allowed.ok) throw new Error(`not doing it: ${allowed.why}`)
    const kinds = (c.sabotage.kinds || []).filter(k => ['torches', 'crops', 'doorway'].includes(k))
    if (!kinds.length) throw new Error('the operators have turned off every kind of sabotage')
    const want = lc(kind || 'auto')
    if (want !== 'auto' && !kinds.includes(want)) throw new Error(`"${kind}" isn't allowed. Allowed: ${kinds.join(', ')}`)
    const base = await approachBase(ctx, target, 12)
    if (!base) throw new Error(`I don't know where ${target}'s base is`)
    const center = new Vec3(base.x, base.y, base.z)
    const seen = await waitForPrivacy(ctx, center, c.sabotage.witnessRadius || c.stealing.witnessRadius || 24, (c.stealing.patienceSeconds ?? 20) * 1000)
    if (seen.length) throw new Error(`too risky: ${seen.join(', ')} could see you`)

    const max = Math.max(1, c.sabotage.maxBlocks || 6)
    const order = want === 'auto' ? kinds.slice().sort(() => Math.random() - 0.5) : [want]
    for (const k of order) {
      ctx.check()
      let done = 0
      if (k === 'torches' || k === 'crops') {
        const list = k === 'torches'
          ? blocksOwnedBy(ctx, target, n => LIGHTS.test(n), 20, center)
          : blocksOwnedBy(ctx, target, n => RIPE[n] !== undefined, 20, center).filter(b => Number(b.getProperties?.().age) >= RIPE[b.name])
        for (const b of list.slice(0, max)) {
          if (witnesses(bot, b.position, 24).length) break
          try {
            await goto(ctx, new goals.GoalLookAtBlock(b.position, bot.world), 30000)
            await ctx.race(bot.dig(bot.blockAt(b.position), true), 8000)
            done++
          } catch (err) {
            if (err instanceof CancelledError) throw err
          }
        }
        if (done) await require('./actions').helpers.pickupNearbyItems(ctx, 6)
      } else if (k === 'doorway') {
        const block = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack'].find(n => W.countItem(bot, n) > 0)
        if (!block) continue
        const doors = blocksOwnedBy(ctx, target, n => /_door$/.test(n) && n !== 'iron_door', 20, center)
          .filter(b => (b.getProperties?.().half || 'lower') === 'lower')
        for (const door of doors) {
          const f = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[door.getProperties?.().facing] || [0, 1]
          const sides = [door.position.offset(f[0], 0, f[1]), door.position.offset(-f[0], 0, -f[1])]
          // The outside is the side under open sky.
          const outside = sides.find(p => T.cover(bot, p.offset(0.5, 0, 0.5)).kind === 'outdoors') || sides[0]
          const here = bot.blockAt(outside)
          if (!here || (here.name !== 'air' && here.name !== 'cave_air')) continue
          try {
            if (await placeAt(ctx, outside, block) === 'placed') { done = 1; break }
          } catch (err) {
            if (err instanceof CancelledError) throw err
          }
        }
      }
      if (done) {
        social.recordSabotage(target, k, done, center)
        const what = k === 'torches' ? `took ${done} of ${target}'s lights` : k === 'crops' ? `harvested ${done} of ${target}'s crops and didn't replant` : `blocked ${target}'s doorway with a block`
        return `${what}. Nobody saw.`
      }
    }
    throw new Error(`found nothing to mess with at ${target}'s base (no lights, ripe crops or doorway I could reach)`)
  }
}

const checkChestsAction = {
  description: 'Go round your own chests and check nothing is missing since you last used them. Reports any theft and who the suspects are.',
  params: {},
  timeoutSeconds: 300,
  enabled: (config, social) => !social || social.on('theftDetection'),
  run: async (ctx) => {
    const { bot } = ctx
    const social = socialOf(ctx)
    const ids = CONTAINERS.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
    const mine = bot.findBlocks({ matching: ids, maxDistance: 48, count: 40 }).map(p => bot.blockAt(p)).filter(b => b && isMine(ctx, b))
    // One visit per double chest.
    const seen = new Set()
    const list = mine.filter(b => { const k = chestKey(bot, b); if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 10)
    if (!list.length) throw new Error('none of your chests are within 48 blocks')
    const reports = []
    let fresh = 0
    for (const b of list) {
      ctx.check()
      ctx.setStatus(`checking chest at ${fmt(b.position)}`)
      try {
        await goto(ctx, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), 60000)
        const had = !!social.ledgerEntry(chestKey(bot, b))
        const container = await ctx.race(bot.openContainer(b), 10000)
        try {
          const theft = auditOnOpen(ctx, b, container)
          if (theft) reports.push(social.describeTheft(theft))
          if (!had) fresh++
        } finally {
          try { container.close() } catch {}
        }
      } catch (err) {
        if (err instanceof CancelledError) throw err
      }
    }
    const tail = fresh ? ` (${fresh} not checked before; I'll know if anything goes missing from now on)` : ''
    if (!reports.length) return `checked ${list.length} chest${list.length > 1 ? 's' : ''}: nothing missing${tail}`
    return `THEFT! ${reports.join(' | ')}${tail}`
  }
}

const adjustFeelingsAction = {
  description: 'Change how you feel about a player because of something they said or did (helped you, insulted you, kept a promise, broke one). change is -15..15; big swings come from what actually happens (gifts, hits, theft) automatically.',
  params: { player: 'player name', change: 'number from -15 to 15', why: 'short reason' },
  instant: true,
  enabled: (config, social) => !social || social.on('feelings'),
  run: async (ctx, { player, change, why }) => {
    const social = socialOf(ctx)
    if (!player) throw new Error('adjust_feelings needs a player')
    const r = social.adjust(player, Number(change), why || 'how they acted', { source: 'model' })
    if (!r) throw new Error('feelings are switched off')
    if (r.capped) return `your feelings about ${player} have already moved a lot this hour; they stay at ${r.score} (${r.level})`
    return `you now feel ${r.score} (${r.level}) about ${player}${r.crossed ? ` (was ${r.before})` : ''}`
  }
}

const whoseAction = {
  description: 'Work out whose base a place (or the nearest chest) is in. Without coordinates, checks where you are standing and the nearest chest.',
  params: { x: 'optional', y: 'optional', z: 'optional' },
  instant: true,
  run: async (ctx, { x, y, z }) => {
    const { bot } = ctx
    socialOf(ctx)
    const whose = (o) => !o ? "nobody's (the wild)" : o.how === 'mine' ? 'yours' : `${o.owner}'s${o.how === 'seen' ? ' (worked out from watching them)' : ''}`
    if ([x, y, z].every(v => Number.isFinite(Number(v)))) {
      const p = new Vec3(Number(x), Number(y), Number(z))
      return `${fmt(p)} is ${whose(ownerOf(ctx, p))}`
    }
    const here = ownerOf(ctx, bot.entity.position.floored())
    const ids = CONTAINERS.map(n => bot.registry.blocksByName[n]?.id).filter(v => v !== undefined)
    const chest = bot.findBlock({ matching: ids, maxDistance: 32 })
    return `where you stand is ${whose(here)}${chest ? `; the nearest chest (${fmt(chest.position)}) is ${whose(ownerOf(ctx, chest.position))}` : ''}`
  }
}

module.exports = {
  CONTAINERS,
  chestKey,
  containerCounts,
  ownerOf,
  isMine,
  auditOnOpen,
  snapshotOnClose,
  usableContainer,
  witnesses,
  stealAction,
  sabotageAction,
  checkChestsAction,
  adjustFeelingsAction,
  whoseAction
}
