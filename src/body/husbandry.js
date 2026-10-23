'use strict'

// Looking after animals the way a player does.
//
// Livestock: pens get regular "ranch rounds" (tend_animals). The bot counts the herd (adults and
// young), breeds when there is room and the animals are ready again (vanilla: 5 minutes), keeps
// the herd at a sensible size (a skilled farmer culls the extra adults for meat, never the young
// and never below a breeding pair), shears sheep, milks a cow when it has an empty bucket,
// collects eggs, throws spare eggs for chicks, mends gaps in the fence and goes after anything
// that slipped out while the gate was open.
//
// Your own animals are safe from yourself: hunting skips animals in your pens, anyone's pets and
// named animals, and animals in somebody else's base.
//
// Pets: tame a wolf (bones), cat (raw cod or salmon) or parrot (seeds), give it a name, tell it
// to sit or follow, heal a hurt dog with meat, or take everyone home and sit them there.
//
// Entity metadata indices are for Minecraft 1.20.2+ (they move between versions); all reads go
// through META so they can be adjusted in one place.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const W = require('./world')
const { goto, placeAt } = require('./motion')
const { CancelledError } = require('./executor')
const R = require('./ranch')

const META = { name: 2, health: 9, baby: 16, sheep: 17, tameFlags: 17, owner: 18 }
const TAMEABLE = new Set(['wolf', 'cat', 'parrot', 'horse', 'donkey', 'mule', 'llama', 'camel'])
const LIVESTOCK = new Set(['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit', 'goat'])
const MILKABLE = new Set(['cow', 'mooshroom', 'goat'])
const BREED_COOLDOWN_MIN = 5

const PET_FOOD = {
  wolf: { tame: ['bone'], heal: ['rotten_flesh', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit'], word: 'dog' },
  cat: { tame: ['cod', 'salmon'], heal: ['cod', 'salmon'], word: 'cat' },
  parrot: { tame: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'], heal: [], word: 'parrot' }
}
const PET_NAMES = ['Biscuit', 'Rex', 'Patch', 'Shadow', 'Pepper', 'Mochi', 'Scout', 'Luna', 'Bean', 'Ziggy', 'Nugget', 'Socks', 'Pickle', 'Waffles', 'Rusty', 'Juno']
const SHEEP_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

const count = (bot, re) => bot.inventory.items().filter(i => (typeof re === 'string' ? i.name === re : re.test(i.name))).reduce((n, i) => n + i.count, 0)
const lc = (s) => String(s || '').toLowerCase()
const fmt = (p) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
const minsSince = (iso) => iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity
const pickup = (ctx, r = 6) => require('./actions').helpers.pickupNearbyItems(ctx, r)
const PLURALS = { cows: 'cow', cattle: 'cow', calf: 'cow', calves: 'cow', sheep: 'sheep', lamb: 'sheep', lambs: 'sheep', pigs: 'pig', piglet: 'pig', piglets: 'pig',
  chickens: 'chicken', chick: 'chicken', chicks: 'chicken', hens: 'chicken', hen: 'chicken', rabbits: 'rabbit', bunny: 'rabbit', bunnies: 'rabbit', goats: 'goat',
  mooshrooms: 'mooshroom', wolves: 'wolf', dog: 'wolf', dogs: 'wolf', puppy: 'wolf', puppies: 'wolf', cats: 'cat', kitten: 'cat', kittens: 'cat', kitty: 'cat',
  parrots: 'parrot', horses: 'horse', llamas: 'llama' }
const kindOf = (s) => { const k = lc(s).trim().replace(/\s+/g, '_'); return PLURALS[k] || k }

// ------------------------------------------------------------------ reading animals

function chatText (v) {
  if (v === undefined || v === null || v === false) return ''
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); return chatText(j) } catch { return v }
  }
  if (typeof v === 'object') return String(v.text ?? v.translate ?? '') + (Array.isArray(v.extra) ? v.extra.map(chatText).join('') : '')
  return String(v)
}

// What you can tell about an animal by looking at it.
function animalState (e) {
  const m = e?.metadata || []
  const out = { kind: e?.name, baby: m[META.baby] === true, name: chatText(m[META.name]) || null, health: typeof m[META.health] === 'number' ? m[META.health] : null }
  if (e?.name === 'sheep' && typeof m[META.sheep] === 'number') {
    out.sheared = (m[META.sheep] & 0x10) !== 0
    out.color = SHEEP_COLORS[m[META.sheep] & 0x0f]
  } else if (e?.name === 'sheep') out.sheared = false
  if (TAMEABLE.has(e?.name)) {
    const f = typeof m[META.tameFlags] === 'number' ? m[META.tameFlags] : 0
    out.tamed = (f & 0x04) !== 0
    out.sitting = (f & 0x01) !== 0
    const owner = m[META.owner]
    out.owner = owner ? String(typeof owner === 'object' ? (owner.uuid || owner.value || '') : owner) : null
  }
  return out
}

