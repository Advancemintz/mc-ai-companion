'use strict'

// Random bots for the setup page: a name, a play style (archetype), a personality written from
// traits, talents that match the style, and a social temperament (how honest, how grudging).
// Every part can be locked, so you can re-roll just the personality and keep the name.
//
// Pass your own rng (a function returning 0..1) for repeatable results in tests.

const SKILL_IDS = ['building', 'mining', 'combat', 'farming', 'exploration', 'railways', 'nether']

// Play styles. talents: XP multipliers (1 = normal). weak: the skill they're bad at.
const ARCHETYPES = {
  builder: { label: 'Builder', talents: { building: 1.6, mining: 1.1 }, weak: 'combat', focus: 'Your passion is building: you dream about bigger and better bases and judge everyone by their houses', likes: ['neat rows of chests', 'a good roofline', 'stone bricks', 'finishing a project'] },
  miner: { label: 'Miner', talents: { mining: 1.6, building: 1.1 }, weak: 'farming', focus: 'You live for mining: long tunnels, the clink of a pickaxe, and the moment diamonds show up in the torchlight', likes: ['diamonds', 'deep tunnels', 'a full stack of iron', 'the quiet underground'] },
  warrior: { label: 'Warrior', talents: { combat: 1.7, exploration: 1.1 }, weak: 'building', focus: 'You are a fighter: you like hunting monsters at night, protecting your friends and showing off your gear', likes: ['a sharp sword', 'clearing out a cave of monsters', 'iron armour', 'a fair fight'] },
  explorer: { label: 'Explorer', talents: { exploration: 1.7, combat: 1.1 }, weak: 'farming', focus: 'You are an explorer: you get restless at home and always want to know what is over the next hill', likes: ['new biomes', 'villages', 'finding ruins', 'sunrise on a long trip'] },
  farmer: { label: 'Farmer', talents: { farming: 1.7, building: 1.1 }, weak: 'combat', focus: 'You are a farmer at heart: fields, animals and a full pantry make you happy, and you like feeding people', likes: ['wheat fields', 'baby animals', 'a full barrel of bread', 'quiet mornings'] },
  engineer: { label: 'Engineer', talents: { railways: 1.7, mining: 1.2, building: 1.1 }, weak: 'exploration', focus: 'You are an engineer: you want to connect everything with rails and make things run smoothly', likes: ['powered rails', 'straight lines', 'redstone', 'plans that work'] },
  adventurer: { label: 'Adventurer', talents: { nether: 1.6, combat: 1.2, exploration: 1.2 }, weak: 'farming', focus: 'You are a daredevil: the Nether and everything dangerous call to you, and you get bored when things are safe', likes: ['the Nether', 'blaze rods', 'close calls', 'stories to tell'] },
  hoarder: { label: 'Hoarder', talents: { mining: 1.3, farming: 1.3 }, weak: 'exploration', focus: 'You are a collector: you want more of everything, you count your chests, and sharing does not come naturally', likes: ['full chests', 'rare items', 'counting things', 'a locked-up vault'] }
}

const TRAITS = ['cheerful', 'grumpy', 'sarcastic', 'shy', 'boastful', 'anxious', 'calm', 'dramatic', 'competitive', 'generous', 'stingy',
  'curious', 'lazy', 'perfectionist', 'paranoid', 'easygoing', 'bossy', 'polite', 'chaotic', 'stubborn', 'optimistic', 'gloomy', 'witty', 'serious']

const SPEECH = [
  'talk in short, punchy sentences',
  'talk casually and crack jokes',
  'speak politely, a little formally',
  'talk like a gruff old prospector',
  'get excited easily and use lots of exclamation marks',
  'mutter, complain and sigh a lot',
  'talk like a sports commentator about everything you do',
  'speak softly and rarely say more than needed',
  'use a lot of nautical expressions, like an old sailor',
  'talk like a know-it-all who loves explaining things'
]

const FEARS = ['creepers', 'the dark', 'deep water', 'heights', 'endermen', 'lava', 'being alone at night', 'losing your stuff', 'phantoms', 'caves']

const QUIRKS = [
  'you name every animal you meet',
  'you insist on placing torches symmetrically',
  'you hum while you work',
  'you keep a lucky dirt block',
  'you refuse to sleep unless your chests are organised',
  'you talk to your tools',
  'you count blocks out loud when building',
  'you collect flowers for no reason',
  'you always carry one more stack of torches than you need',
  'you think pigs are secretly plotting something'
]

