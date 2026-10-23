'use strict'

// Home designs and base upgrades.
//
// VARIANTS: different kinds of home for the same job. When the bot builds a base it picks one at
// random from the variants its building tier allows, so not every base looks the same.
//   surface:     cottage (square, flat log-trimmed roof)   longhouse (long and narrow, peaked roof)
//   underground: cellar (square room)                      hall (long room with stone pillars)
//
// UPGRADES: instead of building a new base when it gets better, the bot improves the one it has.
//   storage_room     a side room full of chests (surface wing or carved side room)
//   bunker           a safe room dug under a surface house, reached by a ladder shaft
//   second_storey    an upper floor with a ladder and an upstairs bedroom (surface)
//   enchanting_room  a side room with an enchanting table ringed by 15 bookshelves
//
// Everything is a list of cells with roles (see builder.js), so the same resumable engine builds
// it, and an upgrade is simply "the base blueprint plus some more cells".

const B = require('./builder')
const DS = require('./designs')

const key = (r, u, f) => `${r},${u},${f}`

// ------------------------------------------------------------------ geometry helpers

function cellMap (cells) {
  const m = new Map()
  for (const c of cells) m.set(key(...c.rel), c)
  return m
}

function put (map, ri, up, fi, role, extra = {}) {
  map.set(key(ri, up, fi), { rel: [ri, up, fi], role, ...extra })
}

// Seal everything around the given open cells (for anything dug underground).
function addShell (map, openCells, { skipFront = true } = {}) {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const c of openCells) {
    for (const [dr, du, df] of dirs) {
      const [r, u, f] = [c.rel[0] + dr, c.rel[1] + du, c.rel[2] + df]
      if (skipFront && f < 0) continue
      if (!map.has(key(r, u, f))) put(map, r, u, f, 'shell')
    }
  }
}

// ------------------------------------------------------------------ surface: longhouse

// A long, narrow house with a peaked (gable) roof running front to back.
function longhouse (size, storeys = 1) {
  const { E, H } = B.SIZES[size] || B.SIZES.medium
  const W = Math.max(5, E - 2)
  const L = E + 4
  const two = storeys >= 2
  const h = (W - 1) / 2
  const top = two ? 2 * H + 1 : H
  const mid = Math.floor(L / 2)
  const map = new Map()
  const windowUps = two ? [2, H + 3] : [2]
  const isWindow = (ri, fi) =>
    ((ri === -h || ri === h) && (fi % 3 === 2) && fi < L - 1) ||
    (fi === L - 1 && ri === 0)
  const ladderAt = (ri, fi) => two && ri === -h + 1 && fi === 1

  for (let fi = 0; fi < L; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const edgeF = fi === 0 || fi === L - 1
      const edgeR = ri === -h || ri === h
      const edge = edgeF || edgeR
      const corner = edgeF && edgeR
      put(map, ri, 0, fi, edge ? (corner ? 'frame' : 'wall') : 'floor')
      for (let up = 1; up <= top; up++) {
        const upperFloor = two && up === H + 1
        if (!edge) {
          if (ladderAt(ri, fi) && up <= H + 1) put(map, ri, up, fi, 'ladder', { item: 'ladder', wall: [-1, 0, 0] })
          else put(map, ri, up, fi, upperFloor ? 'floor' : 'air')
        } else if (corner || upperFloor) put(map, ri, up, fi, 'frame')
        else if (fi === 0 && ri === 0 && up === 1) put(map, ri, up, fi, 'door')
        else if (fi === 0 && ri === 0 && up === 2) put(map, ri, up, fi, 'doortop')
        else if (windowUps.includes(up) && isWindow(ri, fi)) put(map, ri, up, fi, 'window')
        else put(map, ri, up, fi, 'wall')
      }
      // Gable roof: one block per column, higher toward the middle; gable ends filled in.
      const k = h - Math.abs(ri)
      put(map, ri, top + 1 + k, fi, edgeR ? 'frame' : 'roof')
      for (let up = top + 1; up < top + 1 + k; up++) put(map, ri, up, fi, edgeF ? 'wall' : 'air')
      for (let d = 1; d <= 3; d++) put(map, ri, -d, fi, 'support')
    }
  }
  const roofTop = top + 1 + h
  for (let fi = -1; fi <= L; fi++) {
    for (let ri = -h - 1; ri <= h + 1; ri++) {
      if (fi >= 0 && fi < L && ri >= -h && ri <= h) continue
      put(map, ri, 0, fi, 'support')
      for (let d = 1; d <= 2; d++) put(map, ri, -d, fi, 'support')
      for (let up = 1; up <= top + 2; up++) put(map, ri, up, fi, 'air')
    }
  }
  for (let fi = 0; fi < L; fi++) for (let ri = -h; ri <= h; ri++) if (!map.has(key(ri, roofTop + 1, fi))) put(map, ri, roofTop + 1, fi, 'air')

  const lights = [[-h + 1, 2, mid], [h - 1, 2, mid], [0, 2, L - 2], [-1, 2, -1], [1, 2, -1], [h - 1, 2, 2]]
  if (!two) lights.push([-h + 1, 2, 2])
  if (two) lights.push([-h + 1, H + 3, mid], [h - 1, H + 3, mid])
  for (const [ri, up, fi] of lights) put(map, ri, up, fi, 'light')
  // Narrow house: workbench and furnace on the back wall, chests along the right-hand wall.
  put(map, -h + 1, 1, L - 2, 'furniture', { item: 'crafting_table', front: [0, 0, -1] })
  put(map, 0, 1, L - 2, 'furniture', { item: 'furnace', front: [0, 0, -1] })
  put(map, h - 1, 1, L - 4, 'furniture', { item: 'chest', front: [-1, 0, 0] })
  put(map, h - 1, 1, L - 5, 'furniture', { item: 'chest', front: [-1, 0, 0] })
  put(map, h - 2 < -h + 1 ? 0 : h - 2, two ? H + 2 : 1, 3, 'furniture', { item: /_bed$/, front: [-1, 0, 0] })
  return { cells: [...map.values()], inside: [0, 1, mid], entrance: [0, 1, -1], geo: { W, L, H, h, mid, top, storeys: two ? 2 : 1, bunkerF: 2 } }
}

