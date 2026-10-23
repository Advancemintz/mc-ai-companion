'use strict'

// Advanced home designs, unlocked at building tiers 3 and 4.
//
//   watchtower (tier 3, surface)   a tall stone tower: living room, bedroom and a lookout floor,
//                                  joined by a ladder, with a crenellated roof platform
//   farmhouse  (tier 3, surface)   an L-shaped house with a peaked roof, a kitchen/pantry wing,
//                                  a covered front porch and a cleared yard in the corner of the L
//   manor      (tier 4, surface)   the end-game house: two storeys around a central hall.
//                                  ground floor: storage vault + workshop/forge
//                                  upper floor:  enchanting library + bedrooms with a brewing corner
//                                  a balcony over the front door, a peaked roof with attic windows
//   hillside   (tier 4, underground)  a fortress dug straight into a hill: a stone facade with
//                                  windows, a pillared great hall, a storage vault, a forge,
//                                  and behind the hall an enchanting library, a bedroom and a
//                                  brewing room. Needs a hill or cliff to dig into.
//
// Coordinates are the same as in builder.js: [right, up, forward], front wall at forward 0.
// Furniture is optional: whatever the bot carries gets placed, and the rest is listed so it knows
// what to bring next time.

const { Vec3 } = require('vec3')
const B = require('./builder')
const T = require('./terrain')

const key = (r, u, f) => `${r},${u},${f}`
const put = (map, ri, up, fi, role, extra = {}) => map.set(key(ri, up, fi), { rel: [ri, up, fi], role, ...extra })
const has = (map, ri, up, fi) => map.has(key(ri, up, fi))
const putIfFree = (map, ri, up, fi, role, extra) => { if (!has(map, ri, up, fi)) put(map, ri, up, fi, role, extra) }
const furn = (map, ri, up, fi, item, front) => put(map, ri, up, fi, 'furniture', front ? { item, front } : { item })

// Material preferences (the normal palette is the fallback, so anything sturdy still works).
const STONE = ['stone_bricks', 'polished_andesite', 'polished_deepslate', 'deepslate_bricks', 'bricks', 'cobblestone', 'cobbled_deepslate']
const WOOD = [/_planks$/]

// Ring of shelves at distance 2 around an enchanting table, with one gap to walk in.
function enchantingRing (map, cx, up, cf, gap) {
  furn(map, cx, up, cf, 'enchanting_table')
  for (let dr = -2; dr <= 2; dr++) {
    for (let df = -2; df <= 2; df++) {
      if (Math.max(Math.abs(dr), Math.abs(df)) !== 2) continue
      if (dr === gap[0] * 2 && df === gap[1] * 2) continue
      furn(map, cx + dr, up, cf + df, 'bookshelf')
    }
  }
}

// A peaked roof over a rectangle. ridge 'f' runs front to back (slopes face left/right),
// ridge 'r' runs left to right (slopes face front/back). Gable ends are walled in.
function gable (map, { riMin, riMax, fiMin, fiMax, base, ridge, roofExtra = {}, wallExtra = {} }) {
  const alongF = ridge === 'f'
  const half = alongF ? (riMax - riMin) / 2 : (fiMax - fiMin) / 2
  const c = alongF ? (riMin + riMax) / 2 : (fiMin + fiMax) / 2
  for (let fi = fiMin; fi <= fiMax; fi++) {
    for (let ri = riMin; ri <= riMax; ri++) {
      const k = Math.floor(half - Math.abs((alongF ? ri : fi) - c))
      const eave = alongF ? (ri === riMin || ri === riMax) : (fi === fiMin || fi === fiMax)
      const end = alongF ? (fi === fiMin || fi === fiMax) : (ri === riMin || ri === riMax)
      put(map, ri, base + k, fi, eave ? 'frame' : 'roof', eave ? {} : roofExtra)
      for (let up = base; up < base + k; up++) put(map, ri, up, fi, end ? 'wall' : 'air', end ? wallExtra : {})
      put(map, ri, base + k + 1, fi, 'air')
    }
  }
}

