// sim.js — headless, deterministic mycology simulation (Design Revision 2026-06-27).
// No DOM, no rendering. Same seed => same world.
//
// ECONOMY — a two-input pipeline that produces one universal currency:
//   NITROGEN  is mined from hidden ORGANIC-MATTER NODES. Extraction scales with how
//             many of your tiles contact a node — surround it to gush. Finite reserve.
//   Nitrogen is carried through the network to TREE ROOTS, where it is exchanged for
//   SUGAR (a continuous flow). The HUB tree (by the core) trades best and instantly;
//   DISTANT roots add throughput once your nitrogen income outgrows the hub, but ramp
//   up with a transport delay.
//   WATER     is passive: every tile absorbs water from the soil — more, the deeper it
//             sits. You get water by reaching downward, not by hunting for it.
//   SUGAR     is the universal currency. Growth & upkeep cost SUGAR + WATER; upgrades
//             cost SUGAR. Sugar is always scarce because everything competes for it.
//
// Hidden by FOG OF WAR: nodes and tree roots are only revealed near your network.
// Reveal is permanent. Subtle hints appear in the soil when a node is just out of range.

export const CONFIG = {
  W: 64,
  H: 40,
  AIR_ROWS: 5,
  start: { sugar: 42, water: 38, nitrogen: 0 },

  cap: { sugar: 300, water: 110, nitrogen: 200 }, // sugar clears the 200 tier-3 cost; N banks with runway

  // Growth costs SUGAR + WATER together, scaled by tile difficulty (deeper = pricier).
  cost: { sugar: 1.0, water: 1.0 },
  costMul: { surface: 0.9, topsoil: 1.0, subsoil: 1.5, rock: 2.4 },

  upkeep: { sugar: 0.025, water: 0.02 }, // per hypha tile, per second (sugar is the pressure)

  growthBase: 7,                        // tiles/sec the frontier advances

  // Passive water absorbed per tile per second, by layer (deeper = wetter).
  water: { surface: 0.035, topsoil: 0.10, subsoil: 0.20, rock: 0.30 },

  // Nitrogen extraction: per contacting tile (on-node or orthogonally adjacent), per sec.
  nitrogenPerContact: 0.9,
  // Deep nodes are ancient, dense organic matter: they mine faster per contact. Together
  // with the motherlode tier this makes FORAGING T3 a power spike — the deep rush — not
  // just an unlock. Over half the map's nitrogen sits below the T3 line.
  deepBonus: 1.5,

  // Tree exchange: nitrogen -> sugar. The HUB (by the core) trades for QUALITY — the best
  // rate, instantly. DISTANT roots trade for VOLUME — a bit less per unit, but each one you
  // reach adds real throughput so you can cash a nitrogen stockpile faster. Which root is
  // best is a routing decision: sugar-per-nitrogen falls with TRANSPORT DISTANCE (fungal
  // hops from your actively-mining nodes to that root). A distant root sitting right by a
  // rich node can out-earn hauling everything back to a far-away hub. Thicker trunks
  // (MYCELIUM T2) and faster tree transport (SYMBIOSIS T2) both flatten that distance
  // penalty. `throughput` stays modest so a surrounded gusher out-mines a single root and
  // nitrogen visibly BANKS — expanding trade capacity is the reward loop.
  tree: {
    hub:     { exchange: 2.6, throughput: 2.4, warmup: 0 },
    distant: { exchange: 1.9, throughput: 2.2, warmup: 6 },
  },
  // Sugar-per-nitrogen at a root is divided by (1 + hopCost * hops-to-nearest-active-node).
  // Crossover: a distant root beside your dig site beats the hub once the haul back to the
  // hub exceeds ~5 hops — the routing decision should bite within the first minutes.
  transport: { hopCost: 0.08, thickMul: 0.6, treeMul: 0.5 },

  reveal: { base: 3, hint: 2 },         // fog reveal radius (tiles) + hint band beyond

  // Upgrade costs in SUGAR, per tier (sequential within a track). Snappy first buy, then
  // escalating; the tier-3 price sits under the sugar cap so you can bank for it.
  upgrades: {
    foraging:  [40, 95, 190],
    mycelium:  [40, 95, 190],
    symbiosis: [40, 95, 190],
  },

  starveInterval: 0.7,
  coreGrace: 3.0,
  dieBackFrac: 0.05,

  // FRUITING — the level's WIN. A bed of mushroom spots along the surface; each becomes
  // pourable once your network runs beneath it. Clicking a cap banks `pour` sugar into it
  // (irreversible — spend-vs-grow is the tension). Fill all of them and the level blooms.
  fruit: { count: 5, need: 60, pour: 12, reachX: 2, reachDepth: 3 },
};

