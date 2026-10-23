'use strict'

// The body side of teamwork (src/brain/team.js has the plans and messages):
//   team        status, propose, accept, decline, leave, share_base, deliver, collect, help
//   help_fight  go to a friend in trouble and fight what's around them
// plus two hooks the base builder calls: where the depot chest goes, and picking up deliveries.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const C = require('./combat')
const B = require('./builder')
const { goto } = require('./motion')
const { CancelledError } = require('./executor')

const lc = (s) => String(s || '').toLowerCase()
const fmt = (p) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
const CHESTS = /^(chest|barrel|trapped_chest)$/

function teamOf (ctx) {
  if (!ctx.team) throw new Error('teamwork is not available here')
  if (!ctx.team.on()) throw new Error('teamwork is switched off by the operators')
  return ctx.team
}

// The depot: just outside the front of a base, off to the side of the door.
function depotFor (proj) {
  if (!proj?.origin || !proj.f) return null
  const H = require('./homes')
  const o = new Vec3(proj.origin.x, proj.origin.y, proj.origin.z)
  const f = new Vec3(proj.f.x, 0, proj.f.z)
  const r = B.rightOf(f)
  try {
    const plan = B.toWorld(H.baseLayout(proj), o, f, r)
    const p = plan.entrance.minus(f.scaled(2)).plus(r.scaled(2))
    return [p.x, p.y, p.z]
  } catch { return null }
}

function nearestChest (bot, pos, radius = 5) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => CHESTS.test(b.name)).map(b => b.id)
  const p = bot.findBlocks({ matching: ids, maxDistance: radius, count: 1, point: pos })[0]
  return p ? bot.blockAt(p) : null
}

async function openDepot (ctx, depot, { place = false } = {}) {
  const { bot } = ctx
  const at = new Vec3(depot[0], depot[1], depot[2])
  await goto(ctx, new goals.GoalNear(at.x, at.y, at.z, 2), 120000)
  let chest = nearestChest(bot, at)
  if (!chest && place && bot.inventory.items().some(i => i.name === 'chest' || i.name === 'barrel')) {
    const item = bot.inventory.items().find(i => i.name === 'chest') || bot.inventory.items().find(i => i.name === 'barrel')
    chest = await require('./actions').helpers.placeNextToBot(ctx, item.name)
  }
  if (!chest) return null
  await goto(ctx, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 30000)
  const container = await ctx.race(bot.openContainer(chest), 10000)
  return { chest, container }
}

// Called by build_base when it starts on a shared base: take whatever teammates left in the depot.
async function collectDeliveries (ctx, projName) {
  const team = ctx.team
  const p = team?.pactForProject?.(projName)
  if (!p || !p.uncollected || !p.depot) return ''
  const { bot } = ctx
  if (bot.entity.position.distanceTo(new Vec3(p.depot[0], p.depot[1], p.depot[2])) > 128) return ''
  const { NEEDS } = require('../brain/team')
  const res = await openDepot(ctx, p.depot)
  if (!res) return ''
  const took = {}
  try {
    for (const it of res.container.containerItems()) {
      if (!Object.values(NEEDS).some(n => n.re.test(it.name))) continue
      const { type, name, count } = it // read first: the stack changes as we take it
      try { await res.container.withdraw(type, null, count); took[name] = (took[name] || 0) + count } catch {}
    }
  } finally { try { res.container.close() } catch {} }
  p.uncollected = false
  team._save()
  const list = Object.entries(took).map(([n, c]) => `${c} ${n}`).join(', ')
  return list ? ` Picked up ${list} from the depot (thanks to your teammate).` : ''
}

function pactArg (team, id, { role = null } = {}) {
  if (id) {
    const p = team.pact(id)
    if (!p) throw new Error(`no team plan #${id}`)
    return p
  }
  const list = team.activePacts().filter(p => !role || team.roleOf(p) === role)
  if (!list.length) throw new Error(role ? `you're not the ${role} in any team plan` : 'you have no active team plan')
  return list[0]
}

