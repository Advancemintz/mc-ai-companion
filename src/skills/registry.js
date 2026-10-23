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
        params: { mine: false, targets: [], branchSpacing: 4, branchLength: 3, veinLimit: 4, torchEvery: 12 }
      },
      {
        name: 'Tunneler',
        xp: 60,
        can: 'dig your own mine with `mine`, for stone, coal, copper and iron (short side tunnels)',
        next: 'mine plenty of iron and coal',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron'], branchSpacing: 4, branchLength: 3, veinLimit: 6, torchEvery: 12 }
      },
      {
        name: 'Prospector',
        xp: 250,
        can: 'mine for anything (gold, lapis, redstone, diamonds) with proper branch mines and full veins',
        next: 'find diamonds and gold',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'], branchSpacing: 4, branchLength: 6, veinLimit: 16, torchEvery: 8 }
      },
      {
        name: 'Deep miner',
        xp: 800,
        can: 'efficient branch mines (tighter, longer branches) and big veins',
        next: 'keep mining; future tiers will add caving and strip mines',
        params: { mine: true, targets: ['stone', 'coal', 'copper', 'iron', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'], branchSpacing: 3, branchLength: 8, veinLimit: 24, torchEvery: 6 }
      }
    ]
  },

  combat: {
    label: 'Combat',
    about: 'fighting monsters (and, if it comes to it, players)',
    tiers: [
      {
        name: 'Panicky',
        xp: 0,
        can: 'swing at things, badly: slow to react and quick to run',
        next: 'survive fights against zombies and spiders',
        params: { reactionMs: 900, panicChance: 0.35, fleeBonus: 4, attackRange: 2.6, useShield: false, creeperDodge: false }
      },
      {
        name: 'Scrapper',
        xp: 40,
        can: 'hold your own against common monsters',
        next: 'win more fights, including skeletons and creepers',
        params: { reactionMs: 350, panicChance: 0.1, fleeBonus: 1, attackRange: 3, useShield: false, creeperDodge: false }
      },
      {
        name: 'Fighter',
        xp: 200,
        can: 'fight properly: block with a shield, back off from creepers before they blow',
        next: 'keep winning fights; get iron gear',
        params: { reactionMs: 150, panicChance: 0, fleeBonus: 0, attackRange: 3, useShield: true, creeperDodge: true }
      },
      {
        name: 'Veteran',
        xp: 700,
        can: 'stay calm under pressure: fight on at lower health and protect others',
        next: 'future tiers will add bows and critical hits',
        params: { reactionMs: 50, panicChance: 0, fleeBonus: -2, attackRange: 3, useShield: true, creeperDodge: true }
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
        params: { plotRadius: 2, crops: ['wheat'], makeWater: false, fence: false, breed: false, boneMeal: false }
      },
      {
        name: 'Gardener',
        xp: 60,
        can: 'bigger farms (9x9) anywhere flat: a water bucket lets you make your own water. Grows wheat, carrots, potatoes and beetroot, and fences the farm in',
        next: 'keep harvesting; carry a water bucket and fences',
        params: { plotRadius: 4, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: false, boneMeal: false }
      },
      {
        name: 'Rancher',
        xp: 220,
        can: 'everything so far, plus breeding animals with breed_animals (cows, sheep, pigs, chickens, rabbits)',
        next: 'breed animals and keep the farm going',
        params: { plotRadius: 4, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: true, boneMeal: false }
      },
      {
        name: 'Agronomist',
        xp: 600,
        can: 'big farms (11x11) and bone meal to make crops grow at once',
        next: 'future tiers will add melons, pumpkins, sugar cane and auto-farms',
        params: { plotRadius: 5, crops: ['wheat', 'carrots', 'potatoes', 'beetroot'], makeWater: true, fence: true, breed: true, boneMeal: true }
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
        next: 'future tiers will add bastions and netherite',
        params: { trip: true, radius: 96, minutes: 12, targets: ['netherrack', 'quartz', 'gold', 'glowstone', 'nether_wart', 'blaze_rod', 'barter'], fight: ['blaze'], barter: true }
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
  attack: { skill: 'combat', minTier: 1 },
  guard: { skill: 'combat', minTier: 1 },
  build_railway: { skill: 'railways', minTier: 1 },
  farm: { skill: 'farming', minTier: 1 },
  breed_animals: { skill: 'farming', minTier: 3 },
  build_portal: { skill: 'nether', minTier: 1 },
  nether_trip: { skill: 'nether', minTier: 1 }
}

module.exports = { SKILLS, ACTION_SKILLS }