// ------------------------------------------------------------------ underground: hall

// A long dug-out hall with stone pillars, reached by the same covered stairway as the cellar.
function hall (size, depth) {
  const { E } = B.SIZES[size] || B.SIZES.medium
  const W = Math.max(5, E - 2)
  const Lr = E + 4
  const Hr = size === 'small' ? 3 : 4
  const D = Math.max(5, Math.min(24, depth))
  const h = (W - 1) / 2
  const map = new Map()
  for (let i = 0; i < D; i++) {
    const s = 1 - i
    for (const ri of [0, 1]) {
      for (let up = s; up <= s + 2; up++) put(map, ri, up, i, 'air')
      put(map, ri, s - 1, i, 'support')
    }
  }
  put(map, 0, 1, 0, 'door'); put(map, 1, 1, 0, 'door')
  put(map, 0, 2, 0, 'doortop'); put(map, 1, 2, 0, 'doortop')
  for (let i = 2; i < D; i += 3) put(map, 0, 2 - i, i, 'light')
  const Lv = 1 - D
  for (let fi = D; fi < D + Lr; fi++) {
    for (let ri = -h; ri <= h; ri++) {
      const pillar = Math.abs(ri) === h - 1 && (fi - D) % 3 === 2 && fi < D + Lr - 2
      if (!pillar) for (let up = Lv; up < Lv + Hr; up++) put(map, ri, up, fi, 'air')
      put(map, ri, Lv - 1, fi, 'support')
    }
  }
  const back = D + Lr - 1
  const mid = D + Math.floor(Lr / 2)
  for (const [ri, fi] of [[-h, D + 1], [h, D + 1], [0, back], [-h, mid], [h, mid], [-h, back - 1], [h, back - 1]]) put(map, ri, Lv + 1, fi, 'light')
  put(map, -h, Lv, back, 'furniture', { item: 'crafting_table', front: [0, 0, -1] })
  put(map, -h + 1, Lv, back, 'furniture', { item: 'furnace', front: [0, 0, -1] })
  put(map, h, Lv, back, 'furniture', { item: 'chest', front: [0, 0, -1] })
  put(map, h - 1, Lv, back, 'furniture', { item: 'chest', front: [0, 0, -1] })
  put(map, h - 1, Lv, back - 3, 'furniture', { item: /_bed$/, front: [-1, 0, 0] })
  addShell(map, [...map.values()].filter(c => c.role !== 'support'))
  for (let i = 0; i < Math.min(D, 4); i++) for (const ri of [-1, 2]) if (!map.has(key(ri, 4 - i, i))) put(map, ri, 4 - i, i, 'shell')
  return { cells: [...map.values()], inside: [0, Lv, mid], entrance: [0, 1, -1], geo: { W, L: Lr, H: Hr, h, mid, level: Lv, roomStart: D } }
}