// Organic-matter node richness tiers. size = tile footprint radius hint; reserve = N units.
const N_TIERS = {
  small:      { reserve: 55,  span: 1 },
  medium:     { reserve: 120, span: 1 },
  large:      { reserve: 210, span: 2 },
  gusher:     { reserve: 340, span: 2 },
  motherlode: { reserve: 600, span: 2 },  // deep-only jackpot — the reason to dig
};

// ---- seeded RNG (mulberry32) ------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

// ---- tiny binary min-heap for Dijkstra --------------------------------------
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(prio, val) {
    const a = this.a; a.push([prio, val]); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break;[a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { let l = i * 2 + 1, r = l + 1, s = i; if (l < a.length && a[l][0] < a[s][0]) s = l; if (r < a.length && a[r][0] < a[s][0]) s = r; if (s === i) break;[a[s], a[i]] = [a[i], a[s]]; i = s; } }
    return top;
  }
}

export function createSim(seed) {
  const C = CONFIG, W = C.W, H = C.H;
  const rng = makeRng(seed);
  const idx = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  // --- tile array ---
  const tiles = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    tiles[idx(x, y)] = {
      x, y, layer: 'air', passable: false, costMul: 1, water: 0,
      hypha: false, dist: -1, boulder: false, planned: false, revealed: false,
      nodeId: -1, node: false, rootId: -1, root: false, logId: -1, log: false,
    };
  }
  const tileAt = (x, y) => tiles[idx(x, y)];

  // --- ground line (gentle undulation) ---
  const phase1 = rng() * Math.PI * 2, phase2 = rng() * Math.PI * 2;
  const groundY = new Array(W);
  for (let x = 0; x < W; x++) {
    const u = 1.4 + 1.3 * Math.sin(x * 0.16 + phase1) + 0.8 * Math.sin(x * 0.37 + phase2);
    groundY[x] = C.AIR_ROWS + Math.max(0, Math.min(3, Math.round(u)));
  }

  // --- layers + per-tile passive water yield ---
  for (let x = 0; x < W; x++) {
    const top = groundY[x];
    const depth = H - top;
    const topsoilEnd = top + Math.floor(depth * 0.42);
    const subsoilEnd = top + Math.floor(depth * 0.72);
    for (let y = top; y < H; y++) {
      const t = tileAt(x, y);
      let layer;
      if (y < top + 2) layer = 'surface';
      else if (y < topsoilEnd) layer = 'topsoil';
      else if (y < subsoilEnd) layer = 'subsoil';
      else layer = 'rock';
      t.layer = layer; t.passable = true; t.costMul = C.costMul[layer]; t.water = C.water[layer];
    }
  }

  // --- boulders (impassable chunks) ---
  const boulderSeeds = Math.floor(W * H * 0.012);
  for (let i = 0; i < boulderSeeds; i++) {
    const bx = ri(rng, 0, W - 1);
    const by = ri(rng, groundY[bx] + 4, H - 1);
    const n = ri(rng, 1, 4);
    let cx = bx, cy = by;
    for (let k = 0; k < n; k++) {
      if (inB(cx, cy)) { const t = tileAt(cx, cy); if (t.passable) { t.boulder = true; t.passable = false; } }
      cx += ri(rng, -1, 1); cy += ri(rng, 0, 1);
    }
  }

  // --- core (starting spore) ---
  const cx = Math.floor(W / 2) + ri(rng, -3, 3);
  const cy = groundY[cx] + 3;
  const core = { x: cx, y: cy };

  const occupied = (x, y) => {
    if (!inB(x, y)) return true;
    const t = tileAt(x, y);
    return t.layer === 'air' || !t.passable || t.node || t.root || t.log;
  };

  // --- the great tree: ONE canopy above, many roots reaching down into the soil ---
  // The whole map sits beneath a single tree. Each entry below is a ROOT INTERFACE where
  // nitrogen is traded for sugar: the HUB root is the primary one straight under the core;
  // the others are secondary roots spread across the upper soil (the "distant roots").
  const trunkX = cx;                          // trunk descends right over the core
  const trees = [];
  function makeRoot(tx, hub) {
    tx = Math.max(1, Math.min(W - 2, tx));
    const surf = groundY[tx];
    const root = { id: trees.length, x: tx, y: surf, hub, roots: [], connected: false, warm: hub ? 1 : 0, tapped: 0, sugarOut: 0 };
    trees.push(root);
    const len = hub ? ri(rng, 4, 5) : ri(rng, 3, 6);
    let rx = tx;
    for (let k = 1; k <= len; k++) {
      const ry = surf + k;
      if (inB(rx, ry) && tileAt(rx, ry).passable && !occupied(rx, ry)) {
        const t = tileAt(rx, ry); t.root = true; t.rootId = root.id; root.roots.push({ x: rx, y: ry });
      }
      if (rng() < 0.5) rx += ri(rng, -1, 1);
    }
  }
  makeRoot(cx, true);                          // hub root by the core (instant, best rate)
  for (const c of [Math.round(W * 0.14), Math.round(W * 0.86), cx < W / 2 ? Math.round(W * 0.72) : Math.round(W * 0.28)])
    if (Math.abs(c - cx) > 7) makeRoot(c, false);   // secondary roots, spread wide

  // --- organic-matter nodes (nitrogen) — scattered, variable richness, fog-hidden ---
  const nodes = [];
  function placeNode(centerX, centerY, tierName) {
    const tier = N_TIERS[tierName];
    const id = nodes.length;
    // A node counts as "deep" (locked until FORAGING T3) by where its centre sits.
    const cl = inB(centerX, centerY) ? tileAt(centerX, centerY).layer : 'air';
    const deep = cl === 'subsoil' || cl === 'rock';
    const node = { id, tier: tierName, reserve: tier.reserve, maxReserve: tier.reserve, span: tier.span,
                   tiles: [], deep, revealed: false, hinted: false, contacts: 0, rate: 0 };
    const r = tier.span;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > r) continue;
      const x = centerX + dx, y = centerY + dy;
      if (!inB(x, y)) continue;
      const t = tileAt(x, y);
      if (t.layer === 'air' || t.boulder || t.node || t.root || t.log) continue;
      t.passable = true; t.node = true; t.nodeId = id; node.tiles.push({ x, y });
    }
    if (!node.tiles.length) return null;
    nodes.push(node);
    return node;
  }
  function randNodeSpot(minY, maxY) {
    for (let tries = 0; tries < 40; tries++) {
      const x = ri(rng, 3, W - 4);
      const y = ri(rng, Math.max(groundY[x] + 2, minY), maxY);
      if (!occupied(x, y) && Math.abs(x - cx) + Math.abs(y - cy) > 4) return { x, y };
    }
    return null;
  }
  // Starter node: a guaranteed medium deposit a few tiles from the core, sitting just
  // beyond the opening reveal so it shows up first as a soil HINT (teaches the loop).
  {
    const dir = cx < W / 2 ? 1 : -1;
    placeNode(cx + dir * 5, cy + 1, 'medium');
  }
  // Shallow/mid scatter (surface/topsoil, accessible from the start of a run).
  const scatter = ['small', 'small', 'medium', 'medium', 'large', 'gusher'];
  for (const tier of scatter) {
    const spot = randNodeSpot(C.AIR_ROWS + 2, Math.floor(H * 0.42));
    if (spot) placeNode(spot.x, spot.y, tier);
  }
  // Deep reserves in the subsoil/rock — locked behind FORAGING T3 (deep extraction).
  // A guaranteed MOTHERLODE plus two rich companions: more than half the map's nitrogen
  // is down here, so the shallow game running dry is an invitation, not an ending.
  for (const tier of ['motherlode', rng() < 0.5 ? 'large' : 'gusher', rng() < 0.5 ? 'large' : 'gusher']) {
    const spot = randNodeSpot(Math.floor(H * 0.6), H - 2);
    if (spot) placeNode(spot.x, spot.y, tier);
  }

  // --- buried logs (free burst growth on contact; not a banked resource) ---
  const logs = [];
  for (let i = 0; i < 4; i++) {
    const len = ri(rng, 3, 6);
    for (let tries = 0; tries < 24; tries++) {
      const x = ri(rng, 2, W - len - 2);
      const y = ri(rng, groundY[x] + 3, Math.floor(H * 0.78));
      let ok = true;
      for (let k = 0; k < len; k++) if (occupied(x + k, y)) { ok = false; break; }
      if (!ok) continue;
      const id = logs.length; const log = { id, tiles: [], consumed: false };
      for (let k = 0; k < len; k++) { const t = tileAt(x + k, y); t.log = true; t.logId = id; log.tiles.push({ x: x + k, y }); }
      logs.push(log);
      break;
    }
  }

  // --- fruiting spots: a bed of mushrooms along the surface (the level's win) ---
  // One spot per equal slice of the map, jittered, kept off the trunk. Visible from the
  // start — they ARE the goal — but pourable only once the network runs beneath them.
  const fruits = [];
  for (let i = 0; i < C.fruit.count; i++) {
    const lo = 2 + Math.floor((W - 4) * i / C.fruit.count);
    const hi = 1 + Math.floor((W - 4) * (i + 1) / C.fruit.count);
    let fx = ri(rng, lo, Math.max(lo, hi));
    if (Math.abs(fx - trunkX) < 3) fx = trunkX + (fx < trunkX ? -3 : 3); // keep off the trunk
    fx = Math.max(1, Math.min(W - 2, fx));
    fruits.push({ id: i, x: fx, banked: 0, need: C.fruit.need, reachable: false, mature: false });
  }

  // --- light the core ---
  const ct = tileAt(cx, cy); ct.boulder = false; ct.passable = true; ct.hypha = true; ct.dist = 0;
  ct.node = false; ct.nodeId = -1; ct.root = false; ct.rootId = -1; ct.log = false; ct.logId = -1;

  // --- state ---
  const reserveTotal = nodes.reduce((s, n) => s + n.reserve, 0);
  const state = {
    seed, W, H, AIR_ROWS: C.AIR_ROWS, groundY, tiles, nodes, trees, logs, core, trunkX,
    fruits, bloomed: 0,                       // surface mushrooms — fill them all to WIN
    reserveTotal, reserveLeft: reserveTotal,  // nitrogen still buried, map-wide (the run's clock)
    reserveLocked: nodes.reduce((s, n) => s + (n.deep ? n.reserve : 0), 0), // deep share, locked at start
    res: { ...C.start },
    upg: { foraging: 0, mycelium: 0, symbiosis: 0 },
    size: 1, peak: 1, time: 0,
    waterYield: 0,
    queue: [], growAcc: 0,
    growthActive: false, bottleneck: null,   // 'sugar' | 'water' | null
    starving: false, starveTimer: 0, coreStarveTimer: 0,
    income: { sugar: 0, water: 0, nitrogen: 0 },
    harvest: 0,                               // gross nitrogen mined/sec (before trading)
    trade: { nitrogen: 0, sugar: 0 },         // live nitrogen -> sugar conversion/sec
    exchangeRate: CONFIG.tree.hub.exchange,   // best (hub) sugar returned per nitrogen
    nitrogenFull: false,                      // pool capped while still over-harvesting
    fx: [],                                   // transient visual events (log bursts)
    over: false, result: null,
  };

  // ---- upgrade effects (each tier is one clear scalar effect) ----
  const extractMult     = () => state.upg.foraging  >= 1 ? 1.6 : 1;      // FORAGING T1
  const revealR         = () => C.reveal.base + (state.upg.foraging >= 2 ? 2 : 0); // FORAGING T2
  const deepUnlocked    = () => state.upg.foraging  >= 3;                 // FORAGING T3
  const growthRate      = () => C.growthBase * (state.upg.mycelium >= 1 ? 1.5 : 1); // MYCELIUM T1
  const nitroCapMult    = () => state.upg.mycelium  >= 2 ? 1.5 : 1;      // MYCELIUM T2 (thicker trunks buffer more)
  const upkeepMult      = () => state.upg.mycelium  >= 3 ? 0.6 : 1;      // MYCELIUM T3
  const exchangeMult    = () => state.upg.symbiosis >= 1 ? 1.4 : 1;      // SYMBIOSIS T1
  const throughputMult  = () => state.upg.symbiosis >= 3 ? 1.6 : 1;      // SYMBIOSIS T3
  // Distant-root warmup is sped by tree-side transport (SYMBIOSIS T2) and fungal-side
  // transport (MYCELIUM T2 thicker trunks) together.
  const warmupRate      = (warmup) => warmup <= 0 ? Infinity
    : 1 / (warmup * (state.upg.symbiosis >= 2 ? 0.5 : 1) * (state.upg.mycelium >= 2 ? 0.7 : 1));

  // ---- helpers ----
  const neigh = (x, y) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
  const resourceCost = (t) => ({ sugar: C.cost.sugar * t.costMul, water: C.cost.water * t.costMul });
  const adjToNet = (x, y) => neigh(x, y).some(([nx, ny]) => inB(nx, ny) && tileAt(nx, ny).hypha);
  const capFor = (kind) => kind === 'nitrogen' ? C.cap.nitrogen * nitroCapMult() : C.cap[kind];
  const addRes = (kind, amt) => { state.res[kind] = Math.min(capFor(kind), state.res[kind] + amt); };

  function pathResourceCost(path) {
    const c = { sugar: 0, water: 0 };
    for (const p of path) { const t = tileAt(p.x, p.y); if (t.hypha) continue; const rc = resourceCost(t); c.sugar += rc.sugar; c.water += rc.water; }
    return c;
  }

  // Reveal fog permanently in a radius around (x,y).
  function revealAround(x, y) {
    const R = revealR();
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R + 1) continue;
      const nx = x + dx, ny = y + dy;
      if (inB(nx, ny)) tileAt(nx, ny).revealed = true;
    }
  }
  function revealAllNetwork() { for (const t of tiles) if (t.hypha) revealAround(t.x, t.y); }

  // Reusable Dijkstra scratch buffers — pathTo runs synchronously and isn't re-entrant,
  // so sharing avoids allocating two W*H arrays on every hover/grow.
  const distBuf = new Float64Array(W * H);
  const prevBuf = new Int32Array(W * H);
  const hopBuf = new Int32Array(W * H);    // fungal-hop distance from active mining sites
  let pendingRecompute = false;            // a log burst happened; resync the network

  // Multi-source Dijkstra from the whole network to (tx,ty). Returns ordered tiles to
  // grow (near -> far), [] if already reached, or null if unreachable.
  function pathTo(tx, ty) {
    if (!inB(tx, ty)) return null;
    const target = tileAt(tx, ty);
    if (!target.passable) return null;
    if (target.hypha) return [];
    const dist = distBuf, prev = prevBuf;
    dist.fill(Infinity); prev.fill(-1);
    const heap = new Heap();
    for (const t of tiles) if (t.hypha) { dist[idx(t.x, t.y)] = 0; heap.push(0, idx(t.x, t.y)); }
    const ti = idx(tx, ty);
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      if (i === ti) break;
      const x = i % W, y = (i / W) | 0;
      for (const [nx, ny] of neigh(x, y)) {
        if (!inB(nx, ny)) continue;
        const nt = tileAt(nx, ny);
        if (!nt.passable) continue;
        const w = nt.hypha ? 0 : nt.costMul;
        const ni = idx(nx, ny);
        const nd = d + w;
        if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = i; heap.push(nd, ni); }
      }
    }
    if (dist[ti] === Infinity) return null;
    const path = [];
    let cur = ti;
    while (cur !== -1) { const x = cur % W, y = (cur / W) | 0; const t = tileAt(x, y); if (!t.hypha) path.push({ x, y }); cur = prev[cur]; }
    path.reverse();
    return path;
  }

  function growToward(tx, ty) {
    const path = pathTo(tx, ty);
    if (!path || !path.length) return;
    for (const p of state.queue) tileAt(p.x, p.y).planned = false;
    state.queue = path;
    for (const p of state.queue) tileAt(p.x, p.y).planned = true;
  }

  function occupy(t) {
    t.hypha = true; t.planned = false;
    let best = Infinity;
    for (const [nx, ny] of neigh(t.x, t.y)) if (inB(nx, ny)) { const n = tileAt(nx, ny); if (n.hypha && n.dist >= 0) best = Math.min(best, n.dist); }
    t.dist = best === Infinity ? 0 : best + 1;
    state.size++; if (state.size > state.peak) state.peak = state.size;
    state.waterYield += t.water;
    revealAround(t.x, t.y);
    // Touching a buried log eats through it for free — a burst of instant growth.
    for (const [nx, ny] of neigh(t.x, t.y)) {
      if (!inB(nx, ny)) continue;
      const n = tileAt(nx, ny);
      if (n.log && n.logId >= 0 && !logs[n.logId].consumed) consumeLog(logs[n.logId]);
    }
  }

  function consumeLog(log) {
    if (log.consumed) return;
    log.consumed = true;
    for (const c of log.tiles) {
      const t = tileAt(c.x, c.y);
      if (!t.hypha && t.passable) occupy(t);   // free — no sugar/water spent
      state.fx.push({ kind: 'burst', x: c.x, y: c.y, t: 0.8, max: 0.8 });
    }
    pendingRecompute = true; // burst tiles were occupied out of order — fix distances
  }

  // BFS from core: set distances, drop hyphae no longer connected, recount size/water.
  function recomputeNetwork() {
    for (const t of tiles) if (t.hypha) t.dist = -1;
    const q = [core]; tileAt(core.x, core.y).dist = 0;
    let head = 0, count = 1;
    while (head < q.length) {
      const { x, y } = q[head++]; const d = tileAt(x, y).dist;
      for (const [nx, ny] of neigh(x, y)) if (inB(nx, ny)) { const n = tileAt(nx, ny); if (n.hypha && n.dist < 0) { n.dist = d + 1; q.push({ x: nx, y: ny }); count++; } }
    }
    let water = 0;
    for (const t of tiles) {
      if (!t.hypha) continue;
      if (t.dist < 0) { t.hypha = false; continue; } // unreachable -> dies
      water += t.water;
    }
    state.size = count; state.waterYield = water;
  }

  function dieBack() {
    recomputeNetwork();
    const leaves = tiles.filter(t => t.hypha && t.dist > 0).sort((a, b) => b.dist - a.dist);
    const k = Math.max(1, Math.floor(state.size * C.dieBackFrac));
    for (let i = 0; i < k && i < leaves.length; i++) leaves[i].hypha = false;
    recomputeNetwork();
  }

  // ---- upgrades ----
  const upgradeTracks = ['foraging', 'mycelium', 'symbiosis'];
  function upgradeCost(track) {
    const tier = state.upg[track];
    const costs = C.upgrades[track];
    return tier >= costs.length ? null : costs[tier];
  }
  function buyUpgrade(track) {
    if (!upgradeTracks.includes(track)) return false;
    const cost = upgradeCost(track);
    if (cost === null || state.res.sugar < cost) return false;
    state.res.sugar -= cost; state.upg[track]++;
    if (track === 'foraging' && state.upg.foraging === 2) revealAllNetwork(); // bigger reveal, apply now
    return true;
  }

  // ---- per-tick economy ----
  function economyStep(dt) {
    // 1) NITROGEN extraction — rate scales with how many tiles contact each node.
    const nBefore = state.res.nitrogen;
    let nGain = 0;
    const activeSrc = [];                    // hypha tiles currently pulling nitrogen (BFS roots)
    for (const n of state.nodes) {
      n.contacts = 0; n.rate = 0;
      if (n.reserve <= 0) continue;
      if (n.deep && !deepUnlocked()) continue;          // deep reserves locked until FORAGING T3
      const seen = new Set();
      for (const c of n.tiles) {
        const here = tileAt(c.x, c.y);
        if (here.hypha) seen.add(idx(c.x, c.y));
        for (const [nx, ny] of neigh(c.x, c.y)) if (inB(nx, ny) && tileAt(nx, ny).hypha) seen.add(idx(nx, ny));
      }
      n.contacts = seen.size;
      if (!n.contacts) continue;
      const rate = C.nitrogenPerContact * n.contacts * extractMult() * (n.deep ? C.deepBonus : 1);
      const y = Math.min(rate * dt, n.reserve);
      n.reserve -= y; n.rate = y / dt; nGain += y;
      if (n.reserve <= 0) {                     // mined dry this tick — mark the moment
        const c = n.tiles[(n.tiles.length / 2) | 0];
        state.fx.push({ kind: 'deplete', x: c.x, y: c.y, t: 1.4, max: 1.4 });
      }
      if (n.rate > 0) for (const i of seen) activeSrc.push(i);   // these tiles feed the routing BFS
    }
    state.reserveLeft = 0; state.reserveLocked = 0;
    for (const n of state.nodes) {
      state.reserveLeft += n.reserve;
      if (n.deep && !deepUnlocked()) state.reserveLocked += n.reserve;  // buried below the T3 line
    }

    // Fungal-hop distance field: how many network steps from the nearest ACTIVE mining site
    // to every hypha tile. A root's distance in this field is the transport cost of hauling
    // freshly-mined nitrogen to it — the heart of the hub-vs-distant-root routing decision.
    let hopField = null;
    if (activeSrc.length) {
      hopBuf.fill(-1);
      const q = []; let head = 0;
      for (const i of activeSrc) if (hopBuf[i] < 0) { hopBuf[i] = 0; q.push(i); }
      while (head < q.length) {
        const i = q[head++], x = i % W, y = (i / W) | 0, d = hopBuf[i];
        for (const [nx, ny] of neigh(x, y)) {
          if (!inB(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (tileAt(nx, ny).hypha && hopBuf[ni] < 0) { hopBuf[ni] = d + 1; q.push(ni); }
        }
      }
      hopField = hopBuf;
    }
    // Hops from a root's interface to the nearest active mining site (0 if nothing is mining).
    const rootHops = (tr) => {
      if (!hopField) return 0;
      let best = Infinity;
      for (const r of tr.roots) {
        const here = idx(r.x, r.y);
        if (tileAt(r.x, r.y).hypha && hopField[here] >= 0) best = Math.min(best, hopField[here]);
        for (const [nx, ny] of neigh(r.x, r.y)) if (inB(nx, ny) && tileAt(nx, ny).hypha && hopField[idx(nx, ny)] >= 0) best = Math.min(best, hopField[idx(nx, ny)]);
      }
      return best === Infinity ? 0 : best;
    };
    // Per-hop rate penalty, flattened by thicker trunks (MYCELIUM T2) and faster tree
    // transport (SYMBIOSIS T2) — the two upgrades the design says shrink distance cost.
    const effHopCost = C.transport.hopCost
      * (state.upg.mycelium  >= 2 ? C.transport.thickMul : 1)
      * (state.upg.symbiosis >= 2 ? C.transport.treeMul  : 1);
    const capN = capFor('nitrogen');
    const wasted = Math.max(0, nBefore + nGain - capN); // overflow discarded this tick
    addRes('nitrogen', nGain);

    // 2) TREE EXCHANGE — connected roots pull nitrogen from the pool and return sugar.
    //    Each root's effective rate = base rate / (1 + hopCost·hops-to-active-mining). The
    //    hub wins when you mine near the core; a distant root wins when it sits closer to
    //    where you're actually digging. Best effective rate trades first, up to throughput.
    let sGain = 0, nSpent = 0, bestEx = 0;
    const active = [];
    for (const tr of state.trees) {
      tr.connected = tr.roots.some(r => { const t = tileAt(r.x, r.y); return t.hypha || adjToNet(r.x, r.y); });
      tr.sugarOut = 0; tr.tapped = 0;
      const base = tr.hub ? C.tree.hub : C.tree.distant;
      // warmup ramps 0->1 while connected (instant for the hub), resets when severed.
      if (tr.connected) tr.warm = base.warmup <= 0 ? 1 : Math.min(1, tr.warm + warmupRate(base.warmup) * dt);
      else { tr.warm = base.warmup <= 0 ? 1 : 0; tr.hops = 0; tr.exchange = base.exchange * exchangeMult(); continue; }
      tr.hops = rootHops(tr);
      tr.exchange = base.exchange * exchangeMult() / (1 + effHopCost * tr.hops);
      if (tr.exchange > bestEx) bestEx = tr.exchange;   // best effective rate (for HUD)
      active.push(tr);
    }
    active.sort((a, b) => b.exchange - a.exchange);      // route nitrogen to the best rate first
    for (const tr of active) {
      const base = tr.hub ? C.tree.hub : C.tree.distant;
      const through = base.throughput * throughputMult() * tr.warm;
      const take = Math.min(through * dt, state.res.nitrogen);
      if (take <= 0) continue;
      state.res.nitrogen -= take; nSpent += take;
      const sugar = take * tr.exchange; sGain += sugar;
      tr.sugarOut = sugar / dt; tr.tapped = take / dt;
    }
    addRes('sugar', sGain);

    // 3) WATER — passive absorption from soil, more the deeper the network reaches.
    const wGain = state.waterYield * dt;
    addRes('water', wGain);

    // 4) UPKEEP — every tile costs sugar + water continuously.
    const upS = state.size * C.upkeep.sugar * upkeepMult() * dt;
    const upW = state.size * C.upkeep.water * upkeepMult() * dt;
    state.res.sugar -= upS; state.res.water -= upW;
    let deficit = false;
    if (state.res.sugar < 0) { state.res.sugar = 0; deficit = true; }
    if (state.res.water < 0) { state.res.water = 0; deficit = true; }

    // Nitrogen rate is the TRUE pool delta (so it reads ◦ when capped, not a false ▲).
    state.income.nitrogen = (state.res.nitrogen - nBefore) / dt;
    state.income.sugar = sGain / dt - state.size * C.upkeep.sugar * upkeepMult();
    state.income.water = wGain / dt - state.size * C.upkeep.water * upkeepMult();
    // Pipeline readouts for the HUD: what you mine, what trees trade, and the rate.
    state.harvest = nGain / dt;
    state.trade = { nitrogen: nSpent / dt, sugar: sGain / dt };
    state.exchangeRate = bestEx > 0 ? bestEx : C.tree.hub.exchange * exchangeMult();
    state.nitrogenFull = wasted > 1e-6; // genuinely discarding nitrogen at the cap

    if (deficit) {
      state.starving = true; state.starveTimer += dt;
      if (state.starveTimer >= C.starveInterval) { state.starveTimer -= C.starveInterval; dieBack(); }
      if (state.size <= 1) { state.coreStarveTimer += dt; if (state.coreStarveTimer >= C.coreGrace) gameOver('starved'); }
    } else {
      state.starving = false; state.starveTimer = 0; state.coreStarveTimer = Math.max(0, state.coreStarveTimer - dt);
    }
  }

  // Frontier advances while SUGAR + WATER are both available; the scarcer one throttles.
  function growStep(dt) {
    state.growthActive = false; state.bottleneck = null;
    if (!state.queue.length) return;
    state.growAcc += growthRate() * dt;
    while (state.growAcc >= 1 && state.queue.length) {
      const p = state.queue[0];
      const t = tileAt(p.x, p.y);
      if (t.hypha || !t.passable) { t.planned = false; state.queue.shift(); continue; }
      if (!adjToNet(p.x, p.y)) { t.planned = false; state.queue.shift(); continue; }
      const c = resourceCost(t);
      if (state.res.sugar < c.sugar) { state.bottleneck = 'sugar'; break; }
      if (state.res.water < c.water) { state.bottleneck = 'water'; break; }
      state.res.sugar -= c.sugar; state.res.water -= c.water;
      occupy(t); state.growthActive = true; state.growAcc -= 1; state.queue.shift();
    }
  }

  // Fog hints: flag unrevealed nodes whose reserve sits just beyond the reveal radius.
  function fogStep() {
    const R = revealR(), band = R + C.reveal.hint;
    for (const n of state.nodes) {
      if (!n.revealed) n.revealed = n.tiles.some(c => tileAt(c.x, c.y).revealed);
      if (n.revealed) { n.hinted = false; continue; }
      // Locked deep nodes still hint — the player should FEEL the wealth below before
      // they can touch it; the renderer tints deep hints cool so they read as "later".
      if (n.reserve <= 0) { n.hinted = false; continue; }
      // Is any network tile within the hint band but outside reveal?
      let near = false;
      for (const c of n.tiles) {
        for (let dy = -band; dy <= band && !near; dy++) for (let dx = -band; dx <= band; dx++) {
          const nx = c.x + dx, ny = c.y + dy;
          if (!inB(nx, ny) || !tileAt(nx, ny).hypha) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 > R * R && d2 <= band * band) { near = true; break; }
        }
        if (near) break;
      }
      n.hinted = near;
    }
  }

  // A mushroom is pourable while living hyphae run beneath its patch of surface.
  function fruitStep() {
    for (const f of state.fruits) {
      if (f.mature) { f.reachable = true; continue; }
      const gy = groundY[f.x];
      let near = false;
      for (let dx = -C.fruit.reachX; dx <= C.fruit.reachX && !near; dx++)
        for (let dy = 0; dy <= C.fruit.reachDepth; dy++)
          if (inB(f.x + dx, gy + dy) && tileAt(f.x + dx, gy + dy).hypha) { near = true; break; }
      f.reachable = near;
    }
  }

  // Cap hitbox: the air tiles the mushroom occupies (soil clicks still mean "grow").
  function fruitAt(x, y) {
    for (const f of state.fruits) {
      const gy = groundY[f.x];
      if (Math.abs(x - f.x) <= 1 && y < gy && y >= gy - 3) return f;
    }
    return null;
  }

  // Bank sugar into a surface mushroom. Irreversible. Fill every spot to win the level.
  function pourSugar(id) {
    const f = state.fruits[id];
    if (!f || f.mature || !f.reachable || state.over) return false;
    const amt = Math.min(C.fruit.pour, f.need - f.banked, state.res.sugar);
    if (amt < 1) return false;                // nothing meaningful to pour
    state.res.sugar -= amt; f.banked += amt;
    state.fx.push({ kind: 'pour', x: f.x, y: groundY[f.x] - 1, t: 0.7, max: 0.7 });
    if (f.banked >= f.need) {
      f.mature = true; state.bloomed++;
      state.fx.push({ kind: 'bloom', x: f.x, y: groundY[f.x] - 1, t: 1.6, max: 1.6 });
      if (state.bloomed >= state.fruits.length) gameOver('bloomed');
    }
    return true;
  }

  function gameOver(cause) {
    if (state.over) return;
    state.over = true;
    // Starving with the map mined dry is the EARNED ending — you spent the whole world.
    if (cause === 'starved' && state.reserveLeft < 1) cause = 'exhausted';
    state.result = { peak: state.peak, time: state.time, seed, cause, size: state.size,
                     nitrogenLeft: Math.round(state.reserveLeft), bloomed: state.bloomed };
  }

  function decayFx(dt) { for (let i = state.fx.length - 1; i >= 0; i--) { state.fx[i].t -= dt; if (state.fx[i].t <= 0) state.fx.splice(i, 1); } }

  // Reveal the opening neighborhood and sync network bookkeeping (size, water yield).
  revealAround(cx, cy);
  recomputeNetwork();

  function tick(dt) {
    if (state.over) return;
    state.time += dt;
    growStep(dt);
    if (pendingRecompute) { recomputeNetwork(); pendingRecompute = false; } // resync after a log burst
    economyStep(dt);
    fruitStep();
    fogStep();
    decayFx(dt);
  }

  return {
    state, tick, growToward, pathTo, pathResourceCost, resourceCost, tileAt,
    buyUpgrade, upgradeCost, upgradeTracks, pourSugar, fruitAt, CONFIG: C,
  };
}
