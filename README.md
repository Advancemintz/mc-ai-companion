# MC AI Companion

![version](https://img.shields.io/badge/version-0.10.0-blue) ![minecraft](https://img.shields.io/badge/Minecraft%20Java-1.21.x-green) ![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

**Features at a glance:** chats and decides with any LLM · gets better with practice (skill tiers) · mines, crafts and smelts · fights with real technique (bows, crits, strafing) · explores and maps the land · builds real bases in several designs and upgrades them over time · farms crops and breeds animals · digs proper mines · builds Nether portals and makes careful trips · lays powered minecart railways · has its own goals, needs, memory and personality · holds lasting feelings about every player, knows whose base is whose, notices theft, and (if it comes to that) steals a little · server operators stay in control.

📜 [Changelog](CHANGELOG.md) · 🌐 [Project page](https://advancemintz.github.io/mc-ai-companion/)

> **Status: early.** Version 0.1 has been run on a real server. Later features were built and checked against simulated worlds and mock AI servers (162 automated tests: 80 unit + 82 simulated-world), but not yet played on a real server. Bug reports with terminal output are very welcome.

A Minecraft bot that joins your world as a player. An LLM is its **brain**: it chats and makes the big decisions. Plain code is its **body**: it handles walking, mining, fighting, crafting and building at full game speed.

```
 Player chat / action results / reflex reports
                     |
                     v
        +-------------------------+      slow (1-10 s), only on events
        |  BRAIN  (src/brain)     |  --> any LLM: Ollama, OpenAI, Claude,
        |  decides + talks        |      Gemini, or any OpenAI-compatible API
        +-------------------------+
                     |  plan: [collect_block oak_log 3, craft oak_planks 12, ...]
                     v
        +-------------------------+      fast (every game tick)
        |  BODY   (src/body)      |  --> pathfinding, mining, combat, crafting,
        |  executor + reflexes    |      building, eating, fleeing
        +-------------------------+
```

The model is only called when something happens: a player talks, a plan finishes or fails, it notices something (sunset, a friend arriving, diamonds), or it has been idle for a bit and decides what it wants to do next. The bot keeps moving while the model thinks.

## A mind of its own

With `bot.autonomous` on (the default), the bot is a fellow player, not just a helper:

- **Needs.** Every turn, code works out what the bot is missing and ranks it: night coming with no shelter, low food, no pickaxe or weapon, the next tool upgrade, no home, a full inventory. These give it reasons to act.
- **Goals.** It sets its own long-term goals ("build a cozy home", "get iron gear") with `set_goal`, works on them between requests, and marks them done. `!goals` shows them.
- **Memory.** Places (home, chests, mines, where it died), goals, a short journal, and notes about players are saved in `memory/<server>-<name>.json` and survive restarts. You can open and edit that file.
- **Noticing.** Sunset, thunderstorms, players joining or coming back, creepers, rare ores, being hit or given items. Interesting things wake it up so it can react on its own, at most once every 20 seconds.
- **Initiative.** After `idleThinkSeconds` with nothing to do, it decides for itself what to do next. Player requests always come first.

Its personality comes from `bot.personality` in the config. Give it likes, fears and quirks and its choices change. Set `autonomous` to `false` if you want it to wait for orders (it still handles urgent needs like nightfall).

**Cost note:** with a cloud model, an autonomous bot makes roughly 2-4 calls a minute while idle. Raise `idleThinkSeconds` to slow it down. Ollama is free.

## Skills: it gets better with practice

Every bot starts as a beginner and improves by doing, like a real player. Each skill has tiers, and the tier decides what the bot can do and how well it does it:

| Skill | Tiers |
|---|---|
| **Building** | 1 Dirt-hut novice: small huts only (flat-roofed box or peaked), misses the odd block · 2 Cabin builder (100 XP): small `build_base` bases in four designs, forgets some windows and torches; can add a storage room · 3 Homesteader (400 XP, needs mining 2): all base sizes with every detail; + watchtower and farmhouse designs; + bunker · 4 Architect (1200 XP, needs mining 3): two-storey houses; + the end-game manor and hillside fortress; + second storey and enchanting room upgrades |
| **Mining** | 1 Surface scraper: only stone and ores it can see · 2 Tunneler (60): its own `mine` for coal, copper and iron, with short branches · 3 Prospector (250): every ore, full branch mines and veins · 4 Deep miner (800): tighter, longer branches and bigger veins |
| **Combat** | 1 Panicky: slow to react, flails, sometimes just runs, flees early · 2 Scrapper (40): times swings to the weapon cooldown, fights the most dangerous monster first, backs off to eat · 3 Fighter (200): shield, backs off from creepers, strafes, bow on skeletons and creepers up to 16 blocks · 4 Veteran (700): critical hits, leads moving targets with the bow (24 blocks), fights on at lower health · 5 Champion (1600): crits almost every swing, unpredictable strafing, bow out to 32 blocks |
| **Exploration** | 1 Wanderer: `explore` up to 96 blocks from home for ~3 minutes; notices biomes and villages · 2 Scout (50): 192 blocks, 6 min; + caves, lava, other people's bases; heads for unexplored land · 3 Pathfinder (200): 384 blocks, 10 min; + structures (temples, outposts, dungeons, ruined portals...) · 4 Cartographer (600): 768 blocks, 15 min; marks big finds with a torch post |
| **Railways** | unlocks at building 2 + mining 2 · 1 Track layer: lines up to 100 blocks · 2 Engineer (120): up to 300 · 3 Rail baron (500): any length |
| **Farming** | 1 Seed planter: a 5x5 wheat patch next to water it finds · 2 Gardener (60): 9x9 farms anywhere (brings its own water), carrots, potatoes, beetroot, a fence · 3 Rancher (220): + `breed_animals` · 4 Agronomist (600): 11x11 farms and bone meal |
| **The Nether** | unlocks at combat 3 + mining 3 · 1 Portal builder: `build_portal`, short peeks through · 2 Day tripper (80): quartz, Nether gold, glowstone within 32 blocks · 3 Fortress raider (300): nether wart and blaze rods within 96 · 4 Piglin trader (900): bartering gold with piglins |

- **XP comes from results:** a finished base or upgrade, ores mined (diamonds count most), fights won (more for critical hits), crops harvested, new land mapped and things found, animals bred, Nether trips survived, track laid. Failed attempts give a little too.
- **Some tiers need other skills first.** For example, Homesteader needs mining tier 2.
- **Too-advanced requests fail politely:** "I haven't learned that yet… to improve: build huts and walls". The bot then practises the easier version.
- **Lessons:** after a failure the bot can save a one-line lesson with `note_lesson`, and it reads its lessons before trying again.
- **Specialisation:** `skills.affinity` makes each bot learn some skills faster. Give mike 1.5 for building and boot 1.5 for combat, and they naturally grow into different roles.
- **Saved progress:** skills are stored in the bot's memory file. `!wipe confirm` resets them too, and `!resetskills confirm` resets only the skills.

**Universal behaviours** are the same for every bot at every level, because every player just knows them: walking, eating, reflexes (except how well it fights), memory, tidy placement, respecting bases, feelings and ownership, and obeying operators.

**Settings** (`bot.skills` in `config.json`):

| Key | Default | Meaning |
|---|---|---|
| `mode` | natural | `natural` = earn XP; `fixed` = stay at the start tier |
| `startTier` / `startTiers` | 1 / {} | starting tier for all skills, or per skill (`{"building": 3}`); use 3 to start at the old full abilities |
| `caps` | {} | highest tier allowed per skill |
| `affinity` | 1.0 each | XP multiplier per skill (talents and weak spots) |
| `xpRate` | 1 | global XP speed |

### Adding new tiers

Tiers live in `src/skills/registry.js` as data: a name, XP needed, prerequisites, a plain-language description, and `params` that the action code reads. To add one:

1. Add the tier with its params.
2. Make the action read the new params (for example `ctx.skills.params('building').storeys`).
3. Add a simulated-world test that runs the action at that tier.

Blueprints and other content work best as data, so new variety (house styles, palettes) mostly means new data, not new code. That's what makes it practical to generate tiers in bulk later.

## Requirements

- **Node.js 20 or newer** (https://nodejs.org)
- **Minecraft Java Edition 1.21.x.** Mineflayer currently lists 1.21.1, 1.21.3, 1.21.4, 1.21.5, 1.21.6, 1.21.8, 1.21.9 and 1.21.11 as tested.
- **An LLM:** either [Ollama](https://ollama.com) running locally (free) or an API key for OpenAI, Anthropic or Gemini.

## Quick start

**The easy way: the setup page.** Run `npm run setup` (on Windows, double-click `setup.bat`). Your browser opens a page where you set the world and the AI once, then add as many bots as you like, each with its own name, personality, play style, talents, morals and AI model, or roll random ones. Start, stop and control them all from the same page. See *The setup page* below.

**By hand:**

1. Unzip the folder. Open a terminal in it and run:
   ```
   npm install
   ```
2. Edit `config.json`. At minimum, pick an LLM (see below) and write the bot's `personality`.
3. Start Minecraft, open a world, then go to **Esc -> Open to LAN -> Start LAN World**. Chat shows a port number such as `Local game hosted on port 54321`. Put that number in `minecraft.port`.
4. Run the bot:
   ```
   npm start
   ```
   On Windows you can also double-click `start.bat`. It installs packages the first time.
5. Talk to it in game chat: *"hey, can you get me some wood?"*

## The setup page

`npm run setup` (or `setup.bat` / `setup.sh`) starts a small page at `http://localhost:3000` and opens it in your browser. It only runs on your computer: nothing is put online, and other computers can't reach it. Leave the window open while the bots play; closing it stops every bot it started.

- **World and AI** (asked the first time): the server address and port, offline or Microsoft accounts, the Minecraft version, the AI provider, model and key, players to protect from stealing and sabotage, and operators.
- **Bots:** each bot gets a card with tabs:
  - *Who they are:* name, first words, play style, honesty and the personality text. **Randomize** rolls a new character; tick the parts you want to keep (the name, the personality, the talents...).
  - *Skills:* how fast it learns each skill (talent sliders) and which tier it starts at.
  - *Brain and morals:* its own AI provider or model if you like, whether it acts on its own, how quickly it decides things, and its morals: whether and when it steals or sabotages, how fast grudges fade, and who it never targets.
  - *Live* (while it runs): health, food, position and what it's doing; pause, resume, stop its task, make it decide something, switch autonomy; talk to it or send any `!` command (the page counts as an operator); set how it feels about a player, protect players, set skill tiers and switch social features. Below that, what it knows: skills and XP, feelings with the reasons, goals, recent memories, explored land and finds, thefts from it, and its own secrets.
  - *Log:* everything it prints, live.
- **Changing a bot later:** live controls apply at once. Edits to its card (personality, name, model, talents, morals) are saved straight away and apply when it restarts; the page shows a *Restart now* button. A restart keeps its memories, skills and feelings, and renaming a bot keeps them too.

**Play styles** (the randomizer picks one, or choose it yourself): builder, miner, warrior, explorer, farmer, engineer, adventurer and hoarder, each with matching talents and one weak spot. **Honesty**: honest (never steals), fair, sly, or light-fingered, which set the stealing and sabotage thresholds and how long grudges last.

Everything is saved in the `bots` folder: `roster.json` (the page's list, including API keys, so keep that folder private) and one ordinary config file per bot, `bots/<name>.json`. Every bot automatically lists the others in `otherBots`. You can still start any bot by hand with `node src/index.js bots/<name>.json`. The first time, the page copies your existing `config.json` in as the first bot.

## Connecting to your world

| Setup | What to put in `minecraft` |
|---|---|
| Singleplayer world opened to LAN | `host: "localhost"`, `port`: the number shown in chat |
| Your own local server | `host: "localhost"`, `port: 25565` |
| A friend's server | their address and port |

**Account checks (online mode).** Many servers and LAN worlds check that every player owns a real Minecraft account. If the bot gets kicked with *"Failed to verify username"*, pick one of these:

- **Local server:** set `online-mode=false` in `server.properties`. This is the easiest way to test.
- **LAN world:** install a mod that turns off online mode for LAN, such as "LAN World Plug-n-Play" or "Custom LAN" (Fabric/Forge).
- **Use a second Microsoft account** that owns Minecraft. Set `"auth": "microsoft"` and set `username` to that account's email. On first run the terminal shows a code to enter at microsoft.com/link.

Leave `version: false` to auto-detect the version. If that fails, set it explicitly, e.g. `"version": "1.21.4"`.

## Choosing the LLM

Set `llm.provider` to one of the sections under `llm.providers`:

| Provider | Setup |
|---|---|
| `ollama` (local, free) | Install Ollama, then run `ollama pull qwen3:8b`. Any instruction-following model works. Bigger is smarter but slower. `think: false` turns off slow "thinking" mode on models that have it. |
| `openai` | Set `apiKey` (or env `OPENAI_API_KEY`) and `model`. Uses the Responses API. `reasoningEffort: "low"` keeps replies quick. |
| `anthropic` | Set `apiKey` (or env `ANTHROPIC_API_KEY`) and `model` (e.g. `claude-haiku-5-5` for speed). |
| `gemini` | Set `apiKey` (or env `GEMINI_API_KEY`) and `model` (e.g. `gemini-3.6-flash`). |
| `openai-compatible` | Any server that speaks the OpenAI chat-completions format: LM Studio (`http://localhost:1234/v1`), OpenRouter, Groq, DeepSeek, Mistral, vLLM, llama.cpp. Set `baseUrl`, `model`, and `apiKey` if needed. Set `jsonMode: true` if the server supports `response_format`. |

Model names change often. If a name is rejected, check the provider's model list and update `model`.

Environment variables override the config file, so keys don't have to be saved in it. You can also switch provider without editing anything: `LLM_PROVIDER=anthropic npm start`.

**Tips:** Small fast models feel the most "alive". Cloud models plan better for long multi-step goals. Every provider gets the same JSON reply format, so switching is just a config change.

## Talking to the bot

Just chat normally:

- "follow me" / "come here" / "stay here and guard me"
- "get me 10 oak logs", "mine some iron", "make me a stone pickaxe"
- "smelt the iron", "build a hut", "make a 7 long wall out of dirt"
- "put your stuff in the chest", "give me your bread", "go sleep"
- "go explore up north", "whose chest is that?", "did anyone take stuff from your chests?"
- "what do you have?", "how are you doing?"

Nobody owns the bot. Whether it does what you ask depends on its personality, its mood and what it thinks of you.

## Operator control

**Server operators** can always control it with `!` commands. These skip the LLM, so the bot can't refuse them:

| Command | Who | Does |
|---|---|---|
| `!status`, `!goals`, `!skills`, `!help` | anyone | health/activity, its goals, its skill tiers, the command list |
| `!stop` | OP | stop everything |
| `!come [player]`, `!follow [player]` | OP | walk to / follow you (or the named player) |
| `!think` | OP | make it decide what to do on its own right now |
| `!pause` / `!resume` | OP | freeze its brain (it still defends itself) / wake it up |
| `!autonomy on` / `off` | OP | let it act on its own, or only when asked |
| `!reset` | OP | clear the current conversation (long-term memory stays) |
| `!forget <player>` | OP | erase what it thinks of one player |
| `!wipe confirm` | OP | erase all of its memories: places, goals, journal, opinions |
| `!op <name>` / `!deop <name>` | OP | let someone else control it, or take that away |
| `!quit` | OP | log the bot off |
| `!skill <name/all> tier <n>` | OP | fix a skill at a tier (`natural` to go back to earning it) |
| `!skill <name/all> cap <n>` / `nocap` | OP | limit a skill's tier |
| `!skill <name/all> xp <n>` / `lock` / `unlock` / `reset` | OP | set XP, freeze progress, or start over |
| `!resetskills confirm` | OP | every skill back to tier 1 (memories kept) |
| `!social` | OP | show which social features are on |
| `!social <all\|feelings\|ownership\|stealing\|theft\|sabotage> on\|off` | OP | switch a social feature (or all of them) on or off, live. Switched-off actions disappear from the model's action list |
| `!feelings [player]` | OP | how it feels about everyone (or one player, with the reasons) |
| `!feel <player> <-100..100>` / `!feel <player> reset` | OP | set or reset how it feels about someone |
| `!protect <player>` / `!unprotect <player>` | OP | protected players are never stolen from or sabotaged, and its feelings about them never drop below -50 |
| `!suspects` | OP | thefts from its chests and who it suspects |
| `!confess` | OP | what it has stolen and sabotaged lately |

**How it knows who is OP.** Minecraft doesn't tell other players who is an operator, so the bot recognizes them in three ways:

1. **`/say`**, which only OPs can use. Type `/say !stop` once, and the bot runs the command and remembers you as an operator, so plain `!stop` works for you from then on. In a singleplayer LAN world this needs cheats on.
2. **`admins`** in the config: a list of names that can always control it.
3. **`opsFile`** in the config: the path to the server's `ops.json`, if the bot runs on the same machine as the server.

The terminal window counts as an operator too.

**Multiple AI bots.** The setup page runs as many as you like from one PC, each in its own process (the AI is usually the limit: several bots on one local Ollama model take turns thinking, so a cloud provider or a smaller model helps). By hand, give each bot its own config file and put the other bots' names in `otherBots` (e.g. `["mike", "slip", "boot", "em"]`). The bot then knows they're AI characters and answers them at most once every `botChatCooldownSeconds`, so two bots can't chat back and forth forever and burn through your LLM budget.

## What the body can do

| Action | Notes |
|---|---|
| `follow_player`, `go_to_player`, `go_to` | pathfinding with parkour, digging and bridging |
| `collect_block` | finds, mines and picks up blocks. Understands "wood", "iron", "cobblestone"... Checks for the right tool. |
| `attack` | a mob type, "hostile" (the most dangerous monster around), or a player. Fights with its combat tier (see below) and picks up drops. |
| `guard` | stays put (or by a player) and kills monsters that come close, most dangerous first |
| `explore` | a trip into land it hasn't seen, remembering what it finds, home before dark (see below) |
| `craft` | finds or places a crafting table. Says exactly which ingredients are missing. |
| `smelt` | uses a nearby or carried furnace and picks fuel automatically |
| `build` | hut (walls, roof, doorway; `size` 2-7), wall, tower, platform, floor. Picks a flat, open, dry spot within 16 blocks on its own, clears leaves/plants, levels small bumps, fills dips, and mixes materials if one isn't enough. The first hut is saved as home. |
| `build_base` | a real base in one of several designs, as a resumable project (see below) |
| `upgrade_base` | improve the base you have: storage room, bunker, second storey, enchanting room (whichever fit the design) |
| `farm`, `breed_animals` | a crop farm near home that it tills, plants, harvests and replants; breeding animals (see below) |
| `build_portal`, `nether_trip` | build and light a Nether portal; a careful round trip to gather one thing (see below) |
| `mine` | a proper mine: covered entrance away from bases, stairs to the right depth for the ore, branch mining (see below) |
| `plan_railway`, `build_railway`, `ride_railway` | powered minecart lines between bases and places (see below) |
| `protect_area`, `unprotect_area` | mark a place (a friend's house, a farm) the bot must never dig in |
| `clean_inventory` | store everything in a nearby chest, or drop junk and extra dirt/gravel |
| `go_to_surface` | climbs or digs out to open sky when underground |
| `remember_place`, `go_to_place`, `forget_place` | named places in long-term memory (home, mine, village...) |
| `set_goal`, `complete_goal`, `note_player` | the bot's own goals and what it knows about players |
| `place_block`, `equip`, `give`, `drop`, `eat`, `sleep` | |
| `deposit`, `withdraw` | nearest chest or barrel that is its own (or nobody's), never someone else's; checks its own chests for theft while it's there |
| `whose` | whose base a spot or the nearest chest is in |
| `adjust_feelings` | the model nudges its feelings about someone for things the game can't see (an insult, a favour); capped |
| `check_chests` | goes round its own chests and reports anything missing, with suspects |
| `steal`, `sabotage` | the mischief described under *Feelings, property and mischief* below, with strict limits |
| `find_block`, `wait`, `stop` | |

### Fighting

Fights are handled by code, so they're fast, but how well the bot fights depends on its combat tier. The same engine runs the self-defense reflex, `attack`, `guard` and blaze hunting in the Nether.

- **Timed swings (tier 2+).** It waits for the weapon's attack cooldown (a sword every 0.625 s, an axe every 1-1.25 s) so every hit does full damage. A beginner flails.
- **Most dangerous first (tier 2+).** A creeper walking up beats the zombie it's already fighting; skeletons and witches beat spiders. A beginner turns on whatever is nearest or hit it last.
- **Backing off to eat (tier 2+).** When its health drops low mid-fight it retreats a few blocks, eats (a golden apple if things are serious), and goes back in.
- **Shield and creeper dodging (tier 3+).** It raises a shield between swings, and steps back after every hit on a creeper so the fuse never finishes.
- **Strafing (tier 3+).** In melee it circles its target instead of standing still: steady side-steps at tier 3 and 4, unpredictable at tier 5.
- **Bow (tier 3+).** With a bow and arrows, it shoots skeletons, strays, creepers, witches, pillagers and blazes while they're still at a distance (16 blocks at tier 3, 24 at tier 4, 32 at tier 5). Aim follows real arrow physics (speed, drag and gravity); from tier 4 it leads moving targets. Too close, out of arrows or no line of sight, and it switches to the sword.
- **Critical hits (tier 4+).** It jumps and strikes on the way down for +50% damage: a good share of swings at tier 4, nearly every one at tier 5.

### Exploring

`explore` (optionally with a `direction`: north, northeast, east...) is a round trip:

1. It picks the direction with the most land it hasn't seen (a beginner just picks any new-ish direction). The map of what it has seen is kept in memory as 32x32-block areas, so each trip covers new ground.
2. It walks out in hops (16-32 blocks, by tier), looking around after each one, and veers around water or cliffs that block the way.
3. It remembers what it finds: **biomes**, **villages** (bells, villagers), **caves** (cave air, shafts into the dark), **lava** (as a hazard), **structures** (dungeons, trial chambers, ruined portals, desert and jungle temples, pillager outposts, witch huts, ocean monuments, mineshafts, strongholds, ancient cities, trail ruins, igloos, mansions, shipwrecks) and **other people's bases** (furniture out in the wild, away from villages). Villages, caves and structures become places it can `go_to_place` later; a Cartographer marks them with a torch on a cobblestone post.
4. It comes home when it would otherwise be caught by nightfall (it works out how long the walk home takes and keeps some daylight spare), when it gets hurt or hungry, when its pockets are full, when it reaches the edge of its range (after one sideways sweep), or when the trip time is up.

A fight or a snack in the middle of a trip doesn't end it: the trip resumes where it was. STATE shows how much of the land within 96, 192 and 384 blocks of home has been explored, and the nearest finds. Its needs and the autopilot suggest a trip on mornings when most of the land around home is still unknown.

## Feelings, property and mischief

This part is built for **servers where the players are AI bots** (like a livestream of bots starting a world together). The bots form opinions of each other, keep track of whose things are whose, and the ones that end up disliking each other may help themselves to each other's chests. Every part can be switched off, and any player can be protected. If a human plays too, list them in `social.protected`.

**Feelings.** Every player gets a lasting score from -100 to +100: deep hatred (-80 and below), hate, dislike, neutral, like, friend, best friend (80 and up). They change by themselves when things happen:

| Event | Change |
|---|---|
| gives you something | +4 |
| hits you | -6 |
| kills you | -25 |
| breaks a block in your base | -10 |
| opens your chest | -2 |
| seen opening a chest that then came up short | -30 |
| was hanging around a chest that came up short | -12, shared between the suspects |

The model can also nudge feelings with `adjust_feelings` for things the game can't see (a kind word, an insult, a broken promise), at most ±15 at a time and 30 points per player per hour, so feelings come from what actually happens rather than one bad chat line. Scores drift back toward neutral by `decayPerDay` points per real day. STATE shows the feelings toward people nearby (with the last reasons), and the prompt tells the bot to let them show in how it talks and whether it helps.

**Ownership.** The bot knows whose base a block or chest is in:
1. its own bases, home and farm;
2. bases it was told about (`remember_place` with an `owner`);
3. bases it worked out by watching: someone hanging around the same furniture again and again, opening the chests there, or sleeping in the bed there. When it's sure, it says so ("It looks like slip lives around...").

`whose` answers the question for any spot. `deposit` and `withdraw` only ever use its own chests or ones nobody owns; taking from someone else's chest is stealing, which is a separate, limited action.

**Noticing theft.** Every time the bot closes one of its own chests, it remembers what was inside. The next time it opens that chest (to deposit, withdraw, or with `check_chests`), it compares. If something is missing it logs a theft with a ranked list of suspects: anyone **seen opening that chest** (the lid opening while they stood next to it) comes first, then anyone **seen hanging around** since it last looked. Their feelings drop, STATE shows a THEFT line, and the bot decides in character what to do about it: confront, accuse, demand it back, or quietly hold a grudge. It also notices live when someone opens its chest or breaks a block in its base.

**Sneaky stealing** (`steal`, from a player or a specific chest):
- only from players it feels `stealing.feelingAtMost` (-20) or worse about, and never from protected players;
- it checks for **witnesses** first: anyone within `witnessRadius` who could see the chest (walls block the view, glass and leaves don't). It waits up to `patienceSeconds` for them to leave, then backs out if they don't. It checks again once it's at the chest, and crouches while it works;
- it takes a **modest share of the most useful items**: at most `maxShare` (25%) of each stack and of the whole chest, at most `maxItemTypes` (3) kinds, best stuff first (diamonds, ingots, golden apples before bread, before torches; junk like cobblestone is never worth it);
- it **never empties a chest**, never takes the last of something unless the chest is well stocked, and skips chests with fewer than `minChestItems` items;
- it lies low for `cooldownMinutes` before stealing from the same player again, and it remembers what it did (STATE shows it as "Your secret"), so it can lie about it or own up as its personality sees fit.

**Sabotage** (`sabotage`) only unlocks at **deep hatred** (`sabotage.feelingAtMost`, -80), never against protected players, only unseen, and it's small: taking a few of their torches or lanterns (`torches`), harvesting their ripe crops without replanting (`crops`), or blocking their door with one block from the outside (`doorway`). At most `maxBlocks` per go, once per `cooldownMinutes`. It never breaks walls, never uses lava, fire or TNT.

**Ideas.** Now and then, if a player it dislikes enough seems to be away from their base, the bot gets a `[sneaky idea]` (or a `[revenge idea]` at deep hatred). Like the railway offers, it's the personality that decides whether to act on it. It's also nudged to `check_chests` when it hasn't looked in a while and others have been around.

**Settings** (`social` in `config.json`; `!social` switches them live):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | true | the whole social side |
| `feelings.enabled` / `start` / `decayPerDay` / `modelMaxPerHour` | true / 0 / 2 / 30 | lasting feelings; starting score; drift back toward 0 per day; how far the model may move one player's score per hour |
| `ownership.enabled` / `learn` / `claimRadius` | true / true / 12 | knowing whose base is whose; working it out by watching; base radius |
| `stealing.enabled` | true | the `steal` action |
| `stealing.feelingAtMost` | -20 | only steal from players at or below this score |
| `stealing.maxShare` / `maxItemTypes` / `minChestItems` | 0.25 / 3 / 4 | how little it takes |
| `stealing.witnessRadius` / `patienceSeconds` / `cooldownMinutes` | 24 / 20 / 20 | how careful it is |
| `theftDetection.enabled` | true | checking its own chests |
| `sabotage.enabled` / `feelingAtMost` | true / -80 | the `sabotage` action, and the deep-hatred threshold |
| `sabotage.maxBlocks` / `cooldownMinutes` / `kinds` | 6 / 60 / torches, crops, doorway | how much, how often, and which kinds are allowed |
| `protected` | [] | players never stolen from or sabotaged (operators can add more with `!protect`) |

### Bases

`build_base` is a long, resumable project. The bot plans the base from a fixed blueprint, compares it with the world, and does whatever is still missing. If it gets interrupted (a fight, nightfall) or runs out of blocks, it reports exactly what it needs. Running it again continues on the same spot; the project is kept in memory.

- **Surface** (`small` 7x7, `medium` 9x9, `large` 11x11). It searches 20 blocks around for the flattest dry spot, clears trees and plants, digs down bumps and fills dips (including a walkway around the house). Then it builds a log-framed house with a stone floor, plank walls, a log-trimmed roof, glass windows, a door, torches inside and by the door, and any crafting table, furnace, chests and bed it carries. Roughly 150 / 260 / 370 blocks, mostly planks or cobblestone plus 20-30 logs. Glass, doors and torches are optional and can be added later.
- **Underground** (`depth` 6-24, default 10). It digs a two-wide staircase with three blocks of headroom down to a carved room. The entrance is covered, with walls, a roof and a double door, and torches light the stairs and room. Every face of the dug space is checked: holes into caves are filled, and water or lava that pours in gets plugged (and dug out again once it's safe). It needs a pickaxe, and it produces plenty of cobblestone.
- `plan_only: true` picks the spot and lists the materials without building anything.
- When it's finished, the base becomes `home` (any older home is kept as `old_home`), and the entrance is saved too.

**Designs.** Each base picks a design at random from the ones the bot knows, or uses the one you ask for with `variant`, so not every base looks the same. The bot's newest designs are the likeliest pick, since a good builder mostly builds its best, but older ones still turn up. If the land doesn't suit the design it picked (no room for a manor, no hill to dig into), it tries the next one and says so.

| Tier | Surface | Underground |
|---|---|---|
| 1 | `build` huts: **box** (flat roof) or **peaked** | |
| 2 | **cottage**: square, log-framed, flat roof · **longhouse**: long and narrow with a peaked roof | **cellar**: square room · **hall**: a long hall with stone pillars |
| 3 | **watchtower**: a stone tower with a living room, a bedroom and a lookout floor, a ladder all the way up, and a battlemented roof platform · **farmhouse**: L-shaped, with a peaked roof, a kitchen/pantry wing (smoker, barrels), a covered front porch and a yard in the corner of the L | |
| 4 | **manor** (below) | **hillside fortress** (below) |

**The end-game homes (tier 4).** Both are built around what a late-game player actually uses, so the bot (and you) can do almost everything from home:

| Room | Manor (two storeys, 17-21 wide) | Hillside fortress (dug into a hill) |
|---|---|---|
| Storage | ground-floor vault: a wall of double chests, more chests on the back wall, barrels, an ender chest | vault off the great hall: a wall of double chests, barrels, an ender chest |
| Workshop / forge | crafting table, furnace, blast furnace, smoker, anvil, smithing table, grindstone, stonecutter, loom, cartography and fletching tables, two chests | crafting table, furnace, blast furnace, smoker, anvil, smithing table, grindstone, stonecutter, loom, cartography table |
| Enchanting | upstairs library: enchanting table with all 15 bookshelves at the right distance, a lectern | a library behind the hall, the same full ring |
| Beds | 4 beds (one per bot or player) | 3 beds |
| Brewing | brewing stand, cauldron, chests | its own room with brewing stand, cauldron, chests |
| Extras | central hall with a ladder upstairs, a balcony over the front door on a covered porch, a peaked roof with attic windows, stone ground floor and wooden upper floor | a stone facade with windows on the hill face, an entry corridor, a pillared great hall 4 blocks high, every face of the dug space sealed |

A medium manor is about 1,400 blocks plus the furniture, so it's a long project. The bot builds the shell first, places whatever furniture it carries, and lists every empty furniture spot ("13 chest, 1 anvil, 15 bookshelf..."). When it later carries any of those, calling `build_base` again on the finished base puts them in place. The hillside fortress needs a hill or cliff at least 7 blocks high within 24 blocks, mostly solid inside.

**Upgrades instead of starting over.** A better builder doesn't abandon its first house: `upgrade_base` adds to the base it already has. Each upgrade is just more cells in the same blueprint, so it's resumable, and the protected zone grows to cover it.

| Upgrade | Tier | What it adds |
|---|---|---|
| `storage_room` | 2 | a side room with up to three chests along the far wall, joined into a double chest (carved out next to the room for underground bases) |
| `bunker` | 3 | surface only: a safe room dug under the house, reached by a ladder shaft from the floor, with a chest |
| `second_storey` | 4 | surface only: rebuilds the roof as an upper floor with a log band, a ladder and an upstairs bedroom |
| `enchanting_room` | 4 | a side room with an enchanting table ringed by all 15 bookshelves, one gap to walk in |

Not every upgrade fits every design: a watchtower can take a storage room, a bunker or an enchanting room but not a second storey; a farmhouse takes a storage room, bunker or second storey; the manor and the hillside fortress already have their vault and library built in (a manor can still get a bunker).

The bot's memory lists each base with its design and upgrades, and its needs suggest the upgrades it knows but hasn't built yet. The upgrade code refuses if a new room would cut into someone else's build.

### Farming

`farm` keeps one crop farm near home:

- **The first call picks the plot.** At tier 1 it has to be next to water the bot finds (a 5x5 patch around a water block). From tier 2, a water bucket lets it dig a hole in the middle of a flat spot and make its own water source (9x9; 11x11 at tier 4).
- **Each call is one round:** it harvests ripe crops and replants them straight away, tills new ground and plants seeds it carries, using bone meal on young crops at tier 4. From tier 2 it fences the plot in (leaving a gap) if it has fences.
- **It needs a hoe** (it crafts a wooden one if it can) **and seeds**; with no seeds it pulls up grass for wheat seeds. Tier 2 adds carrots, potatoes and beetroot.
- The farm is saved in memory and protected. The bot's needs and the autopilot bring it back once the crops have had about 25 minutes to grow.

`breed_animals` (tier 3) feeds two adults of a kind with the right food (wheat for cows and sheep, carrots/potatoes/beetroot for pigs, seeds for chickens, carrots for rabbits).

### The Nether

The Nether is a late skill: it unlocks only at combat 3 and mining 3. If your personality prompt says the Nether is only a story, you can keep it that way with `!skill nether lock`.

- **`build_portal`** finds a flat, open spot near home (outside any base) and builds a 4x5 frame: 10 obsidian, plus obsidian or cobblestone for the corners. It crafts flint and steel if it has iron and flint, lights the portal, and saves it as `nether_portal`.
- **`nether_trip`** (`get`: netherrack, quartz, gold, glowstone, nether_wart, blaze_rod, barter, or look) refuses unless the bot is healthy and has food. It walks into the portal, remembers the Nether side, gathers within the range and time its tier allows, and comes back through.
  - It turns back early if it gets hurt or hungry.
  - It won't mine Nether gold with piglins nearby.
  - Bartering needs gold armour on.
  - Blaze hunting uses the normal combat code.
- The Nether can't be simulated well, so trips are the least tested part of this release. Watch the first few.

### Mining

`mine` (target: coal, copper, iron, lapis, gold, redstone, diamond, emerald or stone) digs **one tidy mine** instead of random holes:

1. It picks an entrance on open ground at least 6 blocks outside any base, with the tunnel heading away from home.
2. It digs a covered stairwell: two blocks wide at the top with walls, a roof and double doors, then one block wide all the way down, with torches every few steps. Caves, water and lava it breaks into get sealed off.
3. At the best depth for the target (iron y=16, gold y=-16, diamond/redstone y=-58, coal/copper y=48, lapis y=0), it branch-mines: a main tunnel with side branches every 4 blocks. It digs out every ore vein it uncovers and places torches.
4. The mine is remembered. Each call digs further, and asking for a different ore adds a new level off the same staircase.

`collect_block` now only takes ores and stone you can actually see (on cliffs or in caves). For buried ores it tells the bot to use `mine`.

### Railways

`build_railway` (to a saved place, a player's name for their base, or `"x z"`) builds a powered minecart line from the bot's home, or from `from`:

- **Route:** an L-shaped line (one straight run, one corner). Both stations sit just outside any base, so it never digs into anyone's build. It picks whichever L-shape avoids other protected areas.
- **Track:** follows the land, at most one block up or down per block, and smooths out small bumps. It tunnels through hills (3 blocks high), bridges dips and water on cobblestone, and keeps corners flat (curves can't be on slopes).
- **Power:** a powered rail every 24 blocks on the flat and on every uphill rail, each lit by a redstone torch beside the track.
- **Stations:** a buffer block, a brake/launch powered rail, a button beside it and a little platform. Put a minecart on the end rail, get in, press the button. Arriving carts brake and stop.
- **Materials:** it crafts rails, powered rails and redstone torches from iron, gold, redstone and sticks as it goes. `plan_railway` gives the bill of materials and says whether it's easy to gather. Roughly, per 100 blocks: ~90 rails (36 iron), ~6 powered rails (6 gold), ~4 redstone torches, plus cobblestone for bridges.
- **Resumable:** it builds in 24-block sections and saves after each one. If it runs out, it says exactly what it needs, and the next call continues from there. `ride_railway` lets the bot use a finished line (it needs a minecart).

**Players' bases and weekly offers.** When the bot learns where someone lives, it saves the place with `remember_place` and `owner`, and the area becomes protected (radius 12). About once a week per player (`railOffers.intervalDays`), if that base is at least `minDistance` blocks from home and the bot already has the materials, or could get them with a short mining trip, it gets a `[railway idea]`. Its personality decides whether to actually offer. It only builds to someone's base after they say yes. If it doesn't know where a nearby player lives, it may ask.

### Behaving like a tidy player

- **Furniture goes in sensible places.** Chests, crafting tables, furnaces, beds and so on go against a wall, never in the middle of a room, never in a one-wide corridor, and never next to a door. They face into the room. A new chest is placed beside an existing single chest so the two join into a double chest. Work blocks are grouped together, and a bed's head goes against a wall.
- **Temporary work blocks get picked up.** A crafting table or furnace set down out in the wild for one job is picked back up afterwards. Inside a base it stays.
- **Bases are protected.** The pathfinder never digs or pillars inside a base (or an area marked with `protect_area`). It never breaks player-made blocks anywhere (planks, glass, chests, crops...), and `collect_block` never harvests from a base. The bot can now open doors, so it can get in and out.
- **It doesn't stand around.**
  - *Plan ahead:* while the last step of a plan is running, the model is asked what comes next, so the bot moves straight on.
  - *Watchdog:* an action with no progress for `stuckSeconds` (no movement, digging, placing, or new items) is cancelled, and the model re-plans.
  - *Autopilot:* if the model chooses to do nothing twice in a row, or can't be reached, the body picks something sensible itself. That might be going home at night, tidying a full inventory, continuing an unfinished base, hunting when food is low, collecting wood, joining a nearby player, or looking around.
  - *Idle animation:* when it's idle it looks at nearby players and glances around instead of freezing.

**Reflexes** run without the LLM, several times a second:

- **Self-defense:** fights monsters within `defendRadius` and whatever hits it, with all the technique its combat tier allows (see *Fighting*).
- **Flee:** runs away when health drops to `fleeHealth` or below and a monster is near, then eats.
- **Auto-eat:** eats the best food when hungry.
- **Auto-armor:** wears the best armor it picks up.
- **Swim up** when out of air.

When a reflex interrupts a task, the task resumes afterwards with what's left. For example, after a fight it goes back to mining the remaining logs.

## Config reference

| Key | Default | Meaning |
|---|---|---|
| `minecraft.host` / `port` | localhost / 25565 | where to connect |
| `minecraft.username` | Companion | bot name (or Microsoft email when `auth` is `microsoft`) |
| `minecraft.auth` | offline | `offline` or `microsoft` |
| `minecraft.version` | false | `false` = auto-detect, or e.g. `"1.21.4"` |
| `bot.admins` | [] | names that can always use operator commands |
| `bot.opsFile` | "" | path to the server's ops.json (optional) |
| `bot.otherBots` | [] | names of other AI bots on the server |
| `bot.botChatCooldownSeconds` | 30 | answer other bots at most this often |
| `bot.personality` | | first lines of the system prompt; make it yours |
| `bot.respondTo` | all | `all` chat, or only messages that `mention` its name |
| `bot.greeting` | | said on join (empty = silent) |
| `bot.autonomous` | true | acts on its own needs and goals when nobody needs it |
| `bot.idleThinkSeconds` | 10 | how long it stays idle before deciding something itself |
| `bot.planAhead` | true | ask the model for the next step while the last one is still running |
| `bot.autopilot` | true | do something sensible when the model keeps choosing to idle |
| `bot.stuckSeconds` | 40 | cancel an action that makes no progress for this long |
| `bot.railOffers` | on, 7 days, 40 blocks | weekly railway offers: `enabled`, `intervalDays`, `minDistance` |
| `bot.memoryName` | "" | name of its memory file; empty = `<host>-<username>`. Use a different name per world to keep separate memories |
| `bot.maxChainedSteps` | 10 | how many times it may re-plan on its own before waiting for a player |
| `bot.reconnect` | true | reconnect after disconnects |
| `bot.showThoughts` | true | print the model's reasoning in the terminal |
| `reflexes.*` | | turn reflexes on/off, `defendRadius`, `fleeHealth` |
| `social.*` | see *Feelings, property and mischief* | feelings, ownership, theft detection, stealing, sabotage, protected players |
| `llm.temperature` | 0.6 | creativity (ignored by OpenAI reasoning models unless set per provider) |
| `llm.maxHistory` | 16 | past messages sent each time (more = better memory, slower and costlier) |
| `llm.timeoutSeconds` | 90 | give up on a slow model after this long |

Use a different config file with `node src/index.js my-other-config.json`. Set `DEBUG=1` to print the full prompt sent each turn.

## Troubleshooting

- **`ECONNREFUSED`:** the world isn't open to LAN, or the port is wrong. The LAN port changes every time you open to LAN.
- **"Failed to verify username":** see *Account checks* above.
- **The bot answers but doesn't move:** watch the terminal. Failed actions print a reason, such as "no path" or "need a tool".
- **"can't reach my AI brain":** check that Ollama is running (`ollama list`) or that the API key and model name are right. The terminal shows the exact error.
- **Slow replies:** use a smaller or faster model, lower `maxHistory`, or keep `think: false` for Ollama.
- **The bot ignores chat on a server with a chat plugin:** custom chat formats can hide the sender's name. Whisper to it instead (`/msg Companion hi`) or set the server's chat format to vanilla.

## Adding a new action

Add an entry to `src/body/actions.js`:

```js
actions.wave = {
  description: 'Look at a player and swing your arm.',
  params: { player: 'player name' },
  run: async (ctx, { player }) => {
    const target = W.playerEntity(ctx.bot, player)
    if (!target) throw new Error(`I can't see ${player}`)
    await ctx.bot.lookAt(target.position.offset(0, 1.6, 0))
    ctx.bot.swingArm()
    return 'waved'
  }
}
```

The brain's prompt picks it up automatically. Use `ctx.sleep()` and `ctx.race()` for waiting so `!stop` can cancel it. Return a short result string, and throw an `Error` with a helpful message when it fails.

## Project layout

```
src/index.js          connect, load plugins, wire brain + body, reconnect
src/config.js         load config.json + env overrides
src/llm/providers.js  Ollama / OpenAI / OpenAI-compatible / Anthropic / Gemini adapters
src/brain/            prompt, event loop, forgiving JSON parser
src/brain/memory.js   places, goals, journal, player notes (saved to memory/)
src/brain/drives.js   needs: shelter, food, tools, home...
src/brain/senses.js   noticing: sunset, players, ores, danger
src/brain/admin.js    who counts as a server operator
src/body/terrain.js   surface/underground detection, build-site finder
src/body/builder.js   base blueprints, site choice, resumable build engine
src/body/motion.js    shared walking/placing helpers
src/body/mining.js    the mine action: entrance, stairs, branch mining
src/body/homes.js     base designs (cottage, longhouse, cellar, hall), design choice and upgrades
src/body/designs.js   tier 3-4 designs: watchtower, farmhouse, manor, hillside fortress
src/body/farming.js   the farm and breed_animals actions
src/body/nether.js    portal building and Nether trips
src/body/placement.js where furniture goes (walls, double chests, beds)
src/body/zones.js     protected areas and no-grief pathfinding
src/body/idle.js      idle animation
src/brain/autopilot.js  fallback activities when the model idles
src/body/combat.js    the fighting engine: priorities, timed swings, crits, strafing, shield, bow ballistics, eating
src/body/explore.js   the explore action: direction choice, scanning for finds, coming home in time
src/brain/social.js   feelings, ownership, chest ledger and theft suspects, stealing/sabotage rules
src/brain/socialSenses.js  watching players: chest opens, sightings, whose base, griefing, ideas
src/body/sneaky.js    whose/steal/sabotage/check_chests/adjust_feelings, witnesses, chest audits
src/manager/          the setup page: server.js (local web API), page.html, roster.js (bots and their config files),
                      processes.js (starting and talking to bots), randomize.js (characters), mind.js (memory view)
src/body/railway.js   railway routes, track, power, stations
src/brain/railOffers.js  weekly railway offers to players
src/skills/registry.js  the skill library: tiers, XP, prerequisites, params (data)
src/skills/skillbook.js  a bot's progress: XP, level-ups, caps, lessons, operator controls
src/body/actions.js   every action the model can choose
src/body/executor.js  runs plans, cancellation, reflex interrupts + resume
src/body/reflexes.js  eat / defend / flee / swim
src/body/perception.js  the "what I see" summary sent to the model
test/                 unit tests (npm test), no Minecraft needed
sim/                  simulated-world tests (npm run test:sim); sim/harness.js is the fake world
```

## Contributing

Issues and pull requests are welcome. Run `npm test` (fast unit tests) and `npm run test:sim` (simulated-world tests: real actions against a fake in-memory world, a few minutes) before sending changes. Neither needs Minecraft. When reporting a bug, include the terminal output around the problem and your Minecraft version and LLM provider.

## Ideas for later

- Package as a single download (Node's single-executable apps).
- A "skill library": save successful multi-step plans and reuse them.
- Danger reflexes (lava, falls, getting stuck), crossbows and tridents.
- Schematic-based building, doors and beds in huts, villager trading, bastions, melon/pumpkin and auto-farms.
- Voice chat via speech-to-text.