function myUuid (bot) {
  return bot.player?.uuid || bot.entity?.uuid || null
}

function isMyPet (bot, e) {
  const s = animalState(e)
  const me = myUuid(bot)
  return !!(s.tamed && s.owner && me && lc(s.owner) === lc(me))
}

function myPens (memory) {
  return Object.entries(memory?.data?.projects || {}).filter(([, p]) => p.style === 'pen' && p.corner)
    .map(([key, p]) => ({ key, ...p, cornerVec: new Vec3(p.corner.x, p.corner.y, p.corner.z) }))
}

function penOf (memory, e) {
  if (!e?.position) return null
  const at = e.position.floored()
  return myPens(memory).find(p => R.penInside(p.cornerVec, at) && Math.abs(e.position.y - p.corner.y - 1) < 3) || null
}

// Why the bot shouldn't kill this animal on a hunt, or null if it's fair game.
function protectedReason (ctx, e, { ignorePens = false } = {}) {
  if (!e || e.type === 'player') return null
  const { bot } = ctx
  const s = animalState(e)
  if (s.tamed) return isMyPet(bot, e) ? 'your pet' : 'someone\'s pet'
  if (s.name) return `named "${s.name}" (somebody cares about it)`
  if (!ignorePens && penOf(ctx.memory, e)) return 'in your pen (thin the herd with tend_animals instead)'
  if (ctx.social && LIVESTOCK.has(e.name)) {
    try {
      const o = require('./sneaky').ownerOf(ctx, e.position.floored())
      if (o && o.how !== 'mine' && o.how !== 'public') return `${o.owner}'s animal (it's in their base)`
    } catch {}
  }
  return null
}

// A short tag for perception: "baby", "sheared", "your dog Rex", "tamed".
function animalTag (bot, e, memory = null) {
  const s = animalState(e)
  const tags = []
  if (s.baby) tags.push('baby')
  if (s.sheared) tags.push('sheared')
  if (s.tamed) {
    if (isMyPet(bot, e)) {
      const pet = petRecord(memory, e)
      tags.push(`your ${PET_FOOD[e.name]?.word || e.name}${pet?.name ? ` ${pet.name}` : ''}${s.sitting ? ', sitting' : ''}`)
    } else tags.push('someone\'s pet')
  } else if (s.name) tags.push(`named ${s.name}`)
  if (memory && penOf(memory, e)) tags.push('in your pen')
  return tags.join(', ')
}

// ------------------------------------------------------------------ herd decisions

// Pure: what a round at one pen should do. Inputs are counts; nothing here touches the world.
//   params: { breed, cull, cap, keepAdults, shear, milk, eggThrow }
function planRound ({ kind, adults, babies, food = 0, shears = false, unsheared = 0, buckets = 0, hasMilk = false, eggs = 0, minutesSinceBred = Infinity, wantMeat = false, params = {} }) {
  const p = { breed: true, cull: false, cap: 8, keepAdults: 2, shear: true, milk: true, eggThrow: false, ...params }
  const total = adults + babies
  const room = Math.max(0, p.cap - total)
  const out = { breedPairs: 0, cull: 0, shear: 0, milk: false, collect: kind === 'chicken', throwEggs: 0, notes: [] }
  // Breeding: room in the pen, two ready adults, two of their food per pair.
  if (p.breed && adults >= 2 && room > 0) {
    if (minutesSinceBred < BREED_COOLDOWN_MIN) out.notes.push(`bred ${Math.round(minutesSinceBred)} min ago; they need about ${BREED_COOLDOWN_MIN} minutes before they'll breed again`)
    else if (food < 2) out.notes.push('no food to breed them with')
    else out.breedPairs = Math.min(Math.floor(adults / 2), Math.floor(food / 2), room)
  }
  // Herd size: extra adults go for meat (only a skilled farmer does this; never the young).
  const over = total - p.cap
  const spare = Math.max(0, adults - p.keepAdults)
  if (over > 0) {
    if (p.cull) out.cull = Math.min(over, spare)
    else out.notes.push(`the pen is crowded (${total}/${p.cap})`)
  } else if (p.cull && wantMeat && adults > p.keepAdults + 2) out.cull = 1 // hungry: one for the pot
  if (out.cull && out.breedPairs) out.breedPairs = 0 // no point breeding while thinning the herd
  if (kind === 'sheep' && p.shear) {
    if (unsheared && shears) out.shear = unsheared
    else if (unsheared) out.notes.push('the sheep have wool but you have no shears (2 iron ingots)')
  }
  if (MILKABLE.has(kind) && p.milk && buckets > 0 && !hasMilk && adults > 0) out.milk = true
  if (kind === 'chicken' && p.eggThrow && eggs >= 4 && room > 0) out.throwEggs = Math.min(eggs, 8, room * 4)
  return out
}

