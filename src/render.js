// render.js — draws sim state to a canvas. Read-only view of the sim.
// Fog of war, organic-matter nodes (by richness), tree roots (hub/distant), buried
// logs, and two-way resource flow (nitrogen inward to trees, sugar outward to the front).

export const TILE = 15;

const PAL = {
  skyTop: '#161d33', skyBot: '#39324d',
  surface: '#6b4a2f', topsoil: '#553a26', subsoil: '#412c1c', rock: '#393645',
  boulder: '#2a2833',
  fog: '#0c0d12', fogEdge: '#13141c',
  hypha: '#eafff1', glow: 'rgba(150,255,205,0.10)', core: '#c4ffdd',
  nitro: '#7fde7a', sugar: '#f5c84a',
  node: '#3a5a2e', nodeBright: '#9be86a', nodeDeep: '#48506a',
  root: '#7a5a38', rootLive: '#f5c84a',
  log: '#6b4a26', logGrain: '#8a5e30',
  ghost: 'rgba(170,255,215,0.20)',
  trunk: '#4a3320', leaf: '#3f7d4a', leafDk: '#2f5d38',
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
    if (dt <= 0 || particles.length > 90) return;
    // nitrogen: spawn at actively-extracting node contact tiles, flow inward.
    for (const n of st.nodes) {
      if (n.rate <= 0.05) continue;
      if (Math.random() < Math.min(0.9, n.rate * 0.25) * dt * 30 / 30) {
        const c = n.tiles[(Math.random() * n.tiles.length) | 0];
        // find a hypha contact tile to start from
        let start = tileAt(c.x, c.y);
        if (!start || !start.hypha) {
          for (const [nx, ny] of [[c.x + 1, c.y], [c.x - 1, c.y], [c.x, c.y + 1], [c.x, c.y - 1]]) {
            const t = tileAt(nx, ny); if (t && t.hypha) { start = t; break; }
          }
        }
        if (start && start.hypha) particles.push({ kind: 'nitro', x: start.x, y: start.y, dir: -1, prog: 0, life: 6 });
      }
    }
    // sugar: spawn at connected tree roots, flow outward to the front.
    for (const tr of st.trees) {
      if (!tr.connected || tr.sugarOut <= 0.05) continue;
      if (Math.random() < Math.min(0.9, tr.sugarOut * 0.18) * dt) {
        const r = tr.roots[(Math.random() * tr.roots.length) | 0];
        let start = tileAt(r.x, r.y);
        if (start && start.hypha) particles.push({ kind: 'sugar', x: r.x, y: r.y, dir: 1, prog: 0, life: 6 });
        else particles.push({ kind: 'sugar', x: st.core.x, y: st.core.y, dir: 1, prog: 0, life: 6 });
      }
    }
  }

  function stepParticles(dt) {
    const speed = 9; // tiles/sec
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
    for (const p of particles) {
      const fromX = p.px != null ? p.px : p.x, fromY = p.py != null ? p.py : p.y;
      const px = mx(fromX) + (mx(p.x) - mx(fromX)) * p.prog;
      const py = my(fromY) + (my(p.y) - my(fromY)) * p.prog;
      ctx.fillStyle = p.kind === 'nitro' ? PAL.nitro : PAL.sugar;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(px, py, 2.4, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, lh);
    g.addColorStop(0, PAL.skyTop); g.addColorStop(1, PAL.skyBot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, lw, lh);
  }

  function drawSoil() {
    const st = sim.state;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = st.tiles[y * W + x];
      if (t.layer === 'air') continue;
      if (!t.revealed) {
        // undiscovered soil — dark fog with faint texture
        ctx.fillStyle = noise(x, y) > 0.55 ? PAL.fogEdge : PAL.fog;
        ctx.fillRect(cx(x), cy(y), TILE, TILE);
        continue;
      }
      if (t.boulder) {
        ctx.fillStyle = PAL.boulder; ctx.fillRect(cx(x), cy(y), TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(cx(x) + 2, cy(y) + 2, 3, 3);
        continue;
      }
      const base = LAYER_RGB[t.layer];
      ctx.fillStyle = shade(base, noise(x, y) * 7);
      ctx.fillRect(cx(x), cy(y), TILE, TILE);
    }
  }

  // Subtle discoloration where a node sits just beyond the reveal radius — a hint.
  function drawHints() {
    const st = sim.state;
    const pulse = 0.5 + 0.5 * Math.sin(st.time * 2);
    for (const n of st.nodes) {
      if (!n.hinted || n.revealed) continue;
      for (const c of n.tiles) {
        const t = st.tiles[c.y * W + c.x];
        if (t.revealed) continue; // hint only shows on still-dark soil
        ctx.fillStyle = `rgba(120,150,90,${0.05 + 0.06 * pulse})`;
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
        // organic clump
        ctx.fillStyle = dead ? '#3a352c' : (locked ? PAL.nodeDeep : PAL.node);
        ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
        ctx.fillStyle = dead ? '#2c281f' : 'rgba(0,0,0,0.25)';
        if (noise(c.x, c.y) > 0) ctx.fillRect(px + 3, py + 5, 4, 3);
      }
      // nutrient glow — brighter & larger with richness, pulses while extracting
      if (!dead && !locked) {
        const center = n.tiles[(n.tiles.length / 2) | 0];
        const gx = mx(center.x), gy = my(center.y);
        const pulse = active ? (0.6 + 0.4 * Math.sin(st.time * 6)) : 0.5;
        const rad = TILE * (0.6 + 0.9 * rich) * (0.85 + 0.25 * pulse) * (0.4 + 0.6 * frac);
        const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, rad);
        g.addColorStop(0, `rgba(155,232,106,${(0.30 + 0.4 * rich) * (active ? 1 : 0.7)})`);
        g.addColorStop(1, 'rgba(155,232,106,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, rad, 0, 7); ctx.fill();
      }
      if (locked) { // padlock-ish marker: deep reserve awaiting FORAGING T3
        const center = n.tiles[(n.tiles.length / 2) | 0];
        ctx.fillStyle = 'rgba(180,190,220,0.5)';
        ctx.fillRect(mx(center.x) - 2, my(center.y) - 2, 4, 4);
      }
    }
  }

  function drawRoots() {
    const st = sim.state;
    for (const tr of st.trees) {
      for (const r of tr.roots) {
        const t = st.tiles[r.y * W + r.x];
        if (!t.revealed) continue;
        const px = cx(r.x), py = cy(r.y);
        ctx.fillStyle = PAL.root; ctx.fillRect(px + 5, py, TILE - 10, TILE);
        ctx.fillStyle = '#5e4429'; ctx.fillRect(px + 6, py, 2, TILE);
        if (tr.connected) { // gold exchange glow at a live interface
          const gx = mx(r.x), gy = my(r.y);
          const pulse = 0.5 + 0.5 * Math.sin(st.time * 5 + r.x);
          const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, TILE * 0.9);
          g.addColorStop(0, `rgba(245,200,74,${0.22 + 0.18 * pulse})`);
          g.addColorStop(1, 'rgba(245,200,74,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, TILE * 0.9, 0, 7); ctx.fill();
        }
      }
    }
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

  function drawTrees() {
    const st = sim.state;
    for (const tr of st.trees) {
      const bx = mx(tr.x), by = cy(tr.y);
      const scale = tr.hub ? 1.25 : 1;
      ctx.fillStyle = PAL.trunk; ctx.fillRect(bx - 2 * scale, by - TILE * 2 * scale, 4 * scale, TILE * 2 * scale);
      for (let i = -3; i <= 3; i++) for (let j = -4; j <= 0; j++) {
        if (i * i + (j + 2) * (j + 2) > 11) continue;
        ctx.fillStyle = noise(tr.x + i, tr.y + j) > 0.2 ? PAL.leafDk : PAL.leaf;
        ctx.fillRect(bx + i * TILE * 0.6 * scale - TILE * 0.3, by - TILE * 2 * scale + j * TILE * 0.7, TILE * 0.7 * scale, TILE * 0.7 * scale);
      }
      if (tr.connected) { // a fed tree glows gold
        const g = ctx.createRadialGradient(bx, by - TILE * 2, 2, bx, by - TILE * 2, TILE * 3);
        g.addColorStop(0, 'rgba(245,200,74,0.10)'); g.addColorStop(1, 'rgba(245,200,74,0)');
        ctx.fillStyle = g; ctx.fillRect(bx - TILE * 3, by - TILE * 5, TILE * 6, TILE * 5);
      }
    }
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
      if (f.kind !== 'burst') continue;
      const a = f.t / f.max;
      const r = TILE * (1.2 - a) * 1.1;
      const g = ctx.createRadialGradient(mx(f.x), my(f.y), 1, mx(f.x), my(f.y), r + 1);
      g.addColorStop(0, `rgba(180,255,210,${0.5 * a})`); g.addColorStop(1, 'rgba(180,255,210,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(mx(f.x), my(f.y), r + 1, 0, 7); ctx.fill();
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
    drawSoil();
    drawHints();
    drawLogs();
    drawNodes();
    drawRoots();
    drawTrees();
    drawPlanned();
    drawHyphae();
    drawParticles();
    drawBursts();
    drawHover(ui);
  }

  return { draw, TILE };
}
