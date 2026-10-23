'use strict'

// The skill library: every learnable activity and its tiers, as plain data.
//
// A bot starts low and climbs by doing things (XP), like a real player getting better.
// Each tier has:
//   name       what the bot is at this level
//   xp         XP needed to reach it
//   requires   extra conditions to unlock it: other skills' tiers ({ skill: tier })
//   can        plain-language summary shown to the bot ("what you can do now")
//   next       hint for how to improve (shown to the bot)
//   params     numbers/flags the action code reads to behave differently per tier
//
// Things every player just knows (walking, eating, fleeing, remembering places, being tidy,
// respecting bases, obeying operators) are NOT skills. They live in the body and work the same
// for every bot at every level.
//
// To add content: add a tier here (params only), then teach the action code to read the new
// params. Most new variety (blueprints, palettes) can be pure data.

const SKILLS = {
  building: {
    label: 'Building',
    about: 'shelters, houses and bases',
    tiers: [
      {
        name: 'Dirt-hut novice',
        xp: 0,
        can: 'quick huts with `build` (small, a bit sloppy: some blocks get missed); a flat-roofed box or a peaked hut, picked at random',
        next: 'build huts and walls to get the hang of it',
        params: { bases: [], baseSizes: [], storeys: 1, missChance: 0.12, hutMaxSize: 2, detailSkip: 1, hutVariants: ['box', 'peaked'], variants: [], upgrades: [] }
      },
      {
        name: 'Cabin builder',
        xp: 100,
        can: 'small proper bases with build_base (surface: a cottage or a longhouse; underground: a cellar or a pillared hall, picked at random); details like windows and torches are hit-and-miss. You can add a storage room to a finished base with upgrade_base',
        next: 'finish a few small bases, then upgrade them',
        params: { bases: ['surface', 'underground'], baseSizes: ['small'], storeys: 1, missChance: 0, hutMaxSize: 4, detailSkip: 0.4, hutVariants: ['box', 'peaked'], variants: ['cottage', 'longhouse', 'cellar', 'hall'], upgrades: ['storage_room'] }
      },
      {
        name: 'Homesteader',
        xp: 400,
        requires: { mining: 2 },
        can: 'small, medium and large bases with every detail, and two new designs: a stone watchtower with a lookout and battlements, and an L-shaped farmhouse with a kitchen wing and porch. upgrade_base can add a storage room or (surface bases) a hidden bunker under the house',
        next: 'finish medium or large bases and upgrade them',
        params: { bases: ['surface', 'underground'], baseSizes: ['small', 'medium', 'large'], storeys: 1, missChance: 0, hutMaxSize: 7, detailSkip: 0, hutVariants: ['box', 'peaked'], variants: ['cottage', 'longhouse', 'cellar', 'hall', 'watchtower', 'farmhouse'], upgrades: ['storage_room', 'bunker'] }
      },
      {
        name: 'Architect',
        xp: 1200,
        requires: { mining: 3 },
        can: 'everything, plus two-storey houses (storeys: 2) and the end-game designs: a manor (storage vault, forge, enchanting library, bedrooms, brewing corner, balcony) and a hillside fortress dug into a hill (pillared great hall, vault, forge, library, bedroom, brewing room). upgrade_base can also add a second storey and an enchanting room to older houses',
        next: 'keep building and upgrading; furnish your manor or fortress fully',
        params: { bases: ['surface', 'underground'], baseSizes: ['small', 'medium', 'large'], storeys: 2, missChance: 0, hutMaxSize: 7, detailSkip: 0, hutVariants: ['box', 'peaked'], variants: ['cottage', 'longhouse', 'cellar', 'hall', 'watchtower', 'farmhouse', 'manor', 'hillside'], upgrades: ['storage_room', 'bunker', 'second_storey', 'enchanting_room'] }
      }
    ]
  },

  mining: {
    label: 'Mining',
    about: 'digging for stone and ores',
    tiers: [
      {
        name: 'Surface scraper',
        xp: 0,
        can: 'collect stone and ores you can see (cliffs, caves) with collect_block',
        next: 'collect exposed stone, coal and iron',
        params: { mine: false, targets: [], branchSpacing: 4, branchLength: 3, veinLimit: 4, torchEvery: 12, cave: null }
      },
      {
        name: 'Tunneler',
        xp: 60,
        can: 'dig your own mine with `mine`, for stone, coal, copper and iron (short side tunnels), and go caving with `cave`: short, careful trips into caves near their mouth for the ore on the walls',
        next: 'mine plenty of iron and coal',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron'], branchSpacing: 4, branchLength: 3, veinLimit: 6, torchEvery: 12, cave: { minutes: 3, reach: 40, ores: ['coal', 'copper', 'iron'] } }
      },
      {
        name: 'Prospector',
        xp: 250,
        can: 'mine for anything (gold, lapis, redstone, diamonds) with proper branch mines and full veins; longer caving trips that follow caves deeper',
        next: 'find diamonds and gold',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'], branchSpacing: 4, branchLength: 6, veinLimit: 16, torchEvery: 8, cave: { minutes: 6, reach: 80, ores: ['coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'] } }
      },
      {
        name: 'Deep miner',
        xp: 800,
        can: 'efficient branch mines (tighter, longer branches), big veins, and long cave expeditions',
        next: 'mine a lot more; the best miners run long strip mines',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'], branchSpacing: 3, branchLength: 8, veinLimit: 24, torchEvery: 6, cave: { minutes: 10, reach: 120, ores: ['coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'] } }
      },
      {
        name: 'Master miner',
        xp: 2000,
        can: 'strip mining: long parallel tunnels three blocks apart that see every ore in a layer, plus the longest cave expeditions',
        next: 'top tier: keep your pickaxes sharp',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'], branchSpacing: 3, branchLength: 16, veinLimit: 32, torchEvery: 6, strip: true, cave: { minutes: 15, reach: 160, ores: ['coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'] } }
      }
    ]
  },

  combat: {
    label: 'Combat',
    about: 'fighting monsters (and, if it comes to it, players)',
    // Combat params (read by src/body/combat.js):
    //   reactionMs     delay before answering a monster that hasn't hit you yet
    //   panicChance    chance a beginner just runs instead of fighting
    //   fleeBonus      added to reflexes.fleeHealth (negative = fights on at lower health)
    //   attackRange    melee reach used when closing in
    //   timedSwings    wait for the weapon's attack cooldown (full-damage hits) instead of spamming
    //   prioritize     pick the most dangerous target (creepers close by, skeletons, witches) instead of the nearest
    //   eatAt          health at which it backs off mid-fight to eat (0 = never)
    //   useShield      raise a shield between swings
    //   creeperDodge   back away from a creeper that's about to blow
    //   strafe         circle the target instead of standing still ('none' | 'steady' | 'random')
    //   bow            use a bow on skeletons, creepers and other ranged/explosive mobs at range
    //   bowRange       furthest shot it will take; bowLead = aim ahead of moving targets
    //   crits          chance to time a jump so the hit lands while falling (critical hit, +50% damage)
    tiers: [
      {
        name: 'Panicky',
        xp: 0,
        can: 'swing at things, badly: slow to react, flails instead of timing swings, and quick to run',
        next: 'survive fights against zombies and spiders',
        params: { reactionMs: 900, panicChance: 0.35, fleeBonus: 4, attackRange: 2.6, timedSwings: false, prioritize: false, eatAt: 0, useShield: false, creeperDodge: false, strafe: 'none', bow: false, bowRange: 0, bowLead: false, crits: 0 }
      },
      {
        name: 'Scrapper',
        xp: 40,
        can: 'hold your own against common monsters: you time your swings for full damage, deal with the most dangerous monster first, and back off to eat when a fight goes badly',
        next: 'win more fights, including skeletons and creepers',
        params: { reactionMs: 350, panicChance: 0.1, fleeBonus: 1, attackRange: 3, timedSwings: true, prioritize: true, eatAt: 9, useShield: false, creeperDodge: false, strafe: 'none', bow: false, bowRange: 0, bowLead: false, crits: 0 }
      },
      {
        name: 'Fighter',
        xp: 200,
        can: 'fight properly: block with a shield, back off from creepers before they blow, strafe around your target instead of standing still, and shoot skeletons and creepers with a bow at short range (carry a bow and arrows)',
        next: 'keep winning fights; get iron gear and a bow',
        params: { reactionMs: 150, panicChance: 0, fleeBonus: 0, attackRange: 3, timedSwings: true, prioritize: true, eatAt: 11, useShield: true, creeperDodge: true, strafe: 'steady', bow: true, bowRange: 16, bowLead: false, crits: 0 }
      },
      {
        name: 'Veteran',
        xp: 700,
        can: 'stay calm under pressure: fight on at lower health, land critical hits (jump and strike on the way down), and take longer bow shots that lead moving targets',
        next: 'win many more fights; the best fighters crit every swing and pick creepers off from far away',
        params: { reactionMs: 50, panicChance: 0, fleeBonus: -2, attackRange: 3, timedSwings: true, prioritize: true, eatAt: 11, useShield: true, creeperDodge: true, strafe: 'steady', bow: true, bowRange: 24, bowLead: true, crits: 0.6 }
      },
      {
        name: 'Champion',
        xp: 1600,
        can: 'fight like a pro: a critical hit almost every swing, unpredictable strafing, and long-range archery that drops skeletons and creepers before they get close',
        next: 'top tier: keep your gear sharp',
        params: { reactionMs: 0, panicChance: 0, fleeBonus: -3, attackRange: 3, timedSwings: true, prioritize: true, eatAt: 12, useShield: true, creeperDodge: true, strafe: 'random', bow: true, bowRange: 32, bowLead: true, crits: 0.95 }
      }
    ]
  },

  railways: {
    label: 'Railways',
    about: 'powered minecart lines',
    unlock: { building: 2, mining: 2 },
    tiers: [
      {
        name: 'Track layer',
        xp: 0,
        can: 'railways up to 100 blocks long',
        next: 'finish a few short lines',
        params: { maxLength: 100 }
      },
      {
        name: 'Engineer',
        xp: 120,
        can: 'railways up to 300 blocks long',
        next: 'build longer lines',
        params: { maxLength: 300 }
      },
      {
        name: 'Rail baron',
        xp: 500,
        can: 'railways of any length',
        next: 'connect the whole server',
        params: { maxLength: Infinity }
      }
    ]
  },

  farming: {
    label: 'Farming',
    about: 'crops and animals',
    tiers: [
      {
        name: 'Seed planter',
        xp: 0,
        can: 'a small wheat patch (5x5) next to water you find, with `farm` (needs a hoe; you pull up grass for seeds)',
        next: 'harvest and replant your wheat a few times',
        params: { plotRadius: 2, crops: ['wheat'], makeWater: false, fence: false, breed: false, boneMeal: false, pens: false, cull: false, leads: false, eggThrow: false }
      },
      {
        name: 'Gardener',
        xp: 60,
        can: 'bigger farms (9x9) anywhere flat: a water bucket lets you make your own water. Grows wheat, carrots, potatoes and beetroot, and fences the farm in',
        next: 'keep harvesting; carry a water bucket and fences',
        params: { plotRadius: 4, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: false, boneMeal: false, pens: false, cull: false, leads: false, eggThrow: false }
      },
      {
        name: 'Rancher',
        xp: 220,
        can: 'everything so far, plus breeding animals with breed_animals, fenced animal pens with build_pen (you lure animals in by holding their food), and ranch rounds with tend_animals: breed when there is room, shear sheep, milk cows, collect eggs, mend the fence (you never let a pen get overcrowded, but you are not yet good at deciding which animals go for meat)',
        next: 'breed animals and keep the farm going',
        params: { plotRadius: 4, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: true, boneMeal: false, pens: true, cull: false, leads: false, eggThrow: false }
      },
      {
        name: 'Agronomist',
        xp: 600,
        can: 'big farms (11x11), bone meal to make crops grow at once, and real herd management: tend_animals keeps each pen at its herd size by culling spare adults for meat (never the young, never below a breeding pair), leads bring in animals from far away, and spare eggs get thrown for chicks',
        next: 'keep farming; master farmers grow melons, pumpkins and sugar cane too',
        params: { plotRadius: 5, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: true, boneMeal: true, pens: true, cull: true, leads: true, eggThrow: true }
      },
      {
        name: 'Master farmer',
        xp: 1200,
        can: 'a melon and pumpkin patch (stems with room for the fruit to grow) and sugar cane along the water, with farm crop melon, pumpkin or sugar_cane; a normal farm round tends them too',
        next: 'top tier: keep everyone fed',
        params: { plotRadius: 5, crops: ['wheat', 'carrots', 'potatoes', 'beetroot', 'melon', 'pumpkin', 'sugar_cane'], makeWater: true, fence: true, breed: true, boneMeal: true, pens: true, cull: true, leads: true, eggThrow: true }
      }
    ]
  },

  // Exploration params (read by src/body/explore.js):
  //   radius       how far from home a trip may go (blocks)
  //   minutes      longest trip
  //   hop          blocks walked between looks around
  //   notices      what it recognises: biome, village, cave, lava, structure, base (someone's base)
  //   scanRadius   how far it looks for finds at each stop
  //   smartDir     pick the least-explored direction (otherwise a random new one)
  //   marker       leave a torch on a cobblestone post at big finds
  //   safety       extra minutes of daylight it keeps in hand for the walk home
  exploration: {
    label: 'Exploration',
    about: 'scouting new land and remembering what is out there',
    tiers: [
      {
        name: 'Wanderer',
        xp: 0,
        can: 'short trips with `explore` (up to 96 blocks from home, about 3 minutes): you notice biomes and villages you walk through, and head home before dark or when hurt',
        next: 'take a few trips in different directions',
        params: { radius: 96, minutes: 3, hop: 16, notices: ['biome', 'village'], scanRadius: 24, smartDir: false, marker: false, safety: 2.5 }
      },
      {
        name: 'Scout',
        xp: 50,
        can: 'trips up to 192 blocks (6 minutes); you also spot caves, lava and other people\'s bases',
        next: 'explore further out and find a village or a cave',
        params: { radius: 192, minutes: 6, hop: 20, notices: ['biome', 'village', 'cave', 'lava', 'base'], scanRadius: 32, smartDir: true, marker: false, safety: 2 }
      },
      {
        name: 'Pathfinder',
        xp: 200,
        can: 'trips up to 384 blocks (10 minutes), always toward land you haven\'t seen; you recognise structures (temples, outposts, dungeons, ruined portals, mineshafts...)',
        next: 'map the land around home and find structures',
        params: { radius: 384, minutes: 10, hop: 24, notices: ['biome', 'village', 'cave', 'lava', 'base', 'structure'], scanRadius: 40, smartDir: true, marker: false, safety: 1.5 }
      },
      {
        name: 'Cartographer',
        xp: 600,
        can: 'long expeditions up to 768 blocks (15 minutes); you mark big finds with a torch on a cobblestone post so they are easy to find again',
        next: 'top tier: keep the map up to date',
        params: { radius: 768, minutes: 15, hop: 32, notices: ['biome', 'village', 'cave', 'lava', 'base', 'structure'], scanRadius: 48, smartDir: true, marker: true, safety: 1.2 }
      }
    ]
  },

  // Enchanting params (read by src/body/enchanting.js):
  //   waitForBest  hold off until it can afford the table's best offer (otherwise take what it can afford)
  //   priorities   enchant gear in the order that matters (pickaxe, sword, chestplate...) instead of whatever's in hand
  //   anvil        put enchanted books on gear, repair gear and rename things at an anvil
  //   readOffers   choose the offer by the enchantment it shows, not just the most expensive slot
  //   mending      plan Mending gear: put Mending on the best gear first and remember where to buy it
  enchanting: {
    label: 'Enchanting',
    about: 'enchanting tables, books and anvils',
    tiers: [
      {
        name: 'Dabbler',
        xp: 0,
        can: 'use an enchanting table with `enchant` (needs a table, lapis and some XP levels): you take the best offer you can afford right away',
        next: 'enchant a few things; bookshelves around the table make the offers better',
        params: { waitForBest: false, priorities: false, anvil: false, readOffers: false, mending: false }
      },
      {
        name: 'Enchanter',
        xp: 60,
        can: 'patient enchanting: you save your XP until you can afford the table\'s best offer (level 30 with all 15 bookshelves) and enchant your gear in the order that matters (pickaxe, sword, chestplate...)',
        next: 'enchant your main gear at level 30',
        params: { waitForBest: true, priorities: true, anvil: false, readOffers: false, mending: false }
      },
      {
        name: 'Arcanist',
        xp: 250,
        can: 'anvil work with `anvil`: put enchanted books on the right gear, repair worn gear (with its material or a second copy) and name things',
        next: 'collect books and keep your best gear repaired',
        params: { waitForBest: true, priorities: true, anvil: true, readOffers: false, mending: false }
      },
      {
        name: 'Mending master',
        xp: 700,
        can: 'you read the table\'s offers and pick by enchantment, not just price, and you plan Mending gear: Mending goes on your best gear first, and you remember which librarian sells it',
        next: 'top tier: keep everything mended',
        params: { waitForBest: true, priorities: true, anvil: true, readOffers: true, mending: true }
      }
    ]
  },

  nether: {
    label: 'The Nether',
    about: 'portals, and surviving and gathering in the Nether',
    unlock: { combat: 3, mining: 3 },
    tiers: [
      {
        name: 'Portal builder',
        xp: 0,
        can: 'build and light a Nether portal near home with build_portal (needs 10 obsidian and flint and steel), and peek through with nether_trip (stays by the portal)',
        next: 'build a portal and make a few careful trips',
        params: { trip: true, radius: 12, minutes: 2, targets: ['netherrack'], fight: [], barter: false }
      },
      {
        name: 'Day tripper',
        xp: 80,
        can: 'short Nether trips for quartz, Nether gold, glowstone and netherrack, up to 32 blocks from the portal',
        next: 'bring back quartz and glowstone',
        params: { trip: true, radius: 32, minutes: 5, targets: ['netherrack', 'quartz', 'gold', 'glowstone'], fight: [], barter: false }
      },
      {
        name: 'Fortress raider',
        xp: 300,
        can: 'longer trips (up to 96 blocks) that reach fortresses: nether wart and blaze rods (it fights blazes)',
        next: 'collect blaze rods and nether wart',
        params: { trip: true, radius: 96, minutes: 10, targets: ['netherrack', 'quartz', 'gold', 'glowstone', 'nether_wart', 'blaze_rod'], fight: ['blaze'], barter: false }
      },
      {
        name: 'Piglin trader',
        xp: 900,
        can: 'everything, plus bartering gold ingots with piglins (wear something gold!) for ender pearls and other loot',
        next: 'get your combat and mining to tier 4; then go for ancient debris and bastions',
        params: { trip: true, radius: 96, minutes: 12, targets: ['netherrack', 'quartz', 'gold', 'glowstone', 'nether_wart', 'blaze_rod', 'barter'], fight: ['blaze'], barter: true }
      },
      {
        name: 'Netherite smith',
        xp: 2000,
        requires: { combat: 4, mining: 4 },
        can: 'the end game: tunnelling at y 8-22 for ancient debris (needs a diamond pickaxe), raiding bastions for their chests (wear gold, expect angry piglins), and make_netherite to turn debris into netherite and upgrade diamond gear',
        next: 'top tier: full netherite',
        params: { trip: true, radius: 128, minutes: 15, targets: ['netherrack', 'quartz', 'gold', 'glowstone', 'nether_wart', 'blaze_rod', 'barter', 'ancient_debris', 'bastion'], fight: ['blaze'], barter: true }
      }
    ]
  }
}