// Supports under the whole footprint, and a cleared, levelled walkway one block around it.
function groundwork (map, height) {
  const fp = new Set()
  for (const c of map.values()) if (c.rel[1] === 0 && c.role !== 'support' && c.role !== 'air') fp.add(`${c.rel[0]},${c.rel[2]}`)
  for (const k of fp) {
    const [ri, fi] = k.split(',').map(Number)
    for (let d = 1; d <= 3; d++) putIfFree(map, ri, -d, fi, 'support')
    for (let dr = -1; dr <= 1; dr++) {
      for (let df = -1; df <= 1; df++) {
        const nr = ri + dr; const nf = fi + df
        if (fp.has(`${nr},${nf}`) || has(map, nr, 0, nf)) continue
        put(map, nr, 0, nf, 'support')
        for (let d = 1; d <= 2; d++) putIfFree(map, nr, -d, nf, 'support')
        for (let up = 1; up <= height; up++) putIfFree(map, nr, up, nf, 'air')
      }
    }
  }
}

// ------------------------------------------------------------------ tier 3: watchtower

function watchtower (size) {
  const S = size === 'large' ? 9 : 7
  const levels = size === 'small' ? 2 : 3
  const h = (S - 1) / 2
  const mid = h
  const top = 4 * levels // the roof platform
  const map = new Map()
  const isLadder = (ri, fi) => ri === -h + 1 && fi === S - 2
  for (let fi = 0; fi < S; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const edgeF = fi === 0 || fi === S - 1
      const edgeR = ri === -h || ri === h
      const edge = edgeF || edgeR
      const corner = edgeF && edgeR
      for (let l = 0; l <= levels; l++) {
        const fu = 4 * l
        if (edge) put(map, ri, fu, fi, corner || l > 0 ? 'frame' : 'wall', { prefer: STONE })
        else if (l > 0 && isLadder(ri, fi)) put(map, ri, fu, fi, 'ladder', { item: 'ladder', wall: [-1, 0, 0] })
        else put(map, ri, fu, fi, 'floor', l === 0 ? { prefer: STONE } : {})
        if (l === levels) break
        const lookout = l === levels - 1 && levels > 2
        for (let up = fu + 1; up <= fu + 3; up++) {
          if (!edge) {
            if (isLadder(ri, fi)) put(map, ri, up, fi, 'ladder', { item: 'ladder', wall: [-1, 0, 0] })
            else put(map, ri, up, fi, 'air')
          } else if (corner) put(map, ri, up, fi, 'frame', { prefer: STONE })
          else if (l === 0 && fi === 0 && ri === 0 && up === 1) put(map, ri, up, fi, 'door')
          else if (l === 0 && fi === 0 && ri === 0 && up === 2) put(map, ri, up, fi, 'doortop')
          else if (up === fu + 2 && ((edgeF && ri === 0) || (edgeR && fi === mid) || (lookout && ((edgeF && Math.abs(ri) === h - 1) || (edgeR && (fi === 1 || (fi === S - 2 && ri === h))))))) put(map, ri, up, fi, 'window')
          else put(map, ri, up, fi, 'wall', { prefer: STONE })
        }
      }
      // Battlements: merlons on alternate edge blocks, solid corners.
      if (edge) put(map, ri, top + 1, fi, corner || Math.abs((ri + fi) % 2) === 0 ? 'wall' : 'air', { prefer: STONE })
      else put(map, ri, top + 1, fi, 'air')
      put(map, ri, top + 2, fi, 'air')
    }
  }
  // Ground floor: kitchen corner and a double chest. Middle floor: bedroom. Top: lookout.
  furn(map, h - 1, 1, S - 2, 'crafting_table', [0, 0, -1])
  furn(map, h - 2, 1, S - 2, 'furnace', [0, 0, -1])
  furn(map, h - 1, 1, 1, 'chest', [-1, 0, 0])
  furn(map, h - 1, 1, 2, 'chest', [-1, 0, 0])
  furn(map, h - 1, 5, 2, /_bed$/, [-1, 0, 0])
  furn(map, h - 1, 5, S - 2, 'chest', [0, 0, -1])
  furn(map, h - 2, 5, S - 2, 'chest', [0, 0, -1])
  for (let l = 0; l < levels; l++) {
    put(map, -h + 1, 4 * l + 2, 1, 'light')
    put(map, h - 1, 4 * l + 2, S - 3, 'light')
  }
  for (const [ri, fi] of [[-h, 0], [h, 0], [-h, S - 1], [h, S - 1]]) put(map, ri, top + 2, fi, 'light')
  put(map, -1, 2, -1, 'light'); put(map, 1, 2, -1, 'light')
  groundwork(map, 5)
  return { cells: [...map.values()], inside: [0, 1, mid], entrance: [0, 1, -1], geo: { W: S, L: S, H: 3, h, mid, top, storeys: levels, bunkerF: mid + 1 } }
}