function herdOf (bot, pen) {
  const all = R.animalsInPen(bot, pen.kind, pen.cornerVec || new Vec3(pen.corner.x, pen.corner.y, pen.corner.z))
  const adults = []
  const babies = []
  for (const e of all) (animalState(e).baby ? babies : adults).push(e)
  return { all, adults, babies }
}

function ranchParams (ctx, args = {}) {
  const skill = ctx.skills?.params('farming') || { breed: true, cull: true, leads: true, eggThrow: true }
  const cfg = { herdSize: 8, keepAdults: 2, cull: true, milk: true, shear: true, ...(ctx.config?.ranch || {}) }
  const noCull = /^(no|false|off|0|never)$/i.test(String(args.cull ?? ''))
  return {
    breed: skill.breed !== false,
    cull: !!skill.cull && cfg.cull !== false && !noCull,
    cap: cfg.herdSize,
    keepAdults: Math.max(2, cfg.keepAdults || 2),
    shear: cfg.shear !== false,
    milk: cfg.milk !== false,
    eggThrow: !!skill.eggThrow,
    leads: !!skill.leads
  }
}

// ------------------------------------------------------------------ working in a pen

function gateSpots (corner) {
  const gate = R.penGate(corner)
  return { gate, outside: gate.offset(0, 0, 2), inside: gate.offset(0, 0, -1), middle: corner.offset(3, 1, 3) }
}

async function enterPen (ctx, corner) {
  const s = gateSpots(corner)
  await goto(ctx, new goals.GoalNear(s.outside.x, s.outside.y, s.outside.z, 1), 60000)
  await R.setGap(ctx, corner, true)
  await goto(ctx, new goals.GoalNear(s.inside.x, s.inside.y, s.inside.z, 0.5), 20000)
  await R.setGap(ctx, corner, false) // shut it behind you so nothing wanders off
}

async function leavePen (ctx, corner) {
  const s = gateSpots(corner)
  try { await ctx.bot.unequip('hand') } catch {} // don't lead them out with food in your hand
  await goto(ctx, new goals.GoalNear(s.inside.x, s.inside.y, s.inside.z, 0.5), 20000)
  await R.setGap(ctx, corner, true)
  await goto(ctx, new goals.GoalNear(s.outside.x, s.outside.y, s.outside.z, 1), 20000)
  await R.setGap(ctx, corner, false)
}

// Fill holes in the fence (creepers, griefers...). Returns how many posts were put back.
async function mendFence (ctx, corner) {
  const { bot } = ctx
  const gate = R.penGate(corner)
  let mended = 0
  let missing = 0
  for (const p of R.penRing(corner)) {
    if (p.equals(gate)) continue
    const b = bot.blockAt(p)
    if (!b || /_fence/.test(b.name) || !R.OPEN(b)) continue
    const fence = bot.inventory.items().find(i => /_fence$/.test(i.name))
    if (!fence) { missing++; continue }
    try { if (await placeAt(ctx, p, fence.name, { solid: false }) === 'placed') mended++ } catch (err) { if (err instanceof CancelledError) throw err }
  }
  return { mended, missing }
}

const alive = (bot, e) => !!bot.entities[e.id] && e.isValid !== false && !(typeof e.metadata?.[META.health] === 'number' && e.metadata[META.health] <= 0)

async function interact (ctx, e, itemName) {
  const { bot } = ctx
  if (!alive(bot, e)) return false
  try { await goto(ctx, new goals.GoalFollow(e, 1.5), 8000) } catch (err) { if (err instanceof CancelledError) throw err }
  if (itemName) {
    const it = bot.inventory.items().find(i => i.name === itemName)
    if (!it) return false
    await bot.equip(it, 'hand')
  } else {
    try { await bot.unequip('hand') } catch {}
  }
  try { await bot.activateEntity(e) } catch { return false }
  await ctx.sleep(250)
  return true
}


