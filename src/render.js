// render.js — draws sim state to a canvas. Read-only view of the sim.
// Fog of war, organic-matter nodes (by richness), tree roots (hub/distant), buried
// logs, and two-way resource flow (nitrogen inward to trees, sugar outward to the front).

export const TILE = 15;

const PAL = {
  skyTop: '#1b2647', skyMid: '#2c2f52', skyBot: '#3a3350',
  sun: '#ffe6a8',
  surface: '#6b4a2f', topsoil: '#553a26', subsoil: '#412c1c', rock: '#393645',
  boulder: '#2a2833',
  fog: '#0a0b10', fogEdge: '#12131c',
  hypha: '#eafff1', glow: 'rgba(150,255,205,0.10)', core: '#c4ffdd',
  nitro: '#6ee86e', sugar: '#ffd23f',           // green nitrogen · yellow sugar
  node: '#3a5a2e', nodeBright: '#9be86a', nodeDeep: '#4f5c8c',
  root: '#7a5a38', rootLive: '#ffd23f',
  log: '#6b4a26', logGrain: '#8a5e30',
  ghost: 'rgba(170,255,215,0.20)',
  bark: '#4a3320', barkLt: '#6a4c2e', barkDk: '#2c1d10',
  leaf: '#3f7d4a', leafDk: '#274d30', leafLt: '#6fb56a', leafHi: '#9fd98a',
};

function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function shade(rgb, amt) { return `rgb(${Math.max(0, Math.min(255, rgb[0] + amt)) | 0},${Math.max(0, Math.min(255, rgb[1] + amt)) | 0},${Math.max(0, Math.min(255, rgb[2] + amt)) | 0})`; }
function noise(x, y) { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h / 4294967296) * 2 - 1; }

const LAYER_RGB = { surface: hexRgb(PAL.surface), topsoil: hexRgb(PAL.topsoil), subsoil: hexRgb(PAL.subsoil), rock: hexRgb(PAL.rock) };