// Which actions belong to which skill, and the tier each needs.
// Actions not listed here are universal.
const ACTION_SKILLS = {
  build: { skill: 'building', minTier: 1 },
  build_base: { skill: 'building', minTier: 2 },
  upgrade_base: { skill: 'building', minTier: 2 },
  collect_block: { skill: 'mining', minTier: 1, onlyFor: /_ore$|^(stone|deepslate|cobblestone|tuff|andesite|diorite|granite|iron|coal|gold|copper|diamond|redstone|lapis|emerald)/ },
  mine: { skill: 'mining', minTier: 2 },
  cave: { skill: 'mining', minTier: 2 },
  attack: { skill: 'combat', minTier: 1 },
  guard: { skill: 'combat', minTier: 1 },
  explore: { skill: 'exploration', minTier: 1 },
  build_railway: { skill: 'railways', minTier: 1 },
  farm: { skill: 'farming', minTier: 1 },
  breed_animals: { skill: 'farming', minTier: 3 },
  build_pen: { skill: 'farming', minTier: 3 },
  tend_animals: { skill: 'farming', minTier: 3 },
  build_portal: { skill: 'nether', minTier: 1 },
  nether_trip: { skill: 'nether', minTier: 1 },
  make_netherite: { skill: 'nether', minTier: 5 },
  enchant: { skill: 'enchanting', minTier: 1 },
  anvil: { skill: 'enchanting', minTier: 3 }
}

module.exports = { SKILLS, ACTION_SKILLS }