async function slaughter (ctx, e) {
  const { bot } = ctx
  const weapon = W.bestWeapon(bot)
  if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
  const cooldown = require('./combat').attackCooldownMs(weapon)
  const until = Date.now() + 20000
  while (alive(bot, e) && Date.now() < until) {
    ctx.check()
    if (e.position.distanceTo(bot.entity.position) > 3) {
      try { await goto(ctx, new goals.GoalFollow(e, 1.5), 5000) } catch (err) { if (err instanceof CancelledError) throw err }
    }
    try { await bot.lookAt?.(e.position.offset(0, (e.height || 1) * 0.6, 0)) } catch {}
    bot.attack(e)
    await ctx.sleep(cooldown)
  }
  return !alive(bot, e)
}

function bestFood (bot, foods) {
  let best = null
  for (const f of foods) {
    const n = count(bot, f)
    if (n >= 2 && (!best || n > best.n)) best = { name: f, n }
  }
  return best
}

// One round at one pen. Returns { line, stats }.
async function tendPen (ctx, pen, params, { wantMeat = false } = {}) {
  const { bot } = ctx
  const mem = ctx.memory
  const { ANIMAL_FOOD } = require('./farming')
  const kind = pen.kind
  const corner = pen.cornerVec
  const foods = ANIMAL_FOOD[kind] || []
  const s = gateSpots(corner)
  const stats = { bred: 0, culled: 0, sheared: 0, milked: 0, eggs: 0, thrown: 0, mended: 0, chased: 0 }
  const notes = []
  ctx.setStatus(`checking the ${kind} pen`)
  await goto(ctx, new goals.GoalNear(s.outside.x, s.outside.y, s.outside.z, 2), 90000)

  const fence = await mendFence(ctx, corner)
  stats.mended = fence.mended
  if (fence.missing) notes.push(`${fence.missing} gap${fence.missing === 1 ? '' : 's'} in the fence and no fences to fix ${fence.missing === 1 ? 'it' : 'them'}`)

  const herd = herdOf(bot, pen)
  const food = foods.reduce((n, f) => n + count(bot, f), 0)
  const unsheared = kind === 'sheep' ? herd.adults.filter(e => !animalState(e).sheared).length : 0
  const plan = planRound({
    kind,
    adults: herd.adults.length,
    babies: herd.babies.length,
    food,
    shears: count(bot, 'shears') > 0,
    unsheared,
    buckets: count(bot, 'bucket'),
    hasMilk: count(bot, 'milk_bucket') > 0,
    eggs: count(bot, 'egg'),
    minutesSinceBred: minsSince(pen.lastBred),
    wantMeat,
    params: { ...params, cap: pen.cap || params.cap }
  })
  notes.push(...plan.notes)
  const nothing = !plan.breedPairs && !plan.cull && !plan.shear && !plan.milk && !plan.collect && !plan.throwEggs
  const outsideBefore = new Set(Object.values(bot.entities || {}).filter(e => e?.name === kind && e.position && e.position.distanceTo(corner) < 16 && !R.penInside(corner, e.position.floored())).map(e => e.id))

  if (!nothing && herd.all.length) {
    await enterPen(ctx, corner)
    try {
      // Shearing and milking first: they don't upset anyone.
      if (plan.shear) {
        ctx.setStatus('shearing sheep')
        for (const e of herd.adults.filter(x => !animalState(x).sheared).slice(0, plan.shear)) {
          ctx.check()
          if (await interact(ctx, e, 'shears')) stats.sheared++
        }
      }
      if (plan.milk) {
        const cow = herd.adults[0]
        const before = count(bot, 'milk_bucket')
        if (cow && await interact(ctx, cow, 'bucket') && count(bot, 'milk_bucket') > before) stats.milked++
      }
      // Thin the herd before breeding (planRound never asks for both).
      if (plan.cull) {
        ctx.setStatus(`thinning the ${kind} herd`)
        const victims = herd.adults.filter(e => !animalState(e).name).slice(0, plan.cull)
        for (const e of victims) if (await slaughter(ctx, e)) stats.culled++
      }
      if (plan.breedPairs) {
        ctx.setStatus(`breeding ${kind}s`)
        const ready = herd.adults.filter(e => alive(bot, e))
        for (let i = 0; i < plan.breedPairs; i++) {
          const f = bestFood(bot, foods)
          if (!f) break
          const pair = ready.slice(i * 2, i * 2 + 2)
          if (pair.length < 2) break
          let fed = 0
          for (const e of pair) if (await interact(ctx, e, f.name)) fed++
          if (fed === 2) stats.bred++
        }
        if (stats.bred) await ctx.sleep(1500) // hearts, then a baby
      }
      if (plan.throwEggs) {
        const egg = bot.inventory.items().find(i => i.name === 'egg')
        if (egg) {
          await bot.equip(egg, 'hand')
          try { await bot.lookAt(s.middle.offset(0.5, 0, 0.5)) } catch {}
          for (let i = 0; i < plan.throwEggs && count(bot, 'egg') > 0; i++) { bot.activateItem(); stats.thrown++; await ctx.sleep(300) }
        }
      }
      // Eggs, wool, meat, feathers: everything on the ground in the pen.
      const before = { egg: count(bot, 'egg'), wool: count(bot, /_wool$/) }
      await goto(ctx, new goals.GoalNear(s.middle.x, s.middle.y, s.middle.z, 1), 10000)
      await pickup(ctx, 5)
      stats.eggs = Math.max(0, count(bot, 'egg') - before.egg)
    } finally {
      await leavePen(ctx, corner)
    }
  }

  // Anything slip out while the gate was open? Bring it back.
  const escaped = Object.values(bot.entities || {}).filter(e => e?.name === kind && e.position && !outsideBefore.has(e.id) && e.position.distanceTo(corner) < 20 &&
    !R.penInside(corner, e.position.floored()) && !protectedReason(ctx, e, { ignorePens: true }))
  if (escaped.length) {
    const target = R.animalsInPen(bot, kind, corner).length + escaped.length
    stats.chased = await R.lureInto(ctx, corner, kind, foods, target, [], { leads: params.leads })
    if (stats.chased < escaped.length) notes.push(`${escaped.length - stats.chased} ${kind}${escaped.length - stats.chased === 1 ? '' : 's'} got out and I couldn't get ${escaped.length - stats.chased === 1 ? 'it' : 'them'} back`)
  }

  // Bookkeeping.
  const now = herdOf(bot, pen)
  const proj = mem?.getProject(pen.key) || pen
  proj.lastRound = new Date().toISOString()
  if (stats.bred) proj.lastBred = proj.lastRound
  proj.herd = { adults: now.adults.length, babies: now.babies.length }
  proj.lastCount = now.all.length
  const t = proj.totals || {}
  for (const [k, v] of Object.entries({ born: stats.bred, culled: stats.culled, sheared: stats.sheared, milked: stats.milked, eggs: stats.eggs })) if (v) t[k] = (t[k] || 0) + v
  proj.totals = t
  if (mem) mem.saveProject(pen.key, (({ cornerVec, key, ...rest }) => rest)(proj))

  const xp = stats.bred * 6 + stats.sheared + stats.culled * 2 + stats.eggs * 0.5 + stats.milked + stats.mended * 0.5 + stats.chased * 2
  if (xp) ctx.skills?.award('farming', xp, `tended the ${kind} pen`)

  const did = []
  if (stats.bred) did.push(`bred ${stats.bred} pair${stats.bred === 1 ? '' : 's'}`)
  if (stats.sheared) did.push(`sheared ${stats.sheared}`)
  if (stats.milked) did.push('got a bucket of milk')
  if (stats.culled) did.push(`culled ${stats.culled} for meat`)
  if (stats.eggs) did.push(`collected ${stats.eggs} egg${stats.eggs === 1 ? '' : 's'}`)
  if (stats.thrown) did.push(`threw ${stats.thrown} eggs for chicks`)
  if (stats.mended) did.push(`mended ${stats.mended} fence post${stats.mended === 1 ? '' : 's'}`)
  if (stats.chased) did.push(`brought back ${stats.chased} that got out`)
  const herdLine = `${now.adults.length} adult${now.adults.length === 1 ? '' : 's'}${now.babies.length ? ` + ${now.babies.length} young` : ''}`
  return { line: `${kind} pen (${herdLine}): ${did.length ? did.join(', ') : 'nothing to do'}${notes.length ? ` [${notes.join('; ')}]` : ''}`, stats }
}