// ------------------------------------------------------------------ tier 3: farmhouse

function farmhouse (size, storeys = 1) {
  const { E, H } = B.SIZES[size] || B.SIZES.medium
  const two = storeys >= 2
  const h = (E - 1) / 2
  const mid = Math.floor(E / 2)
  const top = two ? 2 * H + 1 : H
  const map = new Map()
  const wingIn = (fi) => fi >= E - 5 // where the wing joins the right wall
  const isWindow = (ri, fi, up) =>
    (up === 2 || (two && up === H + 3)) && (
      (ri === -h && (fi === 1 || fi === E - 2)) ||
      (ri === h && !wingIn(fi) && fi === 1) ||
      (fi === 0 && Math.abs(ri) === 2) ||
      (fi === E - 1 && ri === 0))
  for (let fi = 0; fi < E; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const edgeF = fi === 0 || fi === E - 1
      const edgeR = ri === -h || ri === h
      const edge = edgeF || edgeR
      const corner = edgeF && edgeR
      put(map, ri, 0, fi, edge ? (corner ? 'frame' : 'wall') : 'floor')
      for (let up = 1; up <= top; up++) {
        const band = two && up === H + 1
        if (!edge) {
          if (two && ri === -h + 1 && fi === 1 && up <= H + 1) put(map, ri, up, fi, 'ladder', { item: 'ladder', wall: [-1, 0, 0] })
          else put(map, ri, up, fi, band ? 'floor' : 'air')
        } else if (corner || band) put(map, ri, up, fi, 'frame')
        else if (fi === 0 && ri === 0 && up === 1) put(map, ri, up, fi, 'door')
        else if (fi === 0 && ri === 0 && up === 2) put(map, ri, up, fi, 'doortop')
        else if (ri === h && fi === E - 3 && up <= 2) put(map, ri, up, fi, 'air') // doorway into the wing
        else if (isWindow(ri, fi, up)) put(map, ri, up, fi, 'window')
        else put(map, ri, up, fi, 'wall')
      }
    }
  }
  gable(map, { riMin: -h, riMax: h, fiMin: 0, fiMax: E - 1, base: top + 1, ridge: 'f' })
  put(map, 0, top + 2, 0, 'window'); put(map, 0, top + 2, E - 1, 'window') // attic windows
  // Kitchen / pantry wing on the right, at the back: 4 wide inside, 3 deep, flat roof.
  const wo = h + 5
  for (let fi = E - 5; fi <= E - 1; fi++) {
    for (let ri = h + 1; ri <= wo; ri++) {
      const edgeF = fi === E - 5 || fi === E - 1
      const edgeR = ri === wo
      const edge = edgeF || edgeR
      put(map, ri, 0, fi, edge ? (edgeF && edgeR ? 'frame' : 'wall') : 'floor')
      for (let up = 1; up <= H; up++) {
        if (!edge) put(map, ri, up, fi, 'air')
        else if (edgeF && edgeR) put(map, ri, up, fi, 'frame')
        else if (up === 2 && ((edgeR && fi === E - 3) || (fi === E - 1 && ri === h + 3))) put(map, ri, up, fi, 'window')
        else put(map, ri, up, fi, 'wall')
      }
      put(map, ri, H + 1, fi, edge ? 'frame' : 'roof')
      put(map, ri, H + 2, fi, 'air')
    }
  }
  // Covered front porch, two deep, with fence posts at the corners.
  for (let fi = -2; fi <= -1; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      put(map, ri, 0, fi, 'floor', { prefer: WOOD })
      for (let up = 1; up <= H; up++) put(map, ri, up, fi, 'air')
      put(map, ri, H + 1, fi, 'roof', { prefer: WOOD })
      put(map, ri, H + 2, fi, 'air')
    }
  }
  for (const ri of [-h, h]) for (let up = 1; up <= H; up++) furn(map, ri, up, -2, /_fence$/)
  // The yard in the corner of the L: cleared and levelled.
  for (let fi = -2; fi < E - 5; fi++) {
    for (let ri = h + 1; ri <= wo; ri++) {
      put(map, ri, 0, fi, 'support')
      for (let up = 1; up <= H + 1; up++) put(map, ri, up, fi, 'air')
    }
  }
  furn(map, h + 2, 1, 1, 'composter')
  // Furniture: main room workbench + chests; wing is the kitchen and pantry.
  furn(map, -h + 1, 1, E - 2, 'crafting_table', [0, 0, -1])
  furn(map, -h + 2, 1, E - 2, 'chest', [0, 0, -1])
  furn(map, -h + 3, 1, E - 2, 'chest', [0, 0, -1])
  furn(map, h - 2, two ? H + 2 : 1, 2, /_bed$/, [-1, 0, 0])
  furn(map, h + 1, 1, E - 2, 'smoker', [0, 0, -1])
  furn(map, h + 2, 1, E - 2, 'furnace', [0, 0, -1])
  furn(map, h + 3, 1, E - 2, 'barrel', [0, 0, -1])
  furn(map, h + 4, 1, E - 2, 'barrel', [0, 0, -1])
  furn(map, h + 4, 1, E - 4, 'chest', [-1, 0, 0])
  furn(map, h + 4, 1, E - 3, 'chest', [-1, 0, 0])
  for (const [ri, up, fi] of [[-h + 1, 2, mid - 1], [h - 1, 2, mid], [h + 1, 2, E - 4], [-1, 2, -1], [1, 2, -1]]) put(map, ri, up, fi, 'light')
  if (two) { put(map, -h + 1, H + 3, mid - 1, 'light'); put(map, h - 1, H + 3, mid, 'light') }
  groundwork(map, top + 2)
  return { cells: [...map.values()], inside: [0, 1, mid], entrance: [0, 1, -3], geo: { W: E, L: E, H, h, mid, top, storeys: two ? 2 : 1, bunkerF: 1 } }
}

