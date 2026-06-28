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

  cap: { sugar: 130, water: 110, nitrogen: 90 },

  // Growth costs SUGAR + WATER together, scaled by tile difficulty (deeper = pricier).
  cost: { sugar: 1.0, water: 1.0 },
  costMul: { surface: 0.9, topsoil: 1.0, subsoil: 1.5, rock: 2.4 },

  upkeep: { sugar: 0.02, water: 0.02 }, // per hypha tile, per second

  growthBase: 7,                        // tiles/sec the frontier advances

  // Passive water absorbed per tile per second, by layer (deeper = wetter).
  water: { surface: 0.035, topsoil: 0.10, subsoil: 0.20, rock: 0.30 },

  // Nitrogen extraction: per contacting tile (on-node or orthogonally adjacent), per sec.
  nitrogenPerContact: 0.7,

  // Tree exchange: nitrogen -> sugar. Hub trades best & instantly; distant roots are
  // weaker and ramp up over `warmup` seconds (the transport delay through the tree).
  tree: {
    hub:     { exchange: 1.5, throughput: 6, warmup: 0 },
    distant: { exchange: 0.9, throughput: 4, warmup: 7 },
  },

  reveal: { base: 3, hint: 2 },         // fog reveal radius (tiles) + hint band beyond

  // Upgrade costs in SUGAR, per tier (sequential within a track).
  upgrades: {
    foraging:  [45, 100, 200],
    mycelium:  [45, 100, 200],
    symbiosis: [45, 100, 200],
  },

  starveInterval: 0.7,
  coreGrace: 3.0,
  dieBackFrac: 0.05,
};