export function createRenderer(canvas, sim) {
  const W = sim.state.W, H = sim.state.H;
  const lw = W * TILE, lh = H * TILE;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = lw * dpr; canvas.height = lh * dpr;
  canvas.style.width = lw + 'px'; canvas.style.height = 'auto'; canvas.style.maxWidth = '100%';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  const cx = x => x * TILE, cy = y => y * TILE;     // tile -> px (top-left)
  const mx = x => x * TILE + TILE / 2, my = y => y * TILE + TILE / 2; // center

  // ---- resource-flow particles (cosmetic; walk the BFS dist gradient) ----
  // Nitrogen flows DOWN the gradient (outer -> core/hub roots); sugar flows UP the
  // gradient (core/hub -> the growth front). Frozen while paused (time doesn't advance).
  let particles = [];
  let lastT = sim.state.time;

  const tileAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H) ? sim.state.tiles[y * W + x] : null;
  function gradientNeighbor(x, y, dir) {
    // dir -1: toward smaller dist (inward), +1: toward larger dist (outward)
    const t = tileAt(x, y); if (!t) return null;
    const opts = [];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const n = tileAt(nx, ny);
      if (n && n.hypha && ((dir < 0 && n.dist < t.dist) || (dir > 0 && n.dist > t.dist))) opts.push(n);
    }
    if (!opts.length) return null;
    return opts[(Math.random() * opts.length) | 0];
  }

  function spawnParticles(dt) {
    const st = sim.state;
    if (dt <= 0 || particles.length > 220) return;
    // GREEN nitrogen: born at actively-extracting nodes, flows back toward the tree roots.
    for (const n of st.nodes) {
      if (n.rate <= 0.05) continue;
      const p = Math.min(1, n.rate * 0.7) * dt * 6;       // denser stream the harder it gushes
      if (Math.random() < p) {
        const c = n.tiles[(Math.random() * n.tiles.length) | 0];
        let start = tileAt(c.x, c.y);
        if (!start || !start.hypha) {
          for (const [nx, ny] of [[c.x + 1, c.y], [c.x - 1, c.y], [c.x, c.y + 1], [c.x, c.y - 1]]) {
            const t = tileAt(nx, ny); if (t && t.hypha) { start = t; break; }
          }
        }
        if (start && start.hypha) particles.push({ kind: 'nitro', x: start.x, y: start.y, dir: -1, prog: 0, life: 7 });
      }
    }
    // YELLOW sugar: born at connected tree roots, flows out into the mycelium.
    for (const tr of st.trees) {
      if (!tr.connected || tr.sugarOut <= 0.05) continue;
      const p = Math.min(1, tr.sugarOut * 0.6) * dt * 6;
      if (Math.random() < p) {
        const r = tr.roots[(Math.random() * tr.roots.length) | 0];
        const start = tileAt(r.x, r.y);
        if (start && start.hypha) particles.push({ kind: 'sugar', x: r.x, y: r.y, dir: 1, prog: 0, life: 7 });
        else particles.push({ kind: 'sugar', x: st.core.x, y: st.core.y, dir: 1, prog: 0, life: 7 });
      }
    }
  }

  function stepParticles(dt) {
    const speed = 8; // tiles/sec
    for (const p of particles) {
      p.life -= dt;
      p.prog += speed * dt;
      while (p.prog >= 1) {
        p.prog -= 1;
        const nxt = gradientNeighbor(p.x, p.y, p.dir);
        if (!nxt) { p.life = 0; break; }
        p.px = p.x; p.py = p.y; p.x = nxt.x; p.y = nxt.y;
      }
    }
    particles = particles.filter(p => p.life > 0 && tileAt(p.x, p.y) && tileAt(p.x, p.y).hypha);
  }

  function drawParticles() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const fromX = p.px != null ? p.px : p.x, fromY = p.py != null ? p.py : p.y;
      const px = mx(fromX) + (mx(p.x) - mx(fromX)) * p.prog;
      const py = my(fromY) + (my(p.y) - my(fromY)) * p.prog;
      const col = p.kind === 'nitro' ? PAL.nitro : PAL.sugar;
      const fade = Math.min(1, p.life / 1.2);
      const g = ctx.createRadialGradient(px, py, 0, px, py, 8);
      g.addColorStop(0, col); g.addColorStop(0.5, col + '55'); g.addColorStop(1, col + '00');
      ctx.globalAlpha = 0.55 * fade; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, 8, 0, 7); ctx.fill();
      ctx.globalAlpha = fade; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(px, py, 1.7, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, 3.1, 0, 7); ctx.fill();
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- ambient spore motes (cosmetic; drift slowly for a sense of living air) ----
  let motes = null;
  function ensureMotes() {
    if (motes) return;
    motes = [];
    for (let i = 0; i < 34; i++) motes.push({ x: Math.random() * lw, y: Math.random() * lh, vx: (Math.random() - 0.5) * 4, vy: -3 - Math.random() * 5, r: 0.6 + Math.random() * 1.3, ph: Math.random() * 7 });
  }
  function drawMotes(dt) {
    ensureMotes();
    const st = sim.state;
    ctx.save();
    for (const m of motes) {
      m.x += (m.vx + Math.sin(st.time * 0.7 + m.ph) * 3) * dt;
      m.y += m.vy * dt;
      if (m.y < -4) { m.y = lh + 4; m.x = Math.random() * lw; }
      if (m.x < -4) m.x = lw + 4; else if (m.x > lw + 4) m.x = -4;
      const tx = (m.x / TILE) | 0, ty = (m.y / TILE) | 0;
      const t = tileAt(tx, ty);
      const lit = !t || t.layer === 'air' || t.revealed;   // hide inside undiscovered soil
      if (!lit) continue;
      const tw = 0.35 + 0.35 * Math.sin(st.time * 1.5 + m.ph);
      ctx.globalAlpha = 0.18 + 0.22 * tw;
      ctx.fillStyle = '#dfe6d8';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 7); ctx.fill();
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, lh);
    g.addColorStop(0, PAL.skyTop); g.addColorStop(0.55, PAL.skyMid); g.addColorStop(1, PAL.skyBot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, lw, lh);
    // warm sun glow filtering through the canopy, centered over the trunk
    const st = sim.state, sx = mx(st.trunkX), sy = lh * 0.12;
    const sun = ctx.createRadialGradient(sx, sy, 4, sx, sy, lw * 0.5);
    sun.addColorStop(0, 'rgba(255,230,168,0.28)'); sun.addColorStop(0.5, 'rgba(255,220,150,0.07)');
    sun.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, lw, lh * 0.5);
  }

  function drawSoil() {
    const st = sim.state;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = st.tiles[y * W + x];
      if (t.layer === 'air') continue;
      if (!t.revealed) {
        // undiscovered soil — dark fog with faint texture, warming very slightly with depth
        const n = noise(x, y);
        ctx.fillStyle = n > 0.55 ? PAL.fogEdge : PAL.fog;
        ctx.fillRect(cx(x), cy(y), TILE, TILE);
        continue;
      }
      if (t.boulder) {
        ctx.fillStyle = PAL.boulder; ctx.fillRect(cx(x), cy(y), TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(cx(x) + 2, cy(y) + 2, 3, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(cx(x) + TILE - 5, cy(y) + TILE - 5, 3, 3);
        continue;
      }
      // depth-graded base: deeper soil reads darker & cooler so the strata separate
      const depth = (y - st.AIR_ROWS) / (H - st.AIR_ROWS);
      const base = LAYER_RGB[t.layer];
      ctx.fillStyle = shade(base, noise(x, y) * 8 - depth * 14);
      ctx.fillRect(cx(x), cy(y), TILE, TILE);
      // scattered grain / pebbles for grit
      const n2 = noise(x * 3 + 11, y * 3 + 7);
      if (n2 > 0.7) { ctx.fillStyle = shade(base, 16); ctx.fillRect(cx(x) + 4, cy(y) + 6, 2, 2); }
      else if (n2 < -0.78) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(cx(x) + 8, cy(y) + 4, 3, 2); }
    }
    // soft edge glow where excavated (revealed) soil meets the dark unknown
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = st.tiles[y * W + x];
      if (t.layer === 'air' || t.revealed) continue;
      let nearLit = false;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const nt = tileAt(nx, ny); if (nt && nt.revealed && nt.layer !== 'air') { nearLit = true; break; }
      }
      if (nearLit) { ctx.fillStyle = 'rgba(120,110,90,0.10)'; ctx.fillRect(cx(x), cy(y), TILE, TILE); }
    }
  }

  // Subtle discoloration where a node sits just beyond the reveal radius — a hint.
  function drawHints() {
    const st = sim.state;
    const pulse = 0.5 + 0.5 * Math.sin(st.time * 2);
    for (const n of st.nodes) {
      if (!n.hinted || n.revealed) continue;
      const deep = n.deep && st.upg.foraging < 3;   // cool tint = wealth you can't touch YET
      for (const c of n.tiles) {
        const t = st.tiles[c.y * W + c.x];
        if (t.revealed) continue; // hint only shows on still-dark soil
        ctx.fillStyle = deep ? `rgba(115,130,210,${0.05 + 0.06 * pulse})`
                             : `rgba(120,150,90,${0.05 + 0.06 * pulse})`;
        ctx.fillRect(cx(c.x), cy(c.y), TILE, TILE);
      }
    }
  }

  function drawNodes() {
    const st = sim.state;
    for (const n of st.nodes) {
      if (!n.revealed) continue;
      const frac = n.reserve / n.maxReserve;
      const dead = n.reserve <= 0;
      const locked = n.deep && st.upg.foraging < 3;
      const rich = Math.min(1, n.maxReserve / 340);   // richness 0..1 (gusher = 1)
      const active = n.rate > 0.05;
      for (const c of n.tiles) {
        const px = cx(c.x), py = cy(c.y);
        if (dead) {
          // mined dry — a sunken, rotted husk collapsing back into the soil
          ctx.fillStyle = '#241f18'; ctx.fillRect(px + 2, py + 3, TILE - 4, TILE - 5);
          ctx.fillStyle = '#332e25';
          if (noise(c.x, c.y) > -0.2) ctx.fillRect(px + 4, py + 5, 3, 2);
          ctx.fillRect(px + TILE - 6, py + TILE - 6, 2, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(px + 2, py + 3, TILE - 4, 2); // sunken lip
          continue;
        }
        // organic clump
        ctx.fillStyle = locked ? PAL.nodeDeep : PAL.node;
        ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        if (noise(c.x, c.y) > 0) ctx.fillRect(px + 3, py + 5, 4, 3);
        if (locked && noise(c.x + 7, c.y) > 0.1) {  // mineral flecks — buried treasure, not rock
          ctx.fillStyle = 'rgba(160,180,240,0.35)'; ctx.fillRect(px + 8, py + 4, 2, 2);
        }
      }
      // nutrient glow — brighter & larger with richness, pulses while extracting
      if (!dead && !locked) {
        const center = n.tiles[(n.tiles.length / 2) | 0];
        const gx = mx(center.x), gy = my(center.y);
        const lode = n.tier === 'motherlode';
        const pulse = active ? (0.6 + 0.4 * Math.sin(st.time * 6)) : 0.5;
        const rad = TILE * (0.6 + 0.9 * rich) * (lode ? 1.35 : 1) * (0.85 + 0.25 * pulse) * (0.4 + 0.6 * frac);
        const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, rad);
        if (lode) g.addColorStop(0, `rgba(220,255,180,${(0.5) * (active ? 1 : 0.75)})`); // white-hot heart
        g.addColorStop(lode ? 0.35 : 0, `rgba(155,232,106,${(0.30 + 0.4 * rich) * (active ? 1 : 0.7)})`);
        g.addColorStop(1, 'rgba(155,232,106,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, rad, 0, 7); ctx.fill();
      }
      if (locked) { // deep reserve awaiting FORAGING T3 — shimmer like treasure, lock like a door
        const center = n.tiles[(n.tiles.length / 2) | 0];
        const gx = mx(center.x), gy = my(center.y);
        const pulse = 0.5 + 0.5 * Math.sin(st.time * 1.6 + n.id * 2.1);   // slow heartbeat
        const rad = TILE * (0.8 + 1.1 * rich) * (0.8 + 0.3 * pulse);
        const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, rad);
        g.addColorStop(0, `rgba(130,150,230,${0.12 + 0.16 * rich * pulse})`);
        g.addColorStop(1, 'rgba(130,150,230,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, rad, 0, 7); ctx.fill();
        // padlock glyph: shackle + body + keyhole
        ctx.strokeStyle = 'rgba(205,215,245,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(gx, gy - 2, 3, Math.PI, 0); ctx.stroke();
        ctx.fillStyle = 'rgba(205,215,245,0.9)'; ctx.fillRect(gx - 4, gy - 2, 8, 7);
        ctx.fillStyle = '#2c3050'; ctx.fillRect(gx - 1, gy, 2, 3);
      }
    }
  }

  // Slender feeder roots descending from the great tree into the play area — the
  // tappable exchange interfaces (hub + secondary). Faintly visible through fog; the
  // interface glows gold once your network reaches it and sugar starts flowing.
  function drawRoots() {
    const st = sim.state;
    for (const tr of st.trees) {
      if (!tr.roots.length) continue;
      const sx = mx(tr.x), sTop = cy(st.groundY[tr.x]);
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = tr.connected ? 'rgba(255,210,63,0.55)' : 'rgba(122,90,56,0.5)';
      ctx.lineWidth = tr.hub ? TILE * 0.5 : TILE * 0.34;
      ctx.beginPath(); ctx.moveTo(sx, sTop - TILE * 0.4);
      for (const r of tr.roots) ctx.lineTo(mx(r.x), my(r.y));
      ctx.stroke(); ctx.restore();

      for (const r of tr.roots) {
        const t = st.tiles[r.y * W + r.x];
        const px = cx(r.x), py = cy(r.y), gx = mx(r.x), gy = my(r.y);
        if (t.revealed) {
          ctx.fillStyle = PAL.root; ctx.fillRect(px + 4, py, TILE - 8, TILE);
          ctx.fillStyle = '#5e4429'; ctx.fillRect(px + 6, py, 2, TILE);
        }
        if (tr.connected) { // gold exchange glow at a live interface
          const pulse = 0.5 + 0.5 * Math.sin(st.time * 5 + r.x);
          const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, TILE * 1.1);
          g.addColorStop(0, `rgba(255,210,63,${0.26 + 0.2 * pulse})`);
          g.addColorStop(1, 'rgba(255,210,63,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, TILE * 1.1, 0, 7); ctx.fill();
        }
      }
      // Live effective exchange rate at this interface — the routing feedback. Brighter =
      // better rate right now; it drops as you mine far from this root.
      if (tr.connected && tr.exchange != null) {
        const tip = tr.roots[tr.roots.length - 1];
        const lx = mx(tip.x), ly = my(tip.y) + TILE * 0.9;
        const best = tr.exchange >= (st.exchangeRate - 0.01);
        ctx.font = '700 10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = tr.exchange.toFixed(1) + '×';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,8,12,0.85)'; ctx.strokeText(label, lx, ly);
        ctx.fillStyle = best ? '#ffe06a' : 'rgba(210,180,120,0.85)'; ctx.fillText(label, lx, ly);
      }
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  function drawLogs() {
    const st = sim.state;
    for (const log of st.logs) {
      if (log.consumed) continue;
      for (const c of log.tiles) {
        const t = st.tiles[c.y * W + c.x];
        if (!t.revealed) continue;
        const px = cx(c.x), py = cy(c.y);
        ctx.fillStyle = PAL.log; ctx.fillRect(px, py + 2, TILE, TILE - 4);
        ctx.fillStyle = PAL.logGrain; ctx.fillRect(px, py + 5, TILE, 1); ctx.fillRect(px, py + 9, TILE, 1);
      }
    }
  }

  // The whole map sits beneath ONE great tree: a canopy filling the sky and a thick
  // trunk planted over the core.
  function drawCanopy() {
    const st = sim.state;
    const tX = mx(st.trunkX);
    const baseY = cy(st.groundY[st.trunkX]);
    let minG = lh; for (let x = 0; x < W; x++) minG = Math.min(minG, cy(st.groundY[x]));
    const bottom = minG - 4, cyc = bottom * 0.22, ryc = bottom - cyc, rxc = lw * 0.6;
    const sway = Math.sin(st.time * 0.6) * 3;   // gentle breeze

    // soft god-rays spilling out of the canopy into the sky band above the soil
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const rx = tX + (i - 1.5) * lw * 0.2 + sway;
      const spread = i - 1.5, footY = bottom + TILE * 4;
      const g = ctx.createLinearGradient(rx, cyc, rx + spread * 30, footY);
      g.addColorStop(0, 'rgba(255,231,170,0.07)'); g.addColorStop(1, 'rgba(255,231,170,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(rx - 3, cyc); ctx.lineTo(rx + 3, cyc);
      ctx.lineTo(rx + spread * 30 + 70, footY);
      ctx.lineTo(rx + spread * 30 - 70, footY);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // trunk (behind the canopy) — thick, tapering, planted into the ground
    const topW = TILE * 1.2, botW = TILE * 2.6;
    ctx.fillStyle = PAL.bark;
    ctx.beginPath();
    ctx.moveTo(tX - topW / 2, 0); ctx.lineTo(tX + topW / 2, 0);
    ctx.lineTo(tX + botW / 2, baseY); ctx.lineTo(tX - botW / 2, baseY);
    ctx.closePath(); ctx.fill();
    // bark striations + a sunlit edge
    ctx.strokeStyle = PAL.barkDk; ctx.lineWidth = 1;
    for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(tX + k * 5, 0); ctx.lineTo(tX + k * 8, baseY); ctx.stroke(); }
    ctx.fillStyle = PAL.barkLt; ctx.fillRect(tX - topW / 2 + 1, 0, 3, baseY);

    // canopy mass — layered lumpy crown with a vertical light gradient (lit top, shaded belly)
    const grad = ctx.createLinearGradient(0, cyc - ryc, 0, bottom);
    grad.addColorStop(0, PAL.leafLt); grad.addColorStop(0.5, PAL.leaf); grad.addColorStop(1, PAL.leafDk);
    ctx.fillStyle = PAL.leafDk; ctx.beginPath(); ctx.ellipse(tX + sway, cyc, rxc, ryc, 0, 0, 7); ctx.fill();
    ctx.fillStyle = grad; ctx.beginPath(); ctx.ellipse(tX + sway, cyc - TILE * 0.4, rxc * 0.92, ryc * 0.88, 0, 0, 7); ctx.fill();
    // rolling foliage — big overlapping crown lobes across the top, each softly shaded
    // (lit dome, shadowed belly) so the canopy reads as a mass of leaves seen from below.
    const N = 26;
    for (let i = 0; i < N; i++) {
      const a = (i / (N - 1)) * Math.PI - Math.PI;            // sweep the upper arc
      const bx = tX + sway + Math.cos(a) * rxc * 0.9;
      const by = cyc + Math.sin(a) * ryc * 0.78;
      const rr = TILE * (2.3 + 2.0 * (0.5 + 0.5 * noise(i * 7, 3)));
      const lg = ctx.createRadialGradient(bx, by - rr * 0.4, rr * 0.1, bx, by, rr);
      const hi = i % 4 === 0 ? PAL.leafHi : PAL.leafLt;
      lg.addColorStop(0, hi); lg.addColorStop(0.6, PAL.leaf); lg.addColorStop(1, PAL.leafDk);
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(bx, by, rr, 0, 7); ctx.fill();
    }
    // dappled leaf speckle for texture
    const inDome = (x, y) => { const dx = (x - tX - sway) / rxc, dy = (y - cyc) / ryc; return dx * dx + dy * dy < 0.94; };
    for (let y = -TILE; y < bottom; y += TILE * 0.95) for (let x = tX - rxc; x < tX + rxc; x += TILE * 0.95) {
      if (!inDome(x, y)) continue;
      const n = noise(Math.round(x), Math.round(y));
      const lit = (y - (cyc - ryc)) / (bottom - (cyc - ryc));  // 0 top .. 1 bottom
      ctx.fillStyle = n > 0.5 ? PAL.leafHi : (n > 0.15 ? PAL.leafLt : (n < -0.45 ? PAL.leafDk : PAL.leaf));
      ctx.globalAlpha = 0.5 + 0.5 * (1 - lit);
      ctx.fillRect((x + sway) | 0, y | 0, 5, 5);
    }
    ctx.globalAlpha = 1;
  }

  // Big structural roots arcing from the trunk down the left & right edges — they
  // frame the whole play area (decorative; the tappable roots are drawn by drawRoots).
  // Stroke a polyline whose width tapers from wStart (first point) to wEnd (last).
  function taperStroke(pts, wStart, wEnd, style) {
    ctx.strokeStyle = style; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 0; i < pts.length - 1; i++) {
      const f = i / (pts.length - 1);
      ctx.lineWidth = wStart + (wEnd - wStart) * f;
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
    }
  }
  function cubic(p0, p1, p2, p3, n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
    return out;
  }

  function drawFramingRoots() {
    const st = sim.state;
    const tX = mx(st.trunkX), baseY = cy(st.groundY[st.trunkX]);
    ctx.save();
    for (const side of [-1, 1]) {
      const edgeX = side < 0 ? lw * 0.045 : lw * 0.955;
      const pts = cubic(
        [tX + side * TILE, baseY - TILE * 0.3],
        [tX + side * lw * 0.20, baseY + TILE * 0.6],
        [edgeX, cy(st.AIR_ROWS) + TILE * 2],
        [edgeX, lh * 0.5], 22);
      pts.push([edgeX, lh * 0.98]);
      // thick at the trunk, whittling to a thread at the tip
      taperStroke(pts, TILE * 1.5, TILE * 0.18, 'rgba(58,40,25,0.5)');
      taperStroke(pts, TILE * 0.7, TILE * 0.1, 'rgba(96,69,42,0.4)');
      ctx.strokeStyle = 'rgba(140,105,66,0.22)'; ctx.lineWidth = 1.5;   // sunlit hairline
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts) ctx.lineTo(p[0], p[1]); ctx.stroke();
      // little rootlets peeling inward off the main root
      for (const seg of [0.42, 0.66]) {
        const bi = Math.floor(seg * (pts.length - 1)), base = pts[bi];
        const branch = cubic(base, [base[0] - side * lw * 0.06, base[1] + TILE * 2],
          [base[0] - side * lw * 0.12, base[1] + TILE * 4], [base[0] - side * lw * 0.16, base[1] + TILE * 6], 8);
        taperStroke(branch, TILE * 0.4, TILE * 0.08, 'rgba(74,51,32,0.3)');
      }
    }
    ctx.restore();
  }

  function drawPlanned() {
    const st = sim.state;
    ctx.fillStyle = PAL.ghost;
    for (const t of st.tiles) if (t.planned) ctx.fillRect(cx(t.x) + 5, cy(t.y) + 5, TILE - 10, TILE - 10);
    const q = st.queue;
    if (q.length) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 7]); ctx.lineDashOffset = -(st.time * 60) % 12;
      ctx.strokeStyle = st.bottleneck ? 'rgba(255,170,80,0.95)' : 'rgba(170,255,215,0.9)';
      let sx = mx(q[0].x), sy = my(q[0].y);
      for (const [nx, ny] of [[q[0].x + 1, q[0].y], [q[0].x - 1, q[0].y], [q[0].x, q[0].y + 1], [q[0].x, q[0].y - 1]]) {
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && st.tiles[ny * W + nx].hypha) { sx = mx(nx); sy = my(ny); break; }
      }
      ctx.beginPath(); ctx.moveTo(sx, sy);
      for (const p of q) ctx.lineTo(mx(p.x), my(p.y));
      ctx.stroke();
      const tgt = q[q.length - 1];
      ctx.setLineDash([]); ctx.lineWidth = 1.5; ctx.strokeStyle = st.bottleneck ? '#ffaa50' : '#bfffdc';
      ctx.strokeRect(cx(tgt.x) + 1, cy(tgt.y) + 1, TILE - 2, TILE - 2);
      ctx.restore();
    }
  }

  function drawHyphae() {
    const st = sim.state;
    // die-back warning: when starving, the farthest-out threads dim & flicker.
    let maxDist = 0;
    if (st.starving) for (const t of st.tiles) if (t.hypha && t.dist > maxDist) maxDist = t.dist;
    const flicker = 0.5 + 0.5 * Math.sin(st.time * 14);
    const dimAt = maxDist * 0.55;

    const edges = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = st.tiles[y * W + x];
      if (!t.hypha) continue;
      if (x + 1 < W && st.tiles[y * W + x + 1].hypha) edges.push([x, y, x + 1, y]);
      if (y + 1 < H && st.tiles[(y + 1) * W + x].hypha) edges.push([x, y, x, y + 1]);
    }
    // glow pass
    ctx.lineCap = 'round'; ctx.strokeStyle = PAL.glow; ctx.lineWidth = TILE * 0.5;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of edges) { ctx.moveTo(mx(x1), my(y1)); ctx.lineTo(mx(x2), my(y2)); }
    ctx.stroke();
    // crisp pass
    ctx.strokeStyle = PAL.hypha; ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of edges) { ctx.moveTo(mx(x1), my(y1)); ctx.lineTo(mx(x2), my(y2)); }
    ctx.stroke();
    // tiles + die-back dimming on the threatened fringe
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = st.tiles[y * W + x];
      if (!t.hypha) continue;
      let a = 1;
      if (st.starving && t.dist > dimAt) a = 0.25 + 0.45 * flicker; // threatened fringe flickers
      ctx.fillStyle = `rgba(234,255,241,${a})`;
      ctx.beginPath(); ctx.arc(mx(x), my(y), 2, 0, 7); ctx.fill();
    }
    // core
    const speed = st.growthActive ? 7 : 4;
    const pulse = 0.5 + 0.5 * Math.sin(st.time * speed);
    const base = TILE * 0.5;
    ctx.fillStyle = `rgba(196,255,221,${0.22 + 0.22 * pulse})`; ctx.beginPath(); ctx.arc(mx(st.core.x), my(st.core.y), base * (1.3 + 0.25 * pulse), 0, 7); ctx.fill();
    ctx.fillStyle = PAL.core; ctx.beginPath(); ctx.arc(mx(st.core.x), my(st.core.y), base * 0.62, 0, 7); ctx.fill();
  }

  function drawBursts() {
    const st = sim.state;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const f of st.fx) {
      const a = f.t / f.max;
      if (f.kind === 'burst') {
        const r = TILE * (1.2 - a) * 1.1;
        const g = ctx.createRadialGradient(mx(f.x), my(f.y), 1, mx(f.x), my(f.y), r + 1);
        g.addColorStop(0, `rgba(180,255,210,${0.5 * a})`); g.addColorStop(1, 'rgba(180,255,210,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(mx(f.x), my(f.y), r + 1, 0, 7); ctx.fill();
      } else if (f.kind === 'deplete') {
        // a dull ring sighing outward — this node just gave its last nitrogen
        const r = TILE * (0.4 + (1 - a) * 2.4);
        ctx.strokeStyle = `rgba(150,175,110,${0.55 * a})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx(f.x), my(f.y), r, 0, 7); ctx.stroke();
        ctx.strokeStyle = `rgba(90,100,70,${0.35 * a})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(mx(f.x), my(f.y), r * 0.6, 0, 7); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawHover(ui) {
    if (!ui || !ui.hoverPath || !ui.hoverPath.length) return;
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = ui.reachable ? 'rgba(180,255,220,0.85)' : 'rgba(255,120,120,0.85)';
    ctx.lineWidth = 2; ctx.beginPath();
    const start = ui.hoverPath[0];
    ctx.moveTo(mx(start.x), my(start.y));
    for (const p of ui.hoverPath) ctx.lineTo(mx(p.x), my(p.y));
    ctx.stroke(); ctx.setLineDash([]);
    const tgt = ui.hoverPath[ui.hoverPath.length - 1];
    ctx.strokeStyle = ui.reachable ? '#bfffdc' : '#ff8080'; ctx.lineWidth = 1.5;
    ctx.strokeRect(cx(tgt.x) + 1, cy(tgt.y) + 1, TILE - 2, TILE - 2);
    ctx.restore();
  }

  function draw(ui) {
    const st = sim.state;
    const dt = Math.max(0, Math.min(0.1, st.time - lastT)); lastT = st.time;
    spawnParticles(dt); stepParticles(dt);

    drawSky();
    drawCanopy();         // the great tree's canopy + trunk (behind the soil)
    drawSoil();
    drawFramingRoots();   // big structural roots framing the play area
    drawHints();
    drawLogs();
    drawNodes();
    drawRoots();          // tappable feeder roots descending into the field
    drawPlanned();
    drawHyphae();
    drawParticles();
    drawBursts();
    drawMotes(dt);
    drawHover(ui);
  }

  return { draw, TILE };
}
