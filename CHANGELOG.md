# Changelog

Every version so far. Newest first.

> **Status:** everything below was built and tested against simulated worlds and mock LLM servers
> (225 automated tests: 114 unit + 111 simulated-world). Version 0.1 has been run on a real server; later versions have not been
> played on a real server yet. Expect tuning as real-world reports come in.

## 0.14.1: Fixes from the first real play session

- **Reconnects:** when the connection dropped, the old session kept thinking and acting on the dead connection next to the new one, for minutes (fighting a cow that was gone, chatting into nowhere, two plans at once). The old brain, executor and background loops now shut down on disconnect.
- **Unreadable item data** (1.21.x: heavily enchanted or trimmed gear, items given in creative): pages of stack traces are replaced by one plain warning every few minutes, and a plugin crash on such an item no longer counts as a connection error. Those items can still be invisible to the bot; see Troubleshooting.
- **Fighting players:** won't attack (and stops fighting) a player in creative or spectator mode, and won't attack operator-protected players.
- **Eating:** golden apples (and other always-edible items) can be eaten on a full stomach.
- **Crafting:** asking for e.g. acacia planks with no logs keeps the name (the error now asks for the right log); the "now have" count is no longer reported while the inventory is still updating.
- **Greeting:** said once per run, not after every reconnect.
- Tests: 4 new unit tests.

## 0.14.0: Teamwork between bots

- **Shared plans:** bots tell each other their goals every few minutes and when they change; STATE shows other bots' plans, and a bot is told when someone's goal fits its own (the same kind, or mining that feeds a build).
- **Pacts** with the new `team` action: `build_together`, `you_gather`, `i_gather`, `hunt` or `together`. Offers are accepted or declined in character; a bot turns down someone it dislikes by itself.
- **Gatherer and builder:** when a shared build pauses, the gatherer is told exactly what's missing and where the depot chest is; `team deliver` drops it off (placing the chest if needed); the builder's next `build_base` picks it up. Finishing together and delivering raise feelings; leaving a pact lowers them. Two builders can work on one base at once.
- **Help in a fight:** a bot in trouble calls teammates and friends nearby; new `help_fight` runs over and clears the monsters around them. The autopilot answers fresh calls and makes deliveries.
- **Shared bases** (`team share_base`, good friends only): co-owned chests and beds, no snooping, griefing or theft alarms between co-owners, withdrawals announced, and a homeless friend moves in. Teammates building a base get the same allowance.
- **Two ways to talk:** behind the scenes through the setup page for bots started there, in-game whispers (split into parts when long, queued against spam) otherwise.
- New `team` settings: `minFeeling`, `shareBaseMinFeeling`, `helpMinFeeling`, `helpRadius`, `goalShareMinutes`, `whispers`.
- Fix: the social memory could lose a change made just before another lookup.
- Tests: 15 new (10 unit, 5 simulated-world).

## 0.13.0: Looking after animals

- **Ranch rounds:** new `tend_animals` (farming tier 3) visits each pen: counts adults and young, breeds when there's room (respecting the game's 5-minute cooldown), shears sheep, milks a cow into an empty bucket, collects eggs and drops, mends fence gaps, shuts the gate behind it, puts the food away before leaving, and brings back anything that slipped out.
- **Herd management** (tier 4): keeps each pen at its herd size by culling spare adults for meat, never the young, named animals or the last breeding pair; takes one for the pot when hungry; throws spare eggs for chicks. New `ranch` settings: `herdSize`, `keepAdults`, `cull`, `milk`, `shear`.
- **Leads** (tier 4): `build_pen` and escape-chasing lead in animals too far away to notice food, then unclip and keep the lead.
- **Own animals are safe:** `attack` and autopilot hunting skip animals in your pens, pets, named animals and animals in someone else's base, and explain why.
- **Pets:** `tame` a wolf (bones), cat (fish, approached slowly) or parrot (seeds) and name it; `pet` lists, sits, follows, heals, renames, or takes them home to sit before dangerous trips. Pets are remembered.
- Memory shows each pen's herd, last round and totals, plus your pets. Perception tags animals (baby, sheared, in your pen, your dog Rex). Needs and the autopilot suggest pen rounds, shears, taming a nearby wolf and feeding a hurt dog.
- Tests: 13 new (6 unit, 7 simulated-world).