// ------------------------------------------------------------------ actions

const tendAnimalsAction = {
  description: 'A round of your animal pens: count the herd, breed when there is room (they need ~5 min between breedings), keep the herd at a good size (skilled farmers cull extra adults for meat, never the young), shear sheep (shears), milk a cow (empty bucket), collect eggs, mend the fence and bring back escapees. Carry the animals\' food (wheat, carrots, seeds).',
  params: { animal: 'optional: just this pen (cow, sheep, pig, chicken...)', herd_size: 'optional: how many animals this pen should hold', cull: 'optional: "no" to never cull this round' },
  timeoutSeconds: 900,
  run: async (ctx, args = {}) => {
    const { bot } = ctx
    const mem = ctx.memory
    let pens = myPens(mem)
    if (!pens.length) throw new Error('you have no animal pens yet: build one with build_pen')
    if (args.animal) {
      const k = kindOf(args.animal)
      pens = pens.filter(p => p.kind === k)
      if (!pens.length) throw new Error(`you have no ${k} pen (your pens: ${myPens(mem).map(p => p.kind).join(', ')})`)
    }
    const params = ranchParams(ctx, args)
    const size = Math.round(Number(args.herd_size))
    if (Number.isFinite(size) && size >= 2) {
      for (const p of pens) { p.cap = Math.min(16, size); const proj = mem?.getProject(p.key); if (proj) { proj.cap = p.cap; mem.saveProject(p.key, proj) } }
    }
    const SV = require('./survival')
    const wantMeat = (bot.food ?? 20) <= 14 && SV.readyFood(bot) < 12
    pens.sort((a, b) => a.cornerVec.distanceTo(bot.entity.position) - b.cornerVec.distanceTo(bot.entity.position))
    const lines = []
    for (const pen of pens) {
      ctx.check()
      try {
        const r = await tendPen(ctx, pen, params, { wantMeat })
        lines.push(r.line)
      } catch (err) {
        if (err instanceof CancelledError) throw err
        lines.push(`${pen.kind} pen: couldn't finish (${err.message})`)
      }
    }
    return lines.join('. ') + '.'
  }
}

