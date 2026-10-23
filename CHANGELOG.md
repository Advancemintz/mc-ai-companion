# Changelog

Every version so far. Newest first.

> **Status:** everything below was built and tested against simulated worlds and mock LLM servers
> (115 automated tests: 59 unit + 56 simulated-world). Version 0.1 has been run on a real server; later versions have not been
> played on a real server yet. Expect tuning as real-world reports come in.

## 0.8.1: More homes, and end-game ones

- **Tier 3 designs:** a stone **watchtower** (living room, bedroom, lookout, ladder all the way up, battlemented roof platform) and an L-shaped **farmhouse** (peaked roof, kitchen/pantry wing, covered porch, yard).
- **Tier 4 end-game designs**
  - The **manor**: two storeys around a central hall.
    - Ground floor: a storage vault of double chests and an ender chest, and a full workshop and forge.
    - Upstairs: an enchanting library with all 15 bookshelves, four beds and a brewing corner.
    - Outside: a balcony over a covered porch.
  - The **hillside fortress** is dug into a hill.
    - A stone facade and a pillared great hall.
    - A vault, a forge, a library, a bedroom and a brewing room.
- **Smarter design choice:** the bot's newest designs are the likeliest pick. If the land doesn't suit a design, it tries the next one and says so.
- **Furniture shopping list:** big designs report every empty furniture spot. Calling `build_base` on a finished base places any of that furniture the bot now carries (small XP, not a new-base reward).
- Upgrades now depend on the design, and built-in rooms are reported as already there.
- The site finder uses each design's real footprint, which also fixes the longhouse being checked as a square.
- Designs can prefer materials: stone for towers and ground floors, wood upstairs, with the usual blocks as a fallback. Raw rock left where a design wants dressed stone (pillars, the facade, the fortress floor) gets replaced.
- Ladders are now placed after windows, so a ladder against a window gets its support.
- Upgrading or furnishing a base no longer re-awards the full base XP or resets `home`.
- 9 new simulated-world tests.

## 0.8.0: Home designs, base upgrades, farming and the Nether

- **Home designs, picked at random** from the ones the bot's building tier knows (or asked for with `variant`)
  - Surface: the classic **cottage**, or a long, narrow **longhouse** with a peaked roof.
  - Underground: the square **cellar**, or a long **hall** with stone pillars.
  - `build` huts are either a flat-roofed **box** or a **peaked** hut.
- **Base upgrades instead of starting over** (`upgrade_base`): a bot that gets better improves the base it has.
  - `storage_room` (tier 2): a side room of chests that join into a double chest.
  - `bunker` (tier 3): a safe room under a surface house with a ladder down.
  - `second_storey` (tier 4): turns a one-storey house into a two-storey one.
  - `enchanting_room` (tier 4): an enchanting table with all 15 bookshelves.
  - Upgrades are resumable, refuse to cut into other people's builds, and extend the protected zone.
  - A finished `build_base` now points to upgrades instead of starting again. Memory lists each base with its design and upgrades, and the needs suggest unbuilt ones.
- **New Farming skill** (4 tiers): `farm` picks a plot by water (or makes its own water from tier 2), then tills, plants, harvests and replants each round. Bigger plots, more crops, fences, then breeding (`breed_animals`) and bone meal at higher tiers. The farm is remembered and protected; needs and autopilot send the bot back when crops have had time to grow.
- **The Nether skill is real now** (4 tiers, unlocks at combat 3 + mining 3)
  - `build_portal` builds and lights a 4x5 portal near home.
  - `nether_trip` makes a careful round trip for netherrack, quartz, gold, glowstone, nether wart, blaze rods or piglin bartering. Range and time grow with the tier. It turns back when hurt and avoids angering piglins.
- Tests: 21 new (farming, portal and Nether trip in the simulated world, every design and upgrade).

## 0.7.0: Skills that grow with practice