// ------------------------------------------------------------------ variants

// tier: the building tier that unlocks it. upgrades: which upgrade_base options fit the design.
// builtIn: rooms the design already has (so those upgrades are reported as already there).
const ALL_SURFACE = ['storage_room', 'bunker', 'second_storey', 'enchanting_room']
const VARIANTS = {
  cottage: { style: 'surface', tier: 2, about: 'square cottage with a log frame and flat roof', upgrades: ALL_SURFACE },
  longhouse: { style: 'surface', tier: 2, about: 'long, narrow house with a peaked roof', upgrades: ALL_SURFACE },
  cellar: { style: 'underground', tier: 2, about: 'square room under the ground', upgrades: ['storage_room', 'enchanting_room'] },
  hall: { style: 'underground', tier: 2, about: 'long underground hall with stone pillars', upgrades: ['storage_room', 'enchanting_room'] },
  watchtower: { style: 'surface', tier: 3, about: 'tall stone tower: living room, bedroom, lookout and a battlemented roof', upgrades: ['storage_room', 'bunker', 'enchanting_room'] },
  farmhouse: { style: 'surface', tier: 3, about: 'L-shaped farmhouse with a kitchen wing, front porch and yard', upgrades: ['storage_room', 'bunker', 'second_storey'] },
  manor: { style: 'surface', tier: 4, about: 'two-storey manor: storage vault, forge, enchanting library, bedrooms, brewing, balcony', upgrades: ['bunker'], builtIn: ['storage_room', 'enchanting_room', 'second_storey'] },
  hillside: { style: 'underground', tier: 4, about: 'fortress dug into a hill: facade, pillared great hall, vault, forge, library, bedroom, brewing room', upgrades: [], builtIn: ['storage_room', 'enchanting_room'], needs: 'a hill or cliff to dig into' }
}

function baseGeometry (proj) {
  const { E, H } = B.SIZES[proj.size] || B.SIZES.medium
  if (proj.style === 'surface') {
    const v = proj.variant || 'cottage'
    if (v === 'longhouse') return longhouse(proj.size, proj.storeys || 1)
    if (v === 'watchtower') return DS.watchtower(proj.size)
    if (v === 'farmhouse') return DS.farmhouse(proj.size, proj.storeys || 1)
    if (v === 'manor') return DS.manor(proj.size)
    const two = (proj.storeys || 1) >= 2
    const out = B.surfaceBaseCells(proj.size, proj.storeys || 1)
    const h = (E - 1) / 2
    return { ...out, geo: { W: E, L: E, H, h, mid: Math.floor(E / 2), top: two ? 2 * H + 1 : H, storeys: two ? 2 : 1 } }
  }
  if ((proj.variant || 'cellar') === 'hall') return hall(proj.size, proj.depth)
  if (proj.variant === 'hillside') return DS.hillside(proj.size)
  const out = B.undergroundBaseCells(proj.size, proj.depth)
  const D = Math.max(5, Math.min(24, proj.depth))
  const Hr = proj.size === 'small' ? 3 : 4
  return { ...out, geo: { W: E, L: E, H: Hr, h: (E - 1) / 2, mid: D + Math.floor(E / 2), level: 1 - D, roomStart: D } }
}

// ------------------------------------------------------------------ upgrades