// Organic-matter node richness tiers. size = tile footprint radius hint; reserve = N units.
const N_TIERS = {
  small:  { reserve: 55,  span: 1 },
  medium: { reserve: 120, span: 1 },
  large:  { reserve: 210, span: 2 },
  gusher: { reserve: 340, span: 2 },
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

  // --- trees (exchange interfaces): a trunk on the surface + a root cluster below ---
  const trees = [];
  function makeTree(tx, hub) {
    if (!inB(tx, 0)) return;
    const surf = groundY[tx];
    const tree = { id: trees.length, x: tx, y: surf, hub, roots: [], connected: false, warm: hub ? 1 : 0, tapped: 0, sugarOut: 0 };
    trees.push(tree);
    const len = hub ? ri(rng, 4, 5) : ri(rng, 3, 5);
    let rx = tx;
    for (let k = 1; k <= len; k++) {
      const ry = surf + k;
      if (inB(rx, ry) && tileAt(rx, ry).passable && !occupied(rx, ry)) {
        const t = tileAt(rx, ry); t.root = true; t.rootId = tree.id; tree.roots.push({ x: rx, y: ry });
      }
      if (rng() < 0.45) rx += ri(rng, -1, 1);
    }
  }
  // Hub tree sits over the core so sugar can flow as soon as nitrogen arrives.
  makeTree(cx, true);
  // Distant trees scattered across the surface.
  const distantCols = [ri(rng, 5, 16), ri(rng, W - 16, W - 6), ri(rng, 20, 30) > cx ? ri(rng, cx + 12, W - 8) : ri(rng, 6, cx - 12)];
  for (const dx of distantCols) if (Math.abs(dx - cx) > 8) makeTree(dx, false);

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
  for (let i = 0; i < 2; i++) {
    const spot = randNodeSpot(Math.floor(H * 0.6), H - 2);
    if (spot) placeNode(spot.x, spot.y, rng() < 0.5 ? 'large' : 'gusher');
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

  // --- light the core ---
  const ct = tileAt(cx, cy); ct.boulder = false; ct.passable = true; ct.hypha = true; ct.dist = 0;
  ct.node = false; ct.nodeId = -1; ct.root = false; ct.rootId = -1; ct.log = false; ct.logId = -1;

  // --- state ---
  const state = {
    seed, W, H, AIR_ROWS: C.AIR_ROWS, groundY, tiles, nodes, trees, logs, core,
    res: { ...C.start },
    upg: { foraging: 0, mycelium: 0, symbiosis: 0 },
    size: 1, peak: 1, time: 0,
    waterYield: 0,
    queue: [], growAcc: 0,
    growthActive: false, bottleneck: null,   // 'sugar' | 'water' | null
    starving: false, starveTimer: 0, coreStarveTimer: 0,
    income: { sugar: 0, water: 0, nitrogen: 0 },
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

  // Multi-source Dijkstra from the whole network to (tx,ty). Returns ordered tiles to
  // grow (near -> far), [] if already reached, or null if unreachable.
  function pathTo(tx, ty) {
    if (!inB(tx, ty)) return null;
    const target = tileAt(tx, ty);
    if (!target.passable) return null;
    if (target.hypha) return [];
    const dist = new Float64Array(W * H).fill(Infinity);
    const prev = new Int32Array(W * H).fill(-1);
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
    let nGain = 0;
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
      const rate = C.nitrogenPerContact * n.contacts * extractMult();
      const y = Math.min(rate * dt, n.reserve);
      n.reserve -= y; n.rate = y / dt; nGain += y;
    }
    addRes('nitrogen', nGain);

    // 2) TREE EXCHANGE — connected trees pull nitrogen from the pool and return sugar.
    //    Hub trades first (best rate); distant roots mop up surplus once warmed up.
    let sGain = 0, nSpent = 0;
    const baseEx = tr => (tr.hub ? C.tree.hub : C.tree.distant).exchange;
    const sorted = [...state.trees].sort((a, b) => baseEx(b) - baseEx(a)); // best exchange first (hub leads)
    for (const tr of sorted) {
      tr.connected = tr.roots.some(r => { const t = tileAt(r.x, r.y); return t.hypha || adjToNet(r.x, r.y); });
      tr.sugarOut = 0; tr.tapped = 0;
      const base = tr.hub ? C.tree.hub : C.tree.distant;
      // warmup ramps 0->1 while connected (instant for the hub), resets when severed.
      if (tr.connected) tr.warm = base.warmup <= 0 ? 1 : Math.min(1, tr.warm + warmupRate(base.warmup) * dt);
      else { tr.warm = base.warmup <= 0 ? 1 : 0; continue; }
      const exchange = base.exchange * exchangeMult();
      const through = base.throughput * throughputMult() * tr.warm;
      const take = Math.min(through * dt, state.res.nitrogen);
      if (take <= 0) continue;
      state.res.nitrogen -= take; nSpent += take;
      const sugar = take * exchange; sGain += sugar;
      tr.sugarOut = sugar / dt; tr.tapped = take / dt; tr.exchange = exchange;
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

    state.income.nitrogen = (nGain - nSpent) / dt;
    state.income.sugar = sGain / dt - state.size * C.upkeep.sugar * upkeepMult();
    state.income.water = wGain / dt - state.size * C.upkeep.water * upkeepMult();

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
      if (n.reserve <= 0 || (n.deep && !deepUnlocked())) { n.hinted = false; continue; }
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

  function gameOver(cause) {
    if (state.over) return;
    state.over = true;
    state.result = { peak: state.peak, time: state.time, seed, cause, size: state.size };
  }

  function decayFx(dt) { for (let i = state.fx.length - 1; i >= 0; i--) { state.fx[i].t -= dt; if (state.fx[i].t <= 0) state.fx.splice(i, 1); } }

  // Reveal the opening neighborhood and sync network bookkeeping (size, water yield).
  revealAround(cx, cy);
  recomputeNetwork();

  function tick(dt) {
    if (state.over) return;
    state.time += dt;
    growStep(dt);
    economyStep(dt);
    fogStep();
    decayFx(dt);
  }

  return {
    state, tick, growToward, pathTo, pathResourceCost, resourceCost, tileAt,
    buyUpgrade, upgradeCost, upgradeTracks, CONFIG: C,
  };
}
