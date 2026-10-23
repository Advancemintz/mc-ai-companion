# MC AI Companion

![version](https://img.shields.io/badge/version-0.6.0-blue) ![minecraft](https://img.shields.io/badge/Minecraft%20Java-1.21.x-green) ![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

**Features at a glance:** chats and decides with any LLM · mines, fights, crafts and smelts · builds real bases (surface or underground) · digs proper mines · lays powered minecart railways · has its own goals, needs, memory and personality · server operators stay in control.

📜 [Changelog](CHANGELOG.md) · 🌐 [Project page](https://advancemintz.github.io/mc-ai-companion/)

> **Status: early.** Version 0.1 has been run on a real server. Later features were built and checked against simulated worlds and mock AI servers (66 automated tests), but not yet played on a real server. Bug reports with terminal output are very welcome.

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

## Requirements

- **Node.js 20 or newer** (https://nodejs.org)
- **Minecraft Java Edition 1.21.x.** Mineflayer currently lists 1.21.1, 1.21.3, 1.21.4, 1.21.5, 1.21.6, 1.21.8, 1.21.9 and 1.21.11 as tested.
- **An LLM:** either [Ollama](https://ollama.com) running locally (free) or an API key for OpenAI, Anthropic or Gemini.

## Quick start

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
- "what do you have?", "how are you doing?"

Nobody owns the bot. Whether it does what you ask depends on its personality, its mood and what it thinks of you.

## Operator control

**Server operators** can always control it with `!` commands. These skip the LLM, so the bot can't refuse them:

| Command | Who | Does |
|---|---|---|
| `!status`, `!goals`, `!help` | anyone | health/activity, its goals, the command list |
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

**How it knows who is OP.** Minecraft doesn't tell other players who is an operator, so the bot recognizes them in three ways:

1. **`/say`**, which only OPs can use. Type `/say !stop` once, and the bot runs the command and remembers you as an operator, so plain `!stop` works for you from then on. In a singleplayer LAN world this needs cheats on.
2. **`admins`** in the config: a list of names that can always control it.
3. **`opsFile`** in the config: the path to the server's `ops.json`, if the bot runs on the same machine as the server.

The terminal window counts as an operator too.

**Multiple AI bots.** Put the other bots' names in `otherBots` (e.g. `["mike", "slip", "boot", "em"]`). The bot then knows they're AI characters and answers them at most once every `botChatCooldownSeconds`, so two bots can't chat back and forth forever and burn through your LLM budget.

## What the body can do

| Action | Notes |
|---|---|
| `follow_player`, `go_to_player`, `go_to` | pathfinding with parkour, digging and bridging |
| `collect_block` | finds, mines and picks up blocks. Understands "wood", "iron", "cobblestone"... Checks for the right tool. |
| `attack` | a mob type, "hostile", or a player. Equips the best weapon and picks up drops. |
| `guard` | stays put (or by a player) and kills monsters that come close |
| `craft` | finds or places a crafting table. Says exactly which ingredients are missing. |
| `smelt` | uses a nearby or carried furnace and picks fuel automatically |
| `build` | hut (walls, roof, doorway; `size` 2-7), wall, tower, platform, floor. Picks a flat, open, dry spot within 16 blocks on its own, clears leaves/plants, levels small bumps, fills dips, and mixes materials if one isn't enough. The first hut is saved as home. |
| `build_base` | a real base, as a resumable project (see below) |
| `mine` | a proper mine: covered entrance away from bases, stairs to the right depth for the ore, branch mining (see below) |
| `plan_railway`, `build_railway`, `ride_railway` | powered minecart lines between bases and places (see below) |
| `protect_area`, `unprotect_area` | mark a place (a friend's house, a farm) the bot must never dig in |
| `clean_inventory` | store everything in a nearby chest, or drop junk and extra dirt/gravel |
| `go_to_surface` | climbs or digs out to open sky when underground |
| `remember_place`, `go_to_place`, `forget_place` | named places in long-term memory (home, mine, village...) |
| `set_goal`, `complete_goal`, `note_player` | the bot's own goals and what it knows about players |
| `place_block`, `equip`, `give`, `drop`, `eat`, `sleep` | |
| `deposit`, `withdraw` | nearest chest or barrel |
| `find_block`, `wait`, `stop` | |

### Bases

`build_base` is a long, resumable project. The bot plans the base from a fixed blueprint, compares it with the world, and does whatever is still missing. If it gets interrupted (a fight, nightfall) or runs out of blocks, it reports exactly what it needs. Running it again continues on the same spot; the project is kept in memory.

- **Surface** (`small` 7x7, `medium` 9x9, `large` 11x11). It searches 20 blocks around for the flattest dry spot, clears trees and plants, digs down bumps and fills dips (including a walkway around the house). Then it builds a log-framed house with a stone floor, plank walls, a log-trimmed roof, glass windows, a door, torches inside and by the door, and any crafting table, furnace, chests and bed it carries. Roughly 150 / 260 / 370 blocks, mostly planks or cobblestone plus 20-30 logs. Glass, doors and torches are optional and can be added later.
- **Underground** (`depth` 6-24, default 10). It digs a two-wide staircase with three blocks of headroom down to a carved room. The entrance is covered, with walls, a roof and a double door, and torches light the stairs and room. Every face of the dug space is checked: holes into caves are filled, and water or lava that pours in gets plugged (and dug out again once it's safe). It needs a pickaxe, and it produces plenty of cobblestone.
- `plan_only: true` picks the spot and lists the materials without building anything.
- When it's finished, the base becomes `home` (any older home is kept as `old_home`), and the entrance is saved too.

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

- **Self-defense:** fights monsters within `defendRadius` and whatever hits it.
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
src/body/placement.js where furniture goes (walls, double chests, beds)
src/body/zones.js     protected areas and no-grief pathfinding
src/body/idle.js      idle animation
src/brain/autopilot.js  fallback activities when the model idles
src/body/railway.js   railway routes, track, power, stations
src/brain/railOffers.js  weekly railway offers to players
src/body/actions.js   every action the model can choose
src/body/executor.js  runs plans, cancellation, reflex interrupts + resume
src/body/reflexes.js  eat / defend / flee / swim
src/body/perception.js  the "what I see" summary sent to the model
test/                 unit tests (npm test), no Minecraft needed
```

## Contributing

Issues and pull requests are welcome. Run `npm test` before sending changes (no Minecraft needed). When reporting a bug, include the terminal output around the problem and your Minecraft version and LLM provider.

## Ideas for later

- Package as a single download (Node's single-executable apps, or Electron for a settings window).
- A "skill library": save successful multi-step plans and reuse them.
- Smarter combat (creepers, skeletons, shields, bows) and danger reflexes (lava, falls, getting stuck).
- Schematic-based building, doors and beds in huts, farming, villager trading, Nether trips.
- Voice chat via speech-to-text.