function petRecord (memory, e) {
  const pets = memory?.data?.pets || []
  return pets.find(p => (e.uuid && p.uuid === e.uuid) || (p.entityId === e.id && p.kind === e.name)) || null
}

function savePet (memory, e, name) {
  if (!memory) return null
  memory.data.pets = memory.data.pets || []
  let rec = petRecord(memory, e)
  if (!rec) {
    rec = { kind: e.name, uuid: e.uuid || null, entityId: e.id, name, tamedAt: new Date().toISOString() }
    memory.data.pets.push(rec)
  } else if (name) rec.name = name
  rec.entityId = e.id
  rec.lastSeen = { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }
  memory.save?.()
  return rec
}

function myPetsNearby (ctx, radius = 48) {
  const { bot } = ctx
  return Object.values(bot.entities || {}).filter(e => e?.position && TAMEABLE.has(e.name) && isMyPet(bot, e) && e.position.distanceTo(bot.entity.position) <= radius)
}

function pickName (memory, kind) {
  const used = new Set((memory?.data?.pets || []).map(p => lc(p.name)))
  const free = PET_NAMES.filter(n => !used.has(lc(n)))
  return (free.length ? free : PET_NAMES)[Math.floor(Math.random() * (free.length || PET_NAMES.length))]
}

const tameAction = {
  description: 'Tame a pet: a wolf with bones (several tries), a cat with raw cod or salmon (approach slowly; cats are shy), or a parrot with seeds. Give it a name if you like. Tamed dogs follow you and fight for you; leave them sitting at home before dangerous trips.',
  params: { animal: 'wolf | cat | parrot', name: 'optional name for your new pet' },
  timeoutSeconds: 180,
  run: async (ctx, { animal, name }) => {
    const { bot } = ctx
    const kind = kindOf(animal || 'wolf')
    const food = PET_FOOD[kind]
    if (!food) throw new Error(`I can tame a wolf, a cat or a parrot, not "${animal}"`)
    const treat = () => bot.inventory.items().find(i => food.tame.includes(i.name))
    if (!treat()) throw new Error(`taming a ${kind} needs ${food.tame.join(' or ')}`)
    const candidates = Object.values(bot.entities || {}).filter(e => e?.name === kind && e.position && !animalState(e).tamed && !animalState(e).baby && e.position.distanceTo(bot.entity.position) < 40)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (!candidates.length) throw new Error(`no wild ${kind} within 40 blocks${kind === 'wolf' ? ' (wolves live in forests and taigas)' : kind === 'cat' ? ' (stray cats live in villages)' : ' (parrots live in jungles)'}`)
    const e = candidates[0]
    ctx.setStatus(`taming a ${kind}`)
    let tries = 0
    if (kind === 'cat') {
      // Hold the fish, creep up, then stand still and let it come to you.
      try { bot.setControlState?.('sneak', true) } catch {}
      try {
        await bot.equip(treat(), 'hand')
        try { await goto(ctx, new goals.GoalFollow(e, 5), 20000) } catch (err) { if (err instanceof CancelledError) throw err }
        const until = Date.now() + 25000
        while (Date.now() < until && e.position.distanceTo(bot.entity.position) > 2.5) { ctx.check(); await ctx.sleep(500) }
        if (e.position.distanceTo(bot.entity.position) > 2.5) {
          try { await goto(ctx, new goals.GoalFollow(e, 1.5), 8000) } catch (err) { if (err instanceof CancelledError) throw err }
        }
      } finally { try { bot.setControlState?.('sneak', false) } catch {} }
    }
    while (!animalState(e).tamed && treat() && tries < 14 && alive(bot, e)) {
      ctx.check()
      tries++
      await interact(ctx, e, treat().name)
      await ctx.sleep(400)
    }
    if (!animalState(e).tamed) {
      throw new Error(alive(bot, e) ? `the ${kind} still isn't tame after ${tries} ${food.tame[0]}${tries === 1 ? '' : 's'}${treat() ? '' : '; I ran out'}. Bring more and try again` : `the ${kind} wandered off`)
    }
    const petName = String(name || '').trim().slice(0, 24) || pickName(ctx.memory, kind)
    savePet(ctx.memory, e, petName)
    ctx.memory?.addJournal?.(`Tamed a ${kind} and named it ${petName}.`)
    ctx.skills?.award('farming', 8, `tamed a ${kind}`)
    return `tamed a ${kind} after ${tries} ${food.tame[0]}${tries === 1 ? '' : 's'} and named it ${petName}. ${kind === 'wolf' ? 'It follows you and fights what attacks you; tell it to sit (pet) before a Nether trip or a deep cave.' : kind === 'cat' ? 'Cats keep creepers and phantoms away from your base.' : 'Parrots ride on your shoulder.'}`
  }
}