// ------------------------------------------------------------------ tier 4: manor

const MANOR = { small: { W: 17, L: 11 }, medium: { W: 19, L: 13 }, large: { W: 21, L: 15 } }

function manor (size) {
  const { W, L } = MANOR[size] || MANOR.medium
  const H = 4
  const h = (W - 1) / 2
  const mid = Math.floor(L / 2)
  const up2 = H + 1 // the upper floor
  const top = 2 * H + 1
  const map = new Map()
  const inner = (ri) => ri === -2 || ri === 2 // walls either side of the central hall
  const ladder = (ri, fi) => ri === 0 && fi === L - 2
  const window = (ri, fi) =>
    (fi === 0 && [4, h - 2].includes(Math.abs(ri))) ||
    (fi === L - 1 && [0, 4, h - 2].includes(Math.abs(ri))) ||
    (Math.abs(ri) === h && (fi === 3 || fi === L - 4 || (L >= 15 && fi === mid)))
  for (let fi = 0; fi < L; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const edgeF = fi === 0 || fi === L - 1
      const edgeR = ri === -h || ri === h
      const edge = edgeF || edgeR
      const corner = edgeF && edgeR
      put(map, ri, 0, fi, edge ? (corner ? 'frame' : 'wall') : 'floor', { prefer: STONE })
      for (let up = 1; up <= top; up++) {
        const band = up === up2
        const upper = up > up2
        const mat = { prefer: upper ? WOOD : STONE }
        if (!edge) {
          if (ladder(ri, fi) && up <= up2) put(map, ri, up, fi, 'ladder', { item: 'ladder', wall: [0, 0, 1] })
          else if (band) put(map, ri, up, fi, 'floor', { prefer: WOOD })
          else if (inner(ri)) {
            const doorway = fi === mid && (up === 1 || up === 2 || up === up2 + 1 || up === up2 + 2)
            put(map, ri, up, fi, doorway ? 'air' : 'wall', doorway ? {} : mat)
          } else put(map, ri, up, fi, 'air')
        } else if (corner || band) put(map, ri, up, fi, 'frame')
        else if (fi === 0 && ri === 0 && (up === 1 || up === up2 + 1)) put(map, ri, up, fi, 'door')
        else if (fi === 0 && ri === 0 && (up === 2 || up === up2 + 2)) put(map, ri, up, fi, 'doortop')
        else if ((up === 2 || up === up2 + 2) && window(ri, fi)) put(map, ri, up, fi, 'window')
        else put(map, ri, up, fi, 'wall', mat)
      }
    }
  }
  gable(map, { riMin: -h, riMax: h, fiMin: 0, fiMax: L - 1, base: top + 1, ridge: 'r', roofExtra: { prefer: WOOD }, wallExtra: { prefer: WOOD } })
  put(map, -h, top + 2, mid, 'window'); put(map, h, top + 2, mid, 'window')
  groundwork(map, top + 2)

  // Porch under a balcony: the balcony over the front door is reached by the upstairs door.
  for (let fi = -2; fi <= -1; fi++) {
    for (let ri = -1; ri <= 1; ri++) {
      put(map, ri, 0, fi, 'support')
      for (let up = 1; up < up2; up++) put(map, ri, up, fi, 'air')
      put(map, ri, up2, fi, 'floor', { prefer: WOOD })
      for (let up = up2 + 1; up <= up2 + 3; up++) put(map, ri, up, fi, 'air')
    }
  }
  for (const ri of [-1, 1]) for (let up = 1; up < up2; up++) furn(map, ri, up, -2, /_fence$/)
  for (const [ri, fi] of [[-1, -2], [0, -2], [1, -2], [-1, -1], [1, -1]]) furn(map, ri, up2 + 1, fi, /_fence$/)

  // Ground floor, left: the storage vault. Chests along the outer and back walls, barrels in front.
  for (let fi = 1; fi <= L - 2; fi++) furn(map, -h + 1, 1, fi, 'chest', [1, 0, 0])
  for (let ri = -h + 2; ri <= -4; ri++) furn(map, ri, 1, L - 2, 'chest', [0, 0, -1])
  for (let ri = -h + 2; ri <= -4; ri++) furn(map, ri, 1, 1, 'barrel', [0, 0, 1])
  furn(map, -3, 1, L - 2, 'ender_chest', [0, 0, -1])
  // Ground floor, right: the workshop and forge.
  const outer = ['crafting_table', 'furnace', 'blast_furnace', 'smoker']
  outer.forEach((item, i) => furn(map, h - 1, 1, 1 + i, item, [-1, 0, 0]))
  furn(map, h - 1, 1, L - 4, 'chest', [-1, 0, 0])
  furn(map, h - 1, 1, L - 3, 'chest', [-1, 0, 0])
  const back = ['anvil', 'smithing_table', 'grindstone', 'stonecutter']
  back.forEach((item, i) => furn(map, 3 + i, 1, L - 2, item, [0, 0, -1]))
  ;['loom', 'cartography_table', 'fletching_table'].forEach((item, i) => furn(map, 4 + i, 1, 1, item, [0, 0, 1]))
  // Upper floor, left: the enchanting library.
  const cx = h >= 10 ? -6 : -5
  enchantingRing(map, cx, up2 + 1, mid, [1, 0])
  furn(map, cx, up2 + 1, 1, 'lectern', [0, 0, 1])
  furn(map, -h + 1, up2 + 1, L - 2, 'chest', [1, 0, 0])
  // Upper floor, right: bedrooms (a bed for every bot or player) and the brewing corner.
  for (let fi = 1; fi <= Math.min(7, L - 4); fi += 2) furn(map, h - 1, up2 + 1, fi, /_bed$/, [-1, 0, 0])
  furn(map, 4, up2 + 1, L - 2, 'brewing_stand', [0, 0, -1])
  furn(map, 5, up2 + 1, L - 2, 'cauldron', [0, 0, -1])
  furn(map, 6, up2 + 1, L - 2, 'chest', [0, 0, -1])
  furn(map, 7, up2 + 1, L - 2, 'chest', [0, 0, -1])

  // Lights: hall (both floors), every room, the porch.
  for (const up of [3, up2 + 3]) {
    for (const fi of [2, L - 3]) for (const ri of [-1, 1, -3, 3]) put(map, ri, up, fi, 'light')
  }
  put(map, -h + 1, up2 + 3, 1, 'light'); put(map, -h + 1, up2 + 3, L - 2, 'light')
  put(map, -1, 3, -1, 'light'); put(map, 1, 3, -1, 'light')
  return { cells: [...map.values()], inside: [0, 1, mid], entrance: [0, 1, -3], geo: { W, L, H, h, mid, top, storeys: 2, bunkerF: mid } }
}