## 0.12.0: Enchanting

- **New Enchanting skill** (4 tiers): Dabbler, Enchanter, Arcanist, Mending master.
- **`enchant`**: uses the best enchanting table around (counting bookshelves the way the game does: two blocks out, air between, at most 15), puts in lapis, waits for the offers, and picks one by tier. Beginners take the best affordable offer; enchanters save up for the top offer and enchant gear in order of importance; masters choose by the enchantment shown.
- **`anvil`** (tier 3): enchanted books onto the gear they suit (no conflicts or downgrades, Mending on the best gear first), repairs with the right material or a second copy, and renaming.
- XP level now shows in the bot's STATE. Needs and the autopilot spend saved levels, point out missing lapis or bookshelves, suggest ways to earn XP, and remember where Mending is sold.
- The setup page and randomizer know the new skill; new *Enchanter* play style.
- Tests: 9 new (5 unit, 4 simulated-world).

## 0.11.0: Living like a real player

- **Survival habits** (every bot, every level):
  - *Hazard reflexes:* climbs out of lava to the nearest safe ground, douses flames with a water bucket (and picks the water back up) or runs into water, digs out when sand or gravel buries its head, cuts free of cobwebs. They come before every other reflex.
  - *Cooking:* new `cook` action for raw meat, fish, potatoes and kelp (keeping a few potatoes to plant). `smelt` now uses a smoker for food and a blast furnace for ore when there is one.
  - *Gear:* new `upgrade_gear` crafts better tools and armour in the order that matters (pickaxe, sword, chestplate, leggings, then the rest), replaces anything about to break, makes a shield and wears the best armour. Needs list worn tools and craftable upgrades. Mining stops before the last good pickaxe breaks.
  - *Home life:* it puts loot away when it gets home, goes to bed at night in its own bed (`sleep` now refuses other people's beds, places a carried bed, and won't try by day or with monsters around), and counts nights without sleep (phantoms after three).
  - The autopilot does all of these when the model idles.
- **Mining:** new `cave` action from tier 2: into a cave found while exploring, torches along the way, ore off the walls (whole veins, best first, never beside lava), deeper when nothing is in sight, and back out along its waypoints. Turns back when hurt, hungry, out of torches, pickaxe nearly broken, pockets full, or as deep as its tier allows. New tier 5 *Master miner*: strip mining.
- **Farming:** `build_pen` (tier 3): a 7x7 fenced pen filled by luring animals in with their food. New tier 5 *Master farmer*: a melon and pumpkin patch (stems with room for fruit) and sugar cane by the water, tended by `farm`.
- **Nether:** new tier 5 *Netherite smith* (needs combat 4 + mining 4): `nether_trip` for `ancient_debris` (tunnels at y 8-22 and only takes what it uncovers) or `bastion` (loots bastion chests), and `make_netherite` (debris to scrap to ingots, then smithing-table upgrades of diamond gear).
- **Trading:** new `trade` action: goes to a known village, reads every villager's offers, sells surplus for emeralds (more of it when saving up), buys what it wants, and keeps a trade book shown in its STATE.
- **Mannerisms** (`bot.mannerisms.level`, "Human touches" on the setup page, set from personality by the randomizer): a short pause before new tasks, stepping back to admire a finished build, crouch-nods, hops and head shakes while chatting, idle fidgets, and a nod for someone who walks up.
- No skill tier says "future" any more.
- Tests: 22 new (9 unit, 13 simulated-world: lava and fire escapes, cooking, gear, caving, melon patch, sugar cane, pens, trading, netherite, debris tunnels, mannerisms). The simulated world gained crafting recipes, furnaces and non-solid cave air.

## 0.10.0: The setup page