// How honest, and how long grudges last. These become the social settings.
const MORALS = {
  honest: { label: 'Honest', line: 'You are honest to a fault: you would never steal, and you own up to your mistakes.', social: { stealing: { enabled: false, feelingAtMost: -60 }, sabotage: { enabled: false, feelingAtMost: -95 }, feelings: { decayPerDay: 4 } } },
  fair: { label: 'Fair', line: 'You treat people the way they treat you: kind to friends, cold to people who wrong you.', social: { stealing: { enabled: true, feelingAtMost: -40 }, sabotage: { enabled: true, feelingAtMost: -90 }, feelings: { decayPerDay: 2 } } },
  sly: { label: 'Sly', line: 'You are a bit of a schemer: if someone crosses you, you get even quietly, and you are good at playing innocent.', social: { stealing: { enabled: true, feelingAtMost: -20 }, sabotage: { enabled: true, feelingAtMost: -80 }, feelings: { decayPerDay: 1 } } },
  thief: { label: 'Light-fingered', line: 'You have sticky fingers: if you do not like someone much, their chests are fair game, and you never admit it.', social: { stealing: { enabled: true, feelingAtMost: -5 }, sabotage: { enabled: true, feelingAtMost: -70 }, feelings: { decayPerDay: 1 } } }
}

const NAMES = ['Pip', 'Moss', 'Bramble', 'Flint', 'Juniper', 'Rook', 'Tansy', 'Cobble', 'Wren', 'Marlow', 'Quill', 'Sorrel', 'Basalt',
  'Fern', 'Ingot', 'Sable', 'Thistle', 'Ember', 'Cinder', 'Pebble', 'Hollis', 'Birch', 'Nettle', 'Dusk', 'Clover', 'Gravel', 'Mica',
  'Rusty', 'Otto', 'Luma', 'Kip', 'Tillie', 'Bodie', 'Nell', 'Ash', 'Piper', 'Grub', 'Sprocket', 'Dewey', 'Ivy']

function pick (rng, list) { return list[Math.floor(rng() * list.length) % list.length] }
function pickMany (rng, list, n) {
  const pool = list.slice()
  const out = []
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0])
  return out
}
const round1 = (v) => Math.round(v * 10) / 10

function randomName (rng, taken = []) {
  const used = new Set(taken.map(n => String(n).toLowerCase()))
  const free = NAMES.filter(n => !used.has(n.toLowerCase()))
  if (free.length) return pick(rng, free)
  for (;;) {
    const n = `${pick(rng, NAMES)}${Math.floor(rng() * 90) + 10}`
    if (!used.has(n.toLowerCase())) return n
  }
}

function talentsFor (archetype, rng) {
  const a = ARCHETYPES[archetype]
  const out = {}
  for (const id of SKILL_IDS) {
    let v = a.talents[id] ?? 1
    if (id === a.weak) v = 0.6
    v += (rng() - 0.5) * 0.2 // a little wobble so two builders aren't identical
    out[id] = round1(Math.max(0.5, Math.min(2, v)))
  }
  return out
}

function writePersonality ({ name, archetype, traits, speech, fear, quirk, morals, like }) {
  const a = ARCHETYPES[archetype]
  const m = MORALS[morals]
  return `You are ${name}, a ${traits.join(', ')} Minecraft player. ${a.focus}. You ${speech}. You love ${like}, you're scared of ${fear}, and ${quirk}. ${m.line} You have your own plans and opinions, and you are not anyone's servant.`
}

// Build a random bot. `keep` holds values to keep (locked fields) from the current bot:
// { name, archetype, morals, personality, talents, greeting }.
function randomBot ({ rng = Math.random, taken = [], keep = {} } = {}) {
  const name = keep.name || randomName(rng, taken)
  const archetype = keep.archetype && ARCHETYPES[keep.archetype] ? keep.archetype : pick(rng, Object.keys(ARCHETYPES))
  const morals = keep.morals && MORALS[keep.morals] ? keep.morals : pick(rng, Object.keys(MORALS))
  const traits = pickMany(rng, TRAITS, 2)
  const personality = keep.personality || writePersonality({
    name, archetype, morals, traits,
    speech: pick(rng, SPEECH),
    fear: pick(rng, FEARS),
    quirk: pick(rng, QUIRKS),
    like: pick(rng, ARCHETYPES[archetype].likes)
  })
  const greetings = [`${name} here. Let's get to work.`, `Hi all! ${name} has arrived.`, `...oh, hello.`, `Right, where's the good stuff?`, `Morning! Or is it night? Hard to tell.`, '']
  // Lively characters fidget and gesture more; calm ones less.
  const lively = traits.filter(t => /cheerful|dramatic|chaotic|anxious|boastful|competitive|optimistic|witty/.test(t)).length
  const calm = traits.filter(t => /calm|serious|polite|shy|gloomy|lazy|perfectionist/.test(t)).length
  const mannerisms = keep.mannerisms !== undefined ? keep.mannerisms : round1(Math.max(0.15, Math.min(0.95, 0.5 + 0.2 * lively - 0.15 * calm + (rng() - 0.5) * 0.2)))
  return {
    name,
    archetype,
    morals,
    mannerisms,
    personality,
    greeting: keep.greeting !== undefined ? keep.greeting : pick(rng, greetings),
    talents: keep.talents || talentsFor(archetype, rng),
    social: JSON.parse(JSON.stringify(MORALS[morals].social))
  }
}

module.exports = { randomBot, randomName, talentsFor, writePersonality, ARCHETYPES, MORALS, TRAITS, SKILL_IDS, NAMES }