// ------------------------------------------------------------------ tier 4: hillside fortress

const HILL = { small: 8, medium: 11, large: 14 }

function hillside (size) {
  const hl = HILL[size] || HILL.medium
  const map = new Map()
  const back = 4 + hl // the hall's back wall
  const midH = 4 + Math.floor(hl / 2)
  const room = (riMin, riMax, fiMin, fiMax, height) => {
    for (let fi = fiMin; fi <= fiMax; fi++) {
      for (let ri = riMin; ri <= riMax; ri++) {
        put(map, ri, 0, fi, 'floor', { prefer: STONE })
        put(map, ri, -1, fi, 'support')
        for (let up = 1; up <= height; up++) put(map, ri, up, fi, 'air')
      }
    }
  }
  const doorway = (ri, fi) => { put(map, ri, 0, fi, 'floor', { prefer: STONE }); put(map, ri, -1, fi, 'support'); put(map, ri, 1, fi, 'air'); put(map, ri, 2, fi, 'air') }

  // Approach and the stone facade on the hill face.
  for (let fi = -2; fi <= -1; fi++) {
    for (let ri = -3; ri <= 3; ri++) {
      put(map, ri, 0, fi, 'support'); put(map, ri, -1, fi, 'support')
      for (let up = 1; up <= 6; up++) put(map, ri, up, fi, 'air')
    }
  }
  for (let ri = -3; ri <= 3; ri++) {
    for (let up = 0; up <= 5; up++) {
      let role = 'wall'
      if (up === 0) role = 'floor'
      else if (up === 5 || Math.abs(ri) === 3) role = 'frame'
      else if (ri === 0 && up === 1) role = 'door'
      else if (ri === 0 && up === 2) role = 'doortop'
      else if (Math.abs(ri) === 2 && (up === 2 || up === 3)) role = 'window'
      put(map, ri, up, 0, role, { prefer: STONE })
    }
  }
  room(-1, 1, 1, 3, 3) // entry corridor
  room(-4, 4, 4, back - 1, 4) // great hall
  for (const ri of [-2, 2]) for (let fi = 6; fi < back - 1; fi += 3) for (let up = 1; up <= 4; up++) put(map, ri, up, fi, 'frame', { prefer: STONE })
  room(-10, -6, 5, back - 2, 3) // storage vault
  room(6, 10, 5, back - 2, 3) // forge
  doorway(-5, midH); doorway(5, midH)
  room(-8, -4, back + 1, back + 5, 3) // bedroom
  room(-2, 2, back + 1, back + 5, 3) // enchanting library
  room(4, 8, back + 1, back + 5, 3) // brewing room
  doorway(-4, back); doorway(0, back); doorway(4, back)

  // Storage vault.
  for (let fi = 5; fi <= back - 2; fi++) furn(map, -10, 1, fi, 'chest', [1, 0, 0])
  for (const ri of [-9, -8, -7]) furn(map, ri, 1, back - 2, 'barrel', [0, 0, -1])
  furn(map, -9, 1, 5, 'ender_chest', [0, 0, 1])
  // Forge.
  const tools = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'smithing_table', 'grindstone', 'stonecutter', 'loom', 'cartography_table']
  for (let fi = 5, i = 0; fi <= back - 2; fi++, i++) furn(map, 10, 1, fi, tools[i] || 'chest', [-1, 0, 0])
  // Library, bedroom, brewing room.
  enchantingRing(map, 0, 1, back + 3, [0, -1])
  for (const fi of [back + 1, back + 3, back + 5]) furn(map, -8, 1, fi, /_bed$/, [1, 0, 0])
  furn(map, -4, 1, back + 5, 'chest', [-1, 0, 0])
  furn(map, 8, 1, back + 2, 'cauldron', [-1, 0, 0])
  furn(map, 8, 1, back + 3, 'brewing_stand', [-1, 0, 0])
  furn(map, 8, 1, back + 4, 'chest', [-1, 0, 0])
  furn(map, 8, 1, back + 5, 'chest', [-1, 0, 0])

  // Lights.
  const lights = [[-1, 3, -1], [1, 3, -1], [-1, 3, 2], [1, 3, 2], [-4, 3, 5], [4, 3, 5], [-4, 3, back - 2], [4, 3, back - 2],
    [-6, 3, 6], [-6, 3, back - 3], [6, 3, 6], [6, 3, back - 3], [-2, 2, back + 1], [2, 2, back + 1], [-2, 2, back + 5], [2, 2, back + 5],
    [-4, 2, back + 2], [4, 2, back + 1]]
  for (let fi = 6; fi < back - 1; fi += 3) lights.push([-1, 3, fi], [1, 3, fi])
  for (const [ri, up, fi] of lights) put(map, ri, up, fi, 'light')

  // Rock shell: every face of the dug space is made solid (seals caves, water and lava).
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const open = [...map.values()].filter(c => c.rel[2] >= 1 && !['support', 'floor', 'frame', 'wall'].includes(c.role))
  for (const c of open) {
    for (const [dr, du, df] of dirs) {
      const [r, u, f] = [c.rel[0] + dr, c.rel[1] + du, c.rel[2] + df]
      if (f >= 1) putIfFree(map, r, u, f, 'shell')
    }
  }
  return { cells: [...map.values()], inside: [0, 1, midH], entrance: [0, 1, -1], geo: { W: 21, L: back + 6, H: 4, h: 10, mid: midH, level: 1, hallLength: hl, back } }
}