- **`npm run setup`** (or `setup.bat` / `setup.sh`) opens a page in your browser to set up and run any number of bots from one PC. It only runs on your computer.
  - *World and AI:* server, accounts, version, AI provider, model and key, protected players and operators, set once for every bot.
  - *Bot cards:* name, first words, play style, honesty, personality, talents and starting tiers, an AI provider or model of its own, autonomy, and morals (stealing and sabotage thresholds, grudge fading, players it never targets).
  - *Randomize:* rolls a whole character (name, play style with matching talents, a personality written from traits, quirks and fears, and an honesty level that sets its morals), keeping whichever parts you tick.
  - *Run them:* start, stop and restart each bot or all of them. A live tab shows health, food, position and activity, has pause/resume/think controls, a chat box and a `!` command box, and can set feelings, protect players, set skill tiers and switch social features on the fly. It also shows what the bot knows: skills, feelings and why, goals, memories, explored land, finds, thefts and secrets. A log tab streams its output.
  - *Change bots later:* edits are saved at once and apply on restart (the page says when one is needed); memories, skills and feelings carry over, even through a rename.
- Each bot still gets an ordinary config file (`bots/<name>.json`) that works from the terminal. The first run copies `config.json` in as the first bot. The `bots` folder is git-ignored because it holds API keys.
- Bots started by the page take commands and report status over Node's IPC channel (`src/index.js`).
- Tests: 5 new (randomizer, roster and config files, and the web API driving a stand-in bot process, including that other sites and other computers can't use it).

## 0.9.0: Real fighting, exploring, and a social life

- **Combat tiers filled in** (the old "future tiers will add bows and critical hits"). A new fighting engine (`src/body/combat.js`) runs the self-defense reflex, `attack`, `guard` and blaze hunting:
  - *Scrapper (2):* times every swing to the weapon's cooldown for full damage, fights the most dangerous monster first (a creeper walking up, skeletons, witches), and backs off to eat when a fight goes badly.
  - *Fighter (3):* shield between swings, steps back from creepers after every hit, strafes around its target, and shoots skeletons, creepers and other ranged mobs with a bow up to 16 blocks away. Aim uses real arrow physics.
  - *Veteran (4):* critical hits (jump, strike on the way down) and longer bow shots that lead moving targets.
  - *Champion (5, new, 1600 XP):* a crit nearly every swing, unpredictable strafing, bow out to 32 blocks.
  - `attack "hostile"` goes for the most dangerous monster around, and a fight finishes off anything else still coming at the bot. Kills with crits earn a little extra XP.
- **New Exploration skill** (4 tiers) and the **`explore`** action: heads for land it hasn't seen (an explored map is kept in memory), looks around every few dozen blocks, remembers biomes, villages, caves, lava, structures and other people's bases (saving villages, caves and structures as places), and comes home before nightfall, when hurt or hungry, or at the edge of its range. Interrupted trips resume. Cartographers mark big finds with a torch post. Needs and the autopilot suggest exploring on mornings when the area around home is still unknown.
- **Feelings, property and mischief** (new `social` section in the config, built for bot-only servers):
  - *Feelings:* a lasting -100..+100 score for every player, moved by gifts, hits, deaths, griefing and theft, nudged (within limits) by the model with `adjust_feelings`, drifting slowly back toward neutral. Shown in STATE with the reasons.
  - *Ownership:* the bot knows whose base a chest or block is in: its own, ones it was told about, and ones it works out by watching who hangs around, opens chests or sleeps where. New `whose` action. `deposit` and `withdraw` never use someone else's chest any more.
  - *Noticing theft:* it remembers what's in its chests and notices when one comes up short, with ranked suspects (seen opening it, or hanging around). New `check_chests` action. It also notices live when someone opens its chest or breaks its base.
  - *Sneaky stealing:* `steal` only from players it dislikes enough, checks for witnesses (walls block the view), takes a modest share of the most useful items and never empties a chest.
  - *Sabotage:* only at deep hatred, small and non-destructive (take their torches, harvest their crops without replanting, block their door with one block), unseen, with a cooldown.
  - *Operator controls:* `!social`, `!social <feature> on|off` (switched-off actions vanish from the model's list), `!feelings`, `!feel`, `!protect`/`!unprotect`, `!suspects`, `!confess`. Protected players are never stolen from or sabotaged. `!forget <player>` also resets feelings.
- Line-of-sight checks (`W.lineOfSight`) used for aiming and for witnesses.
- The simulated-world harness moved to `sim/harness.js` so new sim files can share it; it now has chests with contents. `npm run test:sim` runs all sim files.
- Tests: 42 new (5 combat maths, 10 social, 1 brain/commands; 11 simulated fights with physics and real arrows, 15 social and exploration sims).

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
