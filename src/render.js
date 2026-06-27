// render.js — draws sim state to a canvas. Read-only view of the sim.

export const TILE = 15;

const PAL = {
  skyTop: '#161d33', skyBot: '#39324d',
  surface: '#6b4a2f', topsoil: '#553a26', subsoil: '#412c1c', rock: '#393645',
  boulder: '#2a2833', ash: '#221f1c',
  sugar: '#e0a93f', mineral: '#bd6b22', water: '#3f82d6',
  hypha: '#eafff1', glow: 'rgba(150,255,205,0.10)', core: '#c4ffdd',
  fireA: '#ff7a29', fireB: '#ffd24a',
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
      if (t.boulder) {
        ctx.fillStyle = PAL.boulder; ctx.fillRect(cx(x), cy(y), TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(cx(x) + 2, cy(y) + 2, 3, 3);
        continue;
      }
      const base = LAYER_RGB[t.layer];
      ctx.fillStyle = shade(base, noise(x, y) * 7);
      ctx.fillRect(cx(x), cy(y), TILE, TILE);
      if (t.ash) { ctx.fillStyle = 'rgba(20,16,14,0.72)'; ctx.fillRect(cx(x), cy(y), TILE, TILE); if (noise(x, y * 3) > 0.6) { ctx.fillStyle = 'rgba(255,110,40,0.5)'; ctx.fillRect(cx(x) + 6, cy(y) + 6, 2, 2); } }
    }
  }

  function drawNodes() {
    const st = sim.state;
    for (const n of st.nodes) {
      const frac = n.reserve / n.maxReserve;
      const dead = n.reserve <= 0;
      for (const c of n.tiles) {
        const px = cx(c.x), py = cy(c.y);
        if (n.kind === 'water') {
          ctx.fillStyle = dead ? 'rgba(80,90,100,0.5)' : `rgba(63,130,214,${0.35 + 0.4 * frac})`;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = dead ? 'rgba(110,120,130,0.4)' : 'rgba(150,200,255,0.5)';
          ctx.fillRect(px, py, TILE, 3);
        } else if (n.kind === 'sugar') {
          ctx.fillStyle = dead ? '#5b5448' : PAL.sugar; ctx.fillRect(px + 4, py, TILE - 8, TILE);
          ctx.fillStyle = dead ? '#6b6354' : '#f6d27a'; ctx.fillRect(px + 6, py, 2, TILE);
        } else { // mineral log
          ctx.fillStyle = dead ? '#544b40' : PAL.mineral; ctx.fillRect(px, py + 2, TILE, TILE - 4);
          ctx.fillStyle = dead ? '#433c33' : '#8a4a16'; ctx.fillRect(px, py + 6, TILE, 2);
        }
        if (n.tapped && !dead) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(px, py, TILE, TILE); }
      }
    }
  }

  function drawTrees() {
    const st = sim.state;
    for (const tr of st.trees) {
      const bx = mx(tr.x), by = cy(tr.y);
      ctx.fillStyle = PAL.trunk; ctx.fillRect(bx - 2, by - TILE * 2, 4, TILE * 2);
      for (let i = -3; i <= 3; i++) for (let j = -4; j <= 0; j++) {
        if (i * i + (j + 2) * (j + 2) > 11) continue;
        ctx.fillStyle = noise(tr.x + i, tr.y + j) > 0.2 ? PAL.leafDk : PAL.leaf;
        ctx.fillRect(bx + i * TILE * 0.6 - TILE * 0.3, by - TILE * 2 + j * TILE * 0.7, TILE * 0.7, TILE * 0.7);
      }
    }
  }

  function drawPlanned() {
    const st = sim.state;
    ctx.fillStyle = PAL.ghost;
    for (const t of st.tiles) if (t.planned) ctx.fillRect(cx(t.x) + 5, cy(t.y) + 5, TILE - 10, TILE - 10);
    // animated flow line along the growth queue — the trail visibly moving out
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
    // tips + nodes
    ctx.fillStyle = PAL.hypha;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (st.tiles[y * W + x].hypha) { ctx.beginPath(); ctx.arc(mx(x), my(y), 2, 0, 7); ctx.fill(); } }
    // core — grows with core level, pulses faster while actively feeding
    const lvl = st.coreLevel || 1;
    const speed = st.growthActive ? 7 : 4;
    const pulse = 0.5 + 0.5 * Math.sin(st.time * speed);
    const base = TILE * (0.5 + 0.13 * (lvl - 1));
    ctx.fillStyle = `rgba(196,255,221,${0.22 + 0.22 * pulse})`; ctx.beginPath(); ctx.arc(mx(st.core.x), my(st.core.y), base * (1.3 + 0.25 * pulse), 0, 7); ctx.fill();
    ctx.fillStyle = PAL.core; ctx.beginPath(); ctx.arc(mx(st.core.x), my(st.core.y), base * 0.62, 0, 7); ctx.fill();
  }

  function drawFire() {
    const st = sim.state, F = st.fire;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const f of st.fx) {
      const a = f.t / f.max;
      const flick = 0.6 + 0.4 * Math.sin(st.time * 30 + f.x * 1.3 + f.y);
      ctx.fillStyle = `rgba(255,${120 + 100 * a | 0},40,${0.5 * a})`;
      const h = TILE * (0.7 + 0.6 * flick) * a;
      ctx.fillRect(cx(f.x) + 2, cy(f.y) + TILE - h, TILE - 4, h);
      ctx.fillStyle = `rgba(255,220,90,${0.5 * a})`;
      ctx.fillRect(cx(f.x) + 5, cy(f.y) + TILE - h * 0.6, TILE - 10, h * 0.6);
    }
    if (F.state === 'active') {
      const sx = F.sweepX * TILE;
      const g = ctx.createLinearGradient(sx - 40, 0, sx + 10, 0);
      g.addColorStop(0, 'rgba(255,120,40,0)'); g.addColorStop(1, 'rgba(255,150,50,0.35)');
      ctx.fillStyle = g; ctx.fillRect(sx - 40, 0, 50, lh);
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
    drawSky();
    drawSoil();
    drawNodes();
    drawTrees();
    drawPlanned();
    drawHyphae();
    drawFire();
    drawHover(ui);
  }

  return { draw, TILE };
}