const CARDINALS = [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)]

// A spot at the foot of a hill or cliff where the whole fortress fits inside solid ground.
function chooseHillsideSite (bot, layout, { radius = 24 } = {}) {
  const me = bot.entity.position.floored()
  const cols = new Map()
  const col = (x, z) => {
    const k = x + ',' + z
    if (!cols.has(k)) cols.set(k, T.columnInfo(bot, x, z, me.y + 8, 24))
    return cols.get(k)
  }
  const deepF = layout.geo.mid
  let best = null
  for (const f of CARDINALS) {
    const r = B.rightOf(f)
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        const ox = me.x + dx; const oz = me.z + dz
        const c = col(ox, oz)
        if (!c || c.water || c.roofed) continue
        const gy = c.y
        if (Math.abs(gy - (me.y - 1)) > 12) continue
        const face = col(ox + f.x * 3, oz + f.z * 3)
        const deep = col(ox + f.x * deepF, oz + f.z * deepF)
        if (!face || !deep || face.water || deep.water || face.y < gy + 4 || deep.y < gy + 7) continue
        const origin = new Vec3(ox, gy, oz)
        const plan = B.toWorld(layout, origin, f, r)
        let lava = 0; let water = 0; let open = 0; let solid = 0; let bad = false
        for (const cell of plan.cells) {
          const b = bot.blockAt(cell.pos)
          if (!b || b.name === 'bedrock') { bad = true; break }
          if (b.name === 'lava') { lava++; continue }
          if (b.name === 'water') { water++; continue }
          if (!B.isAirLike(b) && !B.NATURAL.test(b.name) && cell.role !== 'shell') { bad = true; break }
          if (cell.rel[2] >= 1 && cell.role === 'air') { if (B.isAirLike(b)) open++; else solid++ }
        }
        if (bad) continue
        const frac = solid / Math.max(1, solid + open)
        if (frac < 0.75) continue
        const cost = lava * 20 + water * 3 + (1 - frac) * 100 + Math.hypot(dx, dz) * 0.5
        if (!best || cost < best.cost) best = { origin, f, r, cost, lava, liquids: water, rock: Math.round(frac * 100) }
      }
    }
  }
  return best
}

module.exports = { watchtower, farmhouse, manor, hillside, chooseHillsideSite, MANOR, HILL, STONE, WOOD }
