// sim.js — headless, deterministic mycology simulation.
// No DOM, no rendering. Same seed => same world + same event timing.
// This is the module that will port to LÖVE2D / Lua later.

export const CONFIG = {
  W: 64,
  H: 40,
  AIR_ROWS: 5,
  cap: 300,                       // resource storage cap
  start: { sugar: 60, water: 45, mineral: 45 },

  // Growth cost per new tile (base), multiplied by the tile's layer cost.
  cost: { sugar: 2.4, water: 1.4, mineral: 0.9 },
  costMul: { surface: 0.9, topsoil: 1.0, subsoil: 1.6, rock: 3.2 },

  // Upkeep drained per hypha tile, per second.
  upkeep: { sugar: 0.035, water: 0.05, mineral: 0.008 },

  growthRate: 8,                  // tiles grown per second (cost-gated)

  node: {
    sugar:   { rate: 4.5, reserve: 130 },
    mineral: { rate: 3.8, reserve: 110 },
    water:   { rate: 5.0, reserve: 150 },
  },

  ashBonus: 7,                    // minerals gained when growing into burned (ash) soil
  starveInterval: 0.7,           // seconds between die-back pulses while starving
  coreGrace: 3.0,                 // seconds core can starve alone before death
  dieBackFrac: 0.04,              // fraction of network lost per die-back pulse

  fire: {
    first: 48,                    // time of first wildfire (s)
    interval: 42,                 // base gap between fires
    accel: 3.5,                   // each fire arrives sooner by this much
    minInterval: 20,              // floor on the gap
    warn: 8,                      // telegraph lead time (s)
    sweepDur: 2.6,                // seconds for the fire to cross the map
    baseDepth: 2,                 // rows below ground burned by the first fire
    depthPerFire: 1,              // extra rows burned each subsequent fire
  },
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
      x, y, layer: 'air', passable: false, costMul: 1,
      hypha: false, dist: -1, boulder: false, ash: false, planned: false,
      nodeId: -1,
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

  // --- layers ---
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
      t.layer = layer; t.passable = true; t.costMul = C.costMul[layer];
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

  // --- nodes ---
  const nodes = [];
  const trees = [];
  const addNodeTile = (x, y, nid) => {
    if (!inB(x, y)) return;
    const t = tileAt(x, y);
    if (t.layer === 'air') return;
    t.boulder = false; t.passable = true; t.nodeId = nid; t.node = true;
    nodes[nid].tiles.push({ x, y });
  };
  const newNode = (kind) => {
    const cfg = C.node[kind];
    const nid = nodes.length;
    nodes.push({ id: nid, kind, tiles: [], reserve: cfg.reserve, maxReserve: cfg.reserve, rate: cfg.rate, tapped: false });
    return nid;
  };

  // 3 trees with sugar roots
  for (let i = 0; i < 3; i++) {
    const x = ri(rng, 4 + i * 18, 14 + i * 18);
    if (!inB(x, 0)) continue;
    trees.push({ x, y: groundY[x] });
    const nid = newNode('sugar');
    const len = ri(rng, 4, 7);
    let rx = x;
    for (let k = 0; k < len; k++) { addNodeTile(rx, groundY[x] + 2 + k, nid); if (rng() < 0.4) rx += ri(rng, -1, 1); }
  }
  // 4 buried logs -> minerals
  for (let i = 0; i < 4; i++) {
    const len = ri(rng, 3, 5);
    const x = ri(rng, 2, W - len - 2);
    const y = ri(rng, groundY[x] + 3, Math.floor(H * 0.7));
    const nid = newNode('mineral');
    for (let k = 0; k < len; k++) addNodeTile(x + k, y, nid);
  }
  // 4 water pockets
  for (let i = 0; i < 4; i++) {
    const x = ri(rng, 4, W - 5);
    const y = ri(rng, Math.floor(H * 0.5), H - 3);
    const r = ri(rng, 1, 2);
    const nid = newNode('water');
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (Math.abs(dx) + Math.abs(dy) <= r) addNodeTile(x + dx, y + dy, nid);
  }

  // --- core (starting spore) ---
  const cx = Math.floor(W / 2) + ri(rng, -3, 3);
  const cy = groundY[cx] + 3;
  const core = { x: cx, y: cy };
  const ct = tileAt(cx, cy); ct.boulder = false; ct.passable = true; ct.hypha = true; ct.dist = 0; ct.nodeId = -1; ct.node = false;

  // --- state ---
  const state = {
    seed, W, H, AIR_ROWS: C.AIR_ROWS, groundY, tiles, nodes, trees, core,
    res: { ...C.start }, cap: C.cap,
    size: 1, peak: 1, time: 0,
    queue: [], growAcc: 0,
    starving: false, starveTimer: 0, coreStarveTimer: 0,
    income: { sugar: 0, mineral: 0, water: 0 },
    fx: [],
    fire: { state: 'idle', nextAt: C.fire.first, warnLeft: 0, sweepX: 0, sweepSpeed: 0, depth: 0, count: 0 },
    over: false, result: null,
  };

  // ---- helpers ----
  const neigh = (x, y) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
  const resourceCost = (t) => ({ sugar: C.cost.sugar * t.costMul, water: C.cost.water * t.costMul, mineral: C.cost.mineral * t.costMul });
  const canAfford = (c) => state.res.sugar >= c.sugar && state.res.water >= c.water && state.res.mineral >= c.mineral;
  const pay = (c) => { state.res.sugar -= c.sugar; state.res.water -= c.water; state.res.mineral -= c.mineral; };
  const adjToNet = (x, y) => neigh(x, y).some(([nx, ny]) => inB(nx, ny) && tileAt(nx, ny).hypha);

  function pathResourceCost(path) {
    const c = { sugar: 0, water: 0, mineral: 0 };
    for (const p of path) { const t = tileAt(p.x, p.y); if (t.hypha) continue; const rc = resourceCost(t); c.sugar += rc.sugar; c.water += rc.water; c.mineral += rc.mineral; }
    return c;
  }

  // Multi-source Dijkstra from the whole network to (tx,ty). Returns the
  // ordered list of tiles that must be grown (near -> far), or null.
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
    if (t.ash) { t.ash = false; state.res.mineral = Math.min(state.cap, state.res.mineral + C.ashBonus); }
  }

  function growStep(dt) {
    state.growAcc += C.growthRate * dt;
    while (state.growAcc >= 1 && state.queue.length) {
      const p = state.queue[0];
      const t = tileAt(p.x, p.y);
      if (t.hypha || !t.passable) { t.planned = false; state.queue.shift(); continue; }
      if (!adjToNet(p.x, p.y)) { t.planned = false; state.queue.shift(); continue; }
      const c = resourceCost(t);
      if (!canAfford(c)) break;          // wait for resources to accumulate
      pay(c); occupy(t); state.growAcc -= 1; state.queue.shift();
    }
  }

  // BFS from core: set distances, drop any hyphae no longer connected.
  function recomputeNetwork() {
    for (const t of tiles) if (t.hypha) t.dist = -1;
    const q = [core]; const ct = tileAt(core.x, core.y); ct.dist = 0;
    let head = 0, count = 1;
    while (head < q.length) {
      const { x, y } = q[head++]; const d = tileAt(x, y).dist;
      for (const [nx, ny] of neigh(x, y)) if (inB(nx, ny)) { const n = tileAt(nx, ny); if (n.hypha && n.dist < 0) { n.dist = d + 1; q.push({ x: nx, y: ny }); count++; } }
    }
    for (const t of tiles) if (t.hypha && t.dist < 0) { t.hypha = false; } // unreachable -> dies
    state.size = count;
  }

  function dieBack() {
    recomputeNetwork();
    const leaves = tiles.filter(t => t.hypha && t.dist > 0).sort((a, b) => b.dist - a.dist);
    const k = Math.max(1, Math.floor(state.size * C.dieBackFrac));
    for (let i = 0; i < k && i < leaves.length; i++) { leaves[i].hypha = false; }
    recomputeNetwork();
  }

  function retract(x, y) {
    if (!inB(x, y)) return;
    const t = tileAt(x, y);
    if (!t.hypha || (x === core.x && y === core.y)) return;
    t.hypha = false;
    state.res.mineral = Math.min(state.cap, state.res.mineral + C.cost.mineral * t.costMul * 0.25);
    recomputeNetwork();
  }

  function economyStep(dt) {
    // income from tapped nodes
    const gain = { sugar: 0, mineral: 0, water: 0 };
    for (const n of state.nodes) {
      n.tapped = false;
      if (n.reserve <= 0) continue;
      for (const c of n.tiles) {
        if (tileAt(c.x, c.y).hypha || neigh(c.x, c.y).some(([nx, ny]) => inB(nx, ny) && tileAt(nx, ny).hypha)) { n.tapped = true; break; }
      }
      if (!n.tapped) continue;
      const y = Math.min(n.rate * dt, n.reserve);
      n.reserve -= y; gain[n.kind] += y;
      state.res[n.kind] = Math.min(state.cap, state.res[n.kind] + y);
    }
    // upkeep
    const upS = state.size * C.upkeep.sugar * dt;
    const upW = state.size * C.upkeep.water * dt;
    const upM = state.size * C.upkeep.mineral * dt;
    state.res.sugar -= upS; state.res.water -= upW; state.res.mineral -= upM;
    let deficit = false;
    for (const k of ['sugar', 'water', 'mineral']) if (state.res[k] < 0) { state.res[k] = 0; deficit = true; }
    // net income rates for the HUD
    state.income.sugar = gain.sugar / dt - state.size * C.upkeep.sugar;
    state.income.water = gain.water / dt - state.size * C.upkeep.water;
    state.income.mineral = gain.mineral / dt - state.size * C.upkeep.mineral;
    // starvation
    if (deficit) {
      state.starving = true; state.starveTimer += dt;
      if (state.starveTimer >= C.starveInterval) { state.starveTimer -= C.starveInterval; dieBack(); }
      if (state.size <= 1) { state.coreStarveTimer += dt; if (state.coreStarveTimer >= C.coreGrace) gameOver('starved'); }
    } else {
      state.starving = false; state.starveTimer = 0; state.coreStarveTimer = Math.max(0, state.coreStarveTimer - dt);
    }
  }

  function gameOver(cause) {
    if (state.over) return;
    state.over = true;
    state.result = { peak: state.peak, time: state.time, seed, cause, size: state.size };
  }

  // ---- wildfire ----
  function burnColumn(x) {
    if (x < 0 || x >= W) return;
    const top = state.groundY[x];
    const depth = state.fire.depth;
    state.fx.push({ x, y: top - 1, t: 0.6, max: 0.6 });
    for (let y = top; y <= top + depth && y < H; y++) {
      const t = tileAt(x, y);
      t.planned = false;
      if (t.hypha) t.hypha = false;
      if (t.passable && !t.node && (t.layer === 'surface' || t.layer === 'topsoil')) t.ash = true;
      state.fx.push({ x, y, t: 0.7, max: 0.7 });
    }
  }
  function fireStep(dt) {
    const F = state.fire, fc = C.fire;
    // decay flame fx
    for (let i = state.fx.length - 1; i >= 0; i--) { state.fx[i].t -= dt; if (state.fx[i].t <= 0) state.fx.splice(i, 1); }

    if (F.state === 'idle') {
      if (state.time >= F.nextAt - fc.warn) { F.state = 'warning'; F.warnLeft = fc.warn; }
    } else if (F.state === 'warning') {
      F.warnLeft = Math.max(0, F.nextAt - state.time);
      if (state.time >= F.nextAt) {
        F.state = 'active'; F.sweepX = 0; F.sweepSpeed = W / fc.sweepDur;
        F.depth = fc.baseDepth + F.count * fc.depthPerFire;
      }
    } else if (F.state === 'active') {
      const prev = Math.floor(F.sweepX);
      F.sweepX += F.sweepSpeed * dt;
      const now = Math.min(W, Math.floor(F.sweepX));
      for (let x = prev; x < now; x++) burnColumn(x);
      if (F.sweepX >= W) {
        F.state = 'idle'; F.count++;
        F.nextAt = state.time + Math.max(fc.minInterval, fc.interval - F.count * fc.accel);
        recomputeNetwork();
        if (!tileAt(core.x, core.y).hypha) gameOver('burned');
      }
    }
  }

  function tick(dt) {
    if (state.over) return;
    state.time += dt;
    growStep(dt);
    economyStep(dt);
    fireStep(dt);
  }

  return { state, tick, growToward, retract, pathTo, pathResourceCost, resourceCost, tileAt, CONFIG: C };
}