const teamAction = {
  description: 'Work with other bots. mode: status (plans, offers, what others are working on), propose (with + plan: build_together | you_gather | i_gather | hunt | together; goal text; project = base name for building plans), accept / decline (id), leave (id), share_base (with + project: offer a good friend co-ownership of your base), deliver (bring what your teammate\'s build needs to the depot chest), collect (pick up deliveries from the depot), help (call friends to your fight). Feelings matter: nobody teams up with someone they dislike.',
  params: { mode: 'status | propose | accept | decline | leave | share_base | deliver | collect | help', with: 'the other bot (propose, share_base)', plan: 'for propose', goal: 'what it is about (propose)', project: 'base project name (building plans, share_base)', id: 'plan id (accept, decline, leave, deliver)', why: 'optional reason (decline, leave)' },
  timeoutSeconds: 600,
  run: async (ctx, args = {}) => {
    const { bot } = ctx
    const team = teamOf(ctx)
    const mode = lc(args.mode || 'status').trim()
    if (mode === 'status') return team.status()
    if (mode === 'propose') {
      const p = team.propose(args.with, { plan: lc(args.plan || 'together'), goal: args.goal, project: args.project })
      return `asked ${args.with} to team up (#${p.id}: ${p.plan.replace('_', ' ')}${p.goal ? `, "${p.goal}"` : ''}); you'll hear back when they answer`
    }
    if (mode === 'accept') {
      const p = team.accept(args.id || team.offers()[0]?.id || '')
      if (p.plan === 'share_base') return `accepted: you now share ${p.leader}'s base "${p.project.name}" (saved as "${p.project.local}"; its chests and beds are yours too)`
      return `teamed up with ${p.leader} (#${p.id}). ${team._roleHint(p)}`
    }
    if (mode === 'decline') { const p = team.decline(args.id || team.offers()[0]?.id || '', args.why); return `turned down ${p.leader}'s offer #${p.id}` }
    if (mode === 'leave') { const p = pactArg(team, args.id); team.leave(p.id, args.why); return `left team plan #${p.id}` }
    if (mode === 'share_base') {
      const name = String(args.project || 'base').toLowerCase()
      const p = team.offerBase(args.with, name)
      return `offered ${args.with} a share of your base "${name}" (#${p.id})`
    }
    if (mode === 'help') {
      const hostiles = Object.values(bot.entities || {}).filter(e => e?.position && W.isHostile(e) && e.position.distanceTo(bot.entity.position) < 16).map(e => e.name)
      const n = team.askHelp(bot.entity.position, hostiles, { force: true })
      return n ? `called ${n} friend${n === 1 ? '' : 's'} for help` : 'no friendly bots are online to call'
    }
    if (mode === 'deliver') {
      const p = pactArg(team, args.id, { role: 'gatherer' })
      const { NEEDS, describeNeeds } = require('../brain/team')
      if (!p.needs || !Object.values(p.needs).some(n => n > 0)) throw new Error(`${p.members.find(m => !team.isMe(m))} hasn't said what the build needs yet (or it has everything)`)
      if (!p.depot) {
        const proj = ctx.memory?.getProject(p.project?.local || '')
        p.depot = depotFor(proj)
        if (!p.depot) throw new Error("I don't know where the build is")
      }
      // What we carry that the build needs.
      const give = []
      for (const [k, want] of Object.entries(p.needs)) {
        let left = want
        for (const it of bot.inventory.items()) {
          if (left <= 0 || !NEEDS[k]?.re.test(it.name)) continue
          const n = Math.min(left, it.count)
          give.push({ type: it.type, name: it.name, count: n })
          left -= n
        }
      }
      if (!give.length) throw new Error(`you carry nothing the build needs (it needs ${describeNeeds(p.needs)})`)
      ctx.setStatus('taking materials to the depot')
      const res = await openDepot(ctx, p.depot, { place: true })
      if (!res) throw new Error('there is no depot chest at the build yet and you have no chest to put down')
      const put = {}
      try {
        for (const g of give) {
          try { await res.container.deposit(g.type, null, g.count); put[g.name] = (put[g.name] || 0) + g.count } catch (err) { if (/full/i.test(err.message)) break }
        }
      } finally { try { res.container.close() } catch {} }
      if (!Object.keys(put).length) throw new Error('could not put anything in the depot chest (full?)')
      team.delivered(p.id, put, [res.chest.position.x, res.chest.position.y, res.chest.position.z])
      ctx.skills?.award('building', 3, 'brought materials for a teammate')
      const left = describeNeeds(p.needs)
      return `dropped off ${Object.entries(put).map(([n, c]) => `${c} ${n}`).join(', ')} in the depot at ${fmt(res.chest.position)}.${left ? ` Still needed: ${left}.` : ' That covers everything they asked for.'}`
    }
    if (mode === 'collect') {
      const p = pactArg(team, args.id)
      if (!p.depot) throw new Error('no depot for this plan yet')
      p.uncollected = true
      const text = await collectDeliveries(ctx, p.project?.local || '')
      return text.trim() || 'the depot chest had nothing for the build'
    }
    throw new Error(`unknown mode "${args.mode}" (status, propose, accept, decline, leave, share_base, deliver, collect, help)`)
  }
}

const helpFightAction = {
  description: 'Go to a friend or teammate who called for help and fight the monsters around them.',
  params: { player: 'who to help (default: whoever asked last)' },
  timeoutSeconds: 240,
  run: async (ctx, { player } = {}) => {
    const { bot } = ctx
    const team = ctx.team
    const req = team?.latestHelp?.(3 * 60000)
    const who = player || req?.from
    if (!who) throw new Error('nobody has asked for help')
    const friend = W.playerEntity(bot, who)
    const where = friend ? friend.position : (req && lc(req.from) === lc(who) && req.pos ? new Vec3(req.pos[0], req.pos[1], req.pos[2]) : null)
    if (!where) throw new Error(`I don't know where ${who} is`)
    team?.coming(who)
    ctx.setStatus(`running to help ${who}`)
    await goto(ctx, new goals.GoalNear(where.x, where.y, where.z, 3), 120000)
    const skill = ctx.skills?.params('combat') || C.DEFAULT_SKILL
    let kills = 0
    let quietSince = Date.now()
    const until = Date.now() + 90000
    while (Date.now() < until) {
      ctx.check()
      const center = W.playerEntity(bot, who)?.position || where
      const threats = C.nearbyThreats(bot, 20, e => e.position.distanceTo(center) < 14 && !W.NEVER_AUTO_ATTACK.has(e.name))
      if (!threats.length) {
        if (Date.now() - quietSince > 4000) break
        await ctx.sleep(500)
        continue
      }
      const target = C.pickTarget(bot, threats, skill)
      if (!target) break
      ctx.setStatus(`fighting ${W.entityLabel(target)} next to ${who}`)
      const st = await C.engage(bot, target, { skill, sleep: ctx.sleep, check: ctx.check, maxMs: 30000, switchTargets: true, onStatus: (t) => ctx.setStatus(t) })
      kills += st.kills || (st.killed ? 1 : 0)
      quietSince = Date.now()
    }
    if (kills) ctx.skills?.award('combat', kills * 4, `helped ${who} in a fight`)
    team?.helped(who, kills)
    return kills ? `helped ${who}: killed ${kills} monster${kills === 1 ? '' : 's'}; all clear now` : `got to ${who}; no monsters left around them`
  }
}

module.exports = { teamAction, helpFightAction, collectDeliveries, depotFor, nearestChest }