const petAction = {
  description: 'Look after your pets: "list" (who is around, how they are), "sit" or "follow" (one by name, or all nearby), "feed" (heal hurt dogs with meat, cats with fish), "home" (walk home with them and sit them there), "name" (rename one: name + new_name).',
  params: { mode: 'list | sit | follow | feed | home | name', name: 'optional: which pet', new_name: 'for mode name' },
  timeoutSeconds: 300,
  run: async (ctx, { mode = 'list', name, new_name: newName }) => {
    const { bot } = ctx
    const mem = ctx.memory
    const m = lc(mode).trim()
    const near = myPetsNearby(ctx)
    for (const e of near) savePet(mem, e, petRecord(mem, e)?.name || pickName(mem, e.name))
    const known = mem?.data?.pets || []
    const pick = name ? near.filter(e => lc(petRecord(mem, e)?.name) === lc(name)) : near
    const label = (e) => `${petRecord(mem, e)?.name || 'your ' + e.name} the ${PET_FOOD[e.name]?.word || e.name}`
    if (m === 'list') {
      if (!known.length && !near.length) return 'you have no pets yet (tame a wolf with bones, a cat with fish, a parrot with seeds)'
      const here = near.map(e => { const s = animalState(e); return `${label(e)} (${s.sitting ? 'sitting' : 'following'}${s.health !== null ? `, health ${Math.round(s.health)}/${e.name === 'wolf' ? 40 : 10}` : ''})` })
      const away = known.filter(p => !near.some(e => petRecord(mem, e) === p)).map(p => `${p.name} the ${PET_FOOD[p.kind]?.word || p.kind}${p.lastSeen ? ` (last seen at ${p.lastSeen.x} ${p.lastSeen.y} ${p.lastSeen.z})` : ''}`)
      return [here.length ? `With you: ${here.join(', ')}` : 'None of your pets are nearby', away.length ? `Elsewhere: ${away.join(', ')}` : ''].filter(Boolean).join('. ')
    }
    if (!pick.length) throw new Error(name ? `${name} isn't nearby` : 'none of your pets are nearby')
    if (m === 'name') {
      if (!newName) throw new Error('give the new name as new_name')
      const e = pick[0]
      savePet(mem, e, String(newName).slice(0, 24))
      return `${e.name} is now called ${newName}${count(bot, 'name_tag') ? ' (put it on a name tag at an anvil to make it official)' : ''}`
    }
    if (m === 'sit' || m === 'follow' || m === 'stand') {
      const wantSit = m === 'sit'
      const changed = []
      for (const e of pick) {
        if (animalState(e).sitting === wantSit) continue
        if (await interact(ctx, e, null)) changed.push(label(e))
      }
      return changed.length ? `${changed.join(', ')} ${wantSit ? 'sat down' : 'got up to follow you'}` : `${wantSit ? 'already sitting' : 'already following'}`
    }
    if (m === 'feed') {
      const fed = []
      for (const e of pick) {
        const s = animalState(e)
        const max = e.name === 'wolf' ? 40 : 10
        const heal = PET_FOOD[e.name]?.heal || []
        let n = 0
        while (s.health !== null && (animalState(e).health ?? max) < max - 2 && n < 6) {
          const f = bot.inventory.items().find(i => heal.includes(i.name))
          if (!f) break
          await interact(ctx, e, f.name)
          n++
        }
        if (n) fed.push(`${label(e)} (${n})`)
      }
      return fed.length ? `fed ${fed.join(', ')}` : 'nobody needed feeding (or you have nothing they eat)'
    }
    if (m === 'home') {
      const home = mem?.getPlace('home')
      if (!home) throw new Error('you have no home saved yet')
      for (const e of pick) if (animalState(e).sitting) await interact(ctx, e, null) // get up and come along
      await goto(ctx, new goals.GoalNear(home.x, home.y, home.z, 2), 180000)
      await ctx.sleep(2000) // let them catch up (tamed pets teleport to you if they fall behind)
      const sat = []
      for (const e of myPetsNearby(ctx, 16)) {
        if (!animalState(e).sitting && await interact(ctx, e, null)) sat.push(label(e))
        savePet(mem, e)
      }
      return sat.length ? `brought ${sat.join(', ')} home; they're sitting there now and won't follow you into danger` : 'went home, but the pets didn\'t keep up'
    }
    throw new Error(`unknown mode "${mode}" (list, sit, follow, feed, home, name)`)
  }
}