// A walled room built onto the side of a surface house. side -1 = left wall, +1 = right wall.
function surfaceWing (map, geo, side, depthOut, halfLen, fill) {
  const { h, mid, H } = geo
  const wall = side * h // the house wall it attaches to
  const outer = side * (h + depthOut)
  const rs = [Math.min(wall, outer), Math.max(wall, outer)]
  for (let fi = mid - halfLen; fi <= mid + halfLen; fi++) {
    for (let ri = rs[0]; ri <= rs[1]; ri++) {
      if (ri === wall) continue // shares the house wall
      const edgeR = ri === outer
      const edgeF = fi === mid - halfLen || fi === mid + halfLen
      const edge = edgeR || edgeF
      put(map, ri, 0, fi, edge ? (edgeR && edgeF ? 'frame' : 'wall') : 'floor')
      for (let up = 1; up <= H; up++) put(map, ri, up, fi, edge ? (edgeR && edgeF ? 'frame' : (up === 2 && edgeR && fi === mid ? 'window' : 'wall')) : 'air')
      put(map, ri, H + 1, fi, edge ? 'frame' : 'roof')
      put(map, ri, H + 2, fi, 'air')
      for (let d = 1; d <= 2; d++) put(map, ri, -d, fi, 'support')
    }
  }
  // Clear a path around the wing.
  for (let fi = mid - halfLen - 1; fi <= mid + halfLen + 1; fi++) {
    for (const ri of [outer + side]) {
      put(map, ri, 0, fi, 'support')
      for (let up = 1; up <= H + 1; up++) put(map, ri, up, fi, 'air')
    }
  }
  // Doorway through the house wall.
  put(map, wall, 1, mid, 'air'); put(map, wall, 2, mid, 'air')
  fill({ inner: (d) => wall + side * d, floorUp: 1, mid })
}

// A room carved out next to an underground base's main room.
function carvedRoom (map, geo, side, depthOut, halfLen, fill) {
  const { h, mid, level, H } = geo
  const wall = side * (h + 1) // natural rock between the rooms
  const opened = []
  for (let fi = mid - halfLen; fi <= mid + halfLen; fi++) {
    for (let d = 2; d <= depthOut; d++) {
      const ri = side * (h + d)
      for (let up = level; up < level + Math.min(H, 3); up++) { put(map, ri, up, fi, 'air'); opened.push(map.get(key(ri, up, fi))) }
      put(map, ri, level - 1, fi, 'support')
    }
  }
  put(map, wall, level, mid, 'air'); put(map, wall, level + 1, mid, 'air')
  opened.push(map.get(key(wall, level, mid)), map.get(key(wall, level + 1, mid)))
  fill({ inner: (d) => side * (h + 1 + d), floorUp: level, mid })
  addShell(map, opened)
}

const UPGRADES = {
  storage_room: {
    styles: ['surface', 'underground'],
    about: 'a side room lined with chests (bring chests; up to 6)',
    apply (map, geo, style) {
      const fill = ({ inner, floorUp, mid }) => {
        // Chests along the far wall, facing back toward the doorway; neighbours join into doubles.
        const d = style === 'surface' ? 3 : 3
        for (const df of [-1, 0, 1]) put(map, inner(d), floorUp, mid + df, 'furniture', { item: 'chest', front: [1, 0, 0] })
        put(map, inner(1), floorUp + 1, mid + 1, 'light')
      }
      if (style === 'surface') surfaceWing(map, geo, -1, 4, 2, fill)
      else carvedRoom(map, geo, -1, 4, 2, fill)
    }
  },
  enchanting_room: {
    styles: ['surface', 'underground'],
    about: 'a side room with an enchanting table and the full ring of 15 bookshelves (bring them)',
    apply (map, geo, style) {
      const fill = ({ inner, floorUp, mid }) => {
        const c = 3 // table sits 3 in from the doorway
        put(map, inner(c), floorUp, mid, 'furniture', { item: 'enchanting_table' })
        for (let dd = -2; dd <= 2; dd++) {
          for (let df = -2; df <= 2; df++) {
            if (Math.max(Math.abs(dd), Math.abs(df)) !== 2) continue
            if (dd === -2 && df === 0) continue // the way in
            put(map, inner(c + dd), floorUp, mid + df, 'furniture', { item: 'bookshelf' })
          }
        }
        put(map, inner(c + 2), floorUp + 1, mid + 2, 'light')
        put(map, inner(c + 2), floorUp + 1, mid - 2, 'light')
      }
      if (style === 'surface') surfaceWing(map, geo, 1, 6, 3, fill)
      else carvedRoom(map, geo, 1, 6, 2, fill)
    }
  },
  bunker: {
    styles: ['surface'],
    about: 'a safe room dug under the house, down a ladder shaft',
    apply (map, geo) {
      const { h, mid, L } = geo
      const opened = []
      // Room under the house: 3 high, a little below the floor.
      for (let fi = 1; fi <= L - 2; fi++) {
        for (let ri = -h + 1; ri <= h - 1; ri++) {
          for (let up = -4; up <= -2; up++) { put(map, ri, up, fi, 'air'); opened.push(map.get(key(ri, up, fi))) }
          put(map, ri, -5, fi, 'support')
        }
      }
      // Ladder shaft against the right-hand wall, from the floor down to the bunker.
      const lf = geo.bunkerF ?? mid + 1 // a spot along the right wall that isn't furniture
      for (let up = -4; up <= 0; up++) { put(map, h - 1, up, lf, 'ladder', { item: 'ladder', wall: [1, 0, 0] }); opened.push(map.get(key(h - 1, up, lf))) }
      put(map, -h + 1, -3, 2, 'light'); put(map, -h + 1, -3, L - 3, 'light')
      put(map, -h + 1, -4, L - 2, 'furniture', { item: 'chest', front: [1, 0, 0] })
      addShell(map, opened, { skipFront: false })
    }
  },
  second_storey: {
    styles: ['surface'],
    about: 'an upper floor with a ladder and an upstairs bedroom',
    apply () { /* handled by regenerating the house with storeys = 2 */ }
  }
}