- **New skill framework** (`src/skills/`): building, mining, combat, railways and a Nether placeholder. Each has tiers defined as data: name, XP needed, prerequisites, description, and params the actions read.
- **XP from results**, scaled per bot by `affinity` (talents and weak spots), so bots specialise. Failed attempts teach a little. Tiers can need other skills first, and some skills unlock only when their prerequisites are met (railways: building 2 + mining 2).
- **Existing behaviours converted into tiers**
  - *Building:* novice huts (small, with missed blocks) → small bases with some details forgotten → every base size, complete → **new two-storey houses** (log band between floors, ladder, upstairs bedroom).
  - *Mining:* exposed ore only → own mine for coal/copper/iron with short branches → every ore with full veins → tighter, longer branches. Each mine level keeps the layout it was started with.
  - *Combat:* the reflexes now follow the tier: reaction delay, panic chance, flee threshold, reach, shield use, creeper dodging.
  - *Railways:* maximum line length per tier.
- **Universal behaviours stay universal:** movement, eating, safety, memory, tidy placement, protected zones and operator control.
- **Friendly gating:** an action above the bot's tier fails with what it needs and how to improve, and the model is told to practise the easier version.
- **Lessons:** the new `note_lesson` action keeps the last three per skill, shown in the bot's state.
- **Level-ups** are announced to the bot (and it may celebrate). The bot sees all its skills, progress and talents every turn.
- **Operator commands:** `!skills`, `!skill <name|all> tier|cap|nocap|xp|natural|lock|unlock|reset`, `!resetskills confirm`. `!wipe` resets skills too.
- **Config:** `bot.skills` sets `mode`, `startTier`/`startTiers`, `caps`, `affinity` and `xpRate`. Use `startTier: 3` to keep the full abilities from 0.6.

## 0.6.0: Railways

- **`build_railway`** builds powered minecart lines from the bot's base to any saved place, a player's base, or coordinates.
  - The route has one straight run, one corner, then another straight run. Stations sit just outside any base, and the route picks whichever corner avoids other protected areas.
  - The track follows the land, at most one block up or down per block. It tunnels through hills (3 blocks high), bridges dips and water on cobblestone, and keeps corners flat.
  - There's a powered rail every 24 blocks on flat ground and on every uphill rail, each with a redstone torch beside it.
  - Each end has a station: a buffer block, a brake/launch powered rail, a button and a platform.
  - It crafts rails, powered rails and redstone torches from iron, gold, redstone and sticks as it goes.
  - It builds in 24-block sections and saves after each one, so it can pause when materials run out and resume where it stopped.
- **`plan_railway`** gives the route length, the full bill of materials, what the bot already has, and whether the rest is easy to get.
- **`ride_railway`** lets the bot place a minecart, get in, press the button and ride the line.
- **Players' bases:** `remember_place` takes an `owner`. A player's base is protected automatically (radius 12).
- **Weekly railway offers:** about once a week per player, the bot considers offering them a line. This only happens if their base is far enough away and the bot has, or could easily mine, the materials. Its personality decides whether to ask. If it doesn't know where a nearby player lives, it may ask. Configured with `railOffers`.

## 0.5.0: Tidy behaviour and staying busy

- **Smarter placement of chests, crafting tables, furnaces, beds and other utility blocks**
  - They go against a wall, never in the middle of a room, never in a one-wide corridor, and never next to a door. They face into the room.
  - New chests join existing single chests into double chests.
  - Work blocks are grouped together, and beds go head-against-wall.
- **Temporary work blocks:** a crafting table or furnace placed out in the wild for one job is picked back up afterwards.
- **Protected zones**
  - Bases, home, and areas marked with `protect_area` are off limits for pathfinder digging or pillaring.
  - Player-made blocks are never broken anywhere.
  - `collect_block` never harvests from a base.
  - The bot can open doors.
- **`mine` action:** one tidy mine instead of random holes.
  - A covered stairwell entrance at least 6 blocks from any base, heading away from home.
  - Stairs down to the best depth for the target ore, with caves, water and lava sealed off.
  - Branch mining (a main tunnel with side tunnels every 4 blocks), digging out every vein it uncovers, with torches.
  - Remembered and extended on every call.