// Lines for the memory summary.
function summaryLines (memory) {
  const lines = []
  for (const p of myPens(memory)) {
    const h = p.herd
    const ago = Number.isFinite(minsSince(p.lastRound)) ? Math.round(minsSince(p.lastRound)) : null
    const t = p.totals || {}
    const made = ['born', 'sheared', 'eggs', 'culled'].filter(k => t[k]).map(k => `${t[k]} ${k}`).join(', ')
    lines.push(`Your ${p.kind} pen at ${p.corner.x} ${p.corner.y} ${p.corner.z}: ${h ? `${h.adults} adults${h.babies ? ` + ${h.babies} young` : ''}` : `${p.lastCount ?? '?'} animals`}${p.cap ? ` (herd size ${p.cap})` : ''}${ago !== null ? `, last tended ${ago < 60 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago` : ', not tended yet'}${made ? `; so far ${made}` : ''} (tend_animals)`)
  }
  const pets = memory?.data?.pets || []
  if (pets.length) lines.push(`Your pets: ${pets.map(p => `${p.name} the ${PET_FOOD[p.kind]?.word || p.kind}`).join(', ')} (pet list/sit/follow/feed/home)`)
  return lines
}

// Ideas for the drives list. add(level, text)
function drives (bot, memory, skills, add) {
  const pens = myPens(memory)
  const farming = skills?.params?.('farming')
  if (pens.length && (!skills || farming?.breed)) {
    const due = pens.filter(p => minsSince(p.lastRound) > 15)
    if (due.length) add('someday', `your ${due.map(p => p.kind).join(' and ')} pen${due.length === 1 ? ' is' : 's are'} due a round: tend_animals (breed, shear, collect eggs, keep the herd at a good size)`)
    if (pens.some(p => p.kind === 'sheep') && !count(bot, 'shears') && count(bot, 'iron_ingot') >= 2) add('someday', 'you have sheep but no shears: craft shears (2 iron ingots) to collect wool without hurting them')
  } else if (!pens.length && farming?.pens && bot.inventory.items().some(i => /_fence$/.test(i.name))) {
    const herd = Object.values(bot.entities || {}).find(e => e?.position && LIVESTOCK.has(e.name) && e.position.distanceTo(bot.entity.position) < 32)
    if (herd) add('someday', `there are ${herd.name}s around and you carry fences: a pen (build_pen) would give you meat, wool or eggs without hunting far away`)
  }
  const pets = Object.values(bot.entities || {}).filter(e => e?.position && TAMEABLE.has(e.name) && isMyPet(bot, e) && e.position.distanceTo(bot.entity.position) < 24)
  const hurt = pets.filter(e => e.name === 'wolf' && (animalState(e).health ?? 40) < 20)
  if (hurt.length) add('soon', `your dog is hurt (health ${Math.round(animalState(hurt[0]).health)}/40): feed it meat with pet feed`)
  if (!memory?.data?.pets?.length && count(bot, 'bone') >= 4) {
    const wolf = Object.values(bot.entities || {}).find(e => e?.name === 'wolf' && e.position && !animalState(e).tamed && e.position.distanceTo(bot.entity.position) < 32)
    if (wolf) add('someday', 'there is a wild wolf nearby and you have bones: tame it (tame) and you\'ll have a loyal dog')
  }
}

module.exports = {
  META,
  LIVESTOCK,
  PET_FOOD,
  animalState,
  isMyPet,
  myPens,
  penOf,
  protectedReason,
  animalTag,
  planRound,
  herdOf,
  ranchParams,
  tendPen,
  tendAnimalsAction,
  tameAction,
  petAction,
  summaryLines,
  drives,
  kindOf,
  chatText,
  savePet,
  petRecord
}