// The full blueprint for a base project: its variant plus every upgrade it has.
function baseLayout (proj) {
  const p = { ...proj }
  if ((p.upgrades || []).includes('second_storey')) p.storeys = 2
  const base = baseGeometry(p)
  const map = cellMap(base.cells)
  for (const up of p.upgrades || []) UPGRADES[up]?.apply(map, base.geo, p.style)
  return { cells: [...map.values()], inside: base.inside, entrance: base.entrance, geo: base.geo }
}

// Designs from the bot's newest tier are the most likely pick (a good builder mostly builds its
// best), older ones still turn up now and then. Returns every allowed design in a random order,
// so the caller can fall back to the next one when the first doesn't fit the land.
function variantOrder (style, allowed, rand = Math.random) {
  const pool = Object.entries(VARIANTS).filter(([name, v]) => v.style === style && allowed.includes(name))
  if (!pool.length) return [style === 'surface' ? 'cottage' : 'cellar']
  const newest = Math.max(...pool.map(([, v]) => v.tier))
  const items = pool.map(([name, v]) => ({ name, w: Math.max(1, 3 - (newest - v.tier)) }))
  const out = []
  while (items.length) {
    let x = rand() * items.reduce((n, i) => n + i.w, 0)
    let k = 0
    while (k < items.length - 1 && x >= items[k].w) { x -= items[k].w; k++ }
    out.push(items.splice(k, 1)[0].name)
  }
  return out
}

function pickVariant (style, allowed, rand = Math.random) {
  return variantOrder(style, allowed, rand)[0]
}

// Upgrades the bot knows that fit this base and aren't built yet.
function availableUpgrades (proj, known) {
  const v = VARIANTS[proj.variant || (proj.style === 'surface' ? 'cottage' : 'cellar')] || {}
  return (known || []).filter(u => UPGRADES[u] && UPGRADES[u].styles.includes(proj.style) &&
    (v.upgrades || []).includes(u) && !(proj.upgrades || []).includes(u) &&
    !(u === 'second_storey' && (proj.storeys || 1) > 1))
}

// The rectangle (and height) a layout needs, for the site finder.
function footprintBox (layout) {
  const box = { riMin: Infinity, riMax: -Infinity, fiMin: Infinity, fiMax: -Infinity, height: 0 }
  for (const c of layout.cells) {
    const [ri, up, fi] = c.rel
    if (up < 0) continue
    box.riMin = Math.min(box.riMin, ri); box.riMax = Math.max(box.riMax, ri)
    box.fiMin = Math.min(box.fiMin, fi); box.fiMax = Math.max(box.fiMax, fi)
    box.height = Math.max(box.height, up)
  }
  return box
}

module.exports = { VARIANTS, UPGRADES, baseLayout, baseGeometry, pickVariant, variantOrder, availableUpgrades, footprintBox, chooseHillsideSite: DS.chooseHillsideSite, longhouse, hall }