- `collect_block` only takes ores and stone you can see, and points to `mine` for buried ones.
- New actions: `clean_inventory`, `protect_area`, `unprotect_area`.
- **Never standing around**
  - *Plan ahead:* it thinks about the next step while the last one is still running.
  - *Watchdog:* an action with no progress for `stuckSeconds` is cancelled and re-planned.
  - *Autopilot:* if the model keeps choosing to do nothing, the bot picks something sensible itself.
  - *Idle animation:* it looks at nearby players and glances around.
  - It turns to face whoever is talking.
  - If the model's reply isn't valid JSON, it is asked to try again.

## 0.4.0: Real bases

- **`build_base` style `surface`** (small 7x7, medium 9x9, large 11x11)
  - Finds the flattest dry spot within 20 blocks, then clears trees and levels the ground, including a walkway around the house.
  - Builds a log-framed house with a stone floor, plank walls, glass windows, a door, a log-trimmed roof, torches, and any furniture it carries.
- **`build_base` style `underground`:** a covered two-wide staircase with double doors down to a carved, torch-lit room. Every face of the dug space is checked: caves are filled, and water or lava is plugged (and dug back out when it's safe).
- **Resumable projects:** bases are compared against a blueprint each run, so they continue after fights, nightfall or a trip to gather materials. `plan_only` lists what's needed. The finished base becomes `home`.

## 0.3.0: Operators and personality

- **No owner any more:** server operators control the bot with `!` commands. They're recognized via `/say`, the `admins` list, or the server's `ops.json`.
- Operator commands: `!stop`, `!come`, `!follow`, `!think`, `!pause`, `!resume`, `!autonomy on|off`, `!reset`, `!forget <player>`, `!wipe confirm`, `!op`/`!deop`, `!quit`. Anyone can use `!status`, `!goals` and `!help`.
- **Loyalty comes from the personality:** the bot decides whether to help, bargain, refuse or ignore requests, based on its mood and its notes about the person asking.
- `otherBots` with a chat cooldown, so AI bots can't talk to each other forever.
- The bot treats its life as precious and never uses dying as a shortcut.

## 0.2.0: Terrain and a mind of its own

- **Terrain awareness:** it knows whether it's outdoors, under trees, indoors or underground. New `go_to_surface` action.
- **Better building:** the `build` hut finds a flat open spot by itself, clears leaves and bumps, fills dips, and mixes materials.
- **Long-term memory** (`memory/*.json`): places, the bot's own goals, a journal, and notes about players. Actions: `remember_place`, `go_to_place`, `forget_place`, `set_goal`, `complete_goal`, `note_player`.
- **Needs:** night with no shelter, food, the next tool upgrade, home, a full inventory. These are computed in code and shown to the model every turn.
- **Senses:** it reacts to sunset, storms, players joining or returning, dangerous mobs, rare ores, being hit or given items.
- **Autonomy on by default:** when nobody needs it, it pursues its own needs and goals.
- Fixed: asking for "planks" could make it pull planks out of buildings.

## 0.1.0: First version

- A Mineflayer bot for Minecraft Java 1.21.x with two layers: an **LLM brain** that is called only on events, and a **code-driven body** that runs at game speed.
- LLM providers: Ollama, OpenAI (Responses API), Anthropic, Gemini, and any OpenAI-compatible server. They all use the same JSON reply format.
- Actions: follow, go to, collect blocks, attack, guard, craft (auto crafting table), smelt, place, build, equip, give, drop, eat, sleep, deposit, withdraw, find, wait.
- Reflexes: self-defense, flee at low health, auto-eat, auto-armor, swim up.
- Executor with instant cancel, and reflex interrupts that resume the task with whatever work is left.
- Quick `!` commands, typing to the bot in the terminal, and auto-reconnect.
