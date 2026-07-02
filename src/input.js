// input.js — unified pointer input (mouse + touch). `ctx.sim` is read live so it
// survives new runs. `ui` is shared with the renderer/HUD. Tap/drag = direct growth.

export function attachInput(canvas, ctx, ui) {
  let dragging = false, lastKey = '';

  function tileFromEvent(e) {
    const sim = ctx.sim, r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * sim.state.W);
    const y = Math.floor((e.clientY - r.top) / r.height * sim.state.H);
    if (x < 0 || y < 0 || x >= sim.state.W || y >= sim.state.H) return null;
    return { x, y };
  }

  function apply(t) { if (t) ctx.sim.growToward(t.x, t.y); }

  // Mouse-only hover preview (no hover on touch).
  function refreshHover(t) {
    const sim = ctx.sim;
    ui.hoverFruit = null;
    if (!t) { ui.hoverTile = ui.hoverPath = ui.hoverCost = null; ui.reachable = false; return; }
    ui.hoverTile = t;
    const f = sim.fruitAt(t.x, t.y);
    if (f) { ui.hoverFruit = f; ui.hoverPath = null; ui.hoverCost = null; ui.reachable = true; return; }
    const path = sim.pathTo(t.x, t.y);
    if (!path || !path.length) { ui.hoverPath = null; ui.hoverCost = null; ui.reachable = !!path; return; }
    ui.hoverPath = path; ui.reachable = true;
    const c = sim.pathResourceCost(path);
    ui.hoverCost = { tiles: path.length, sugar: c.sugar, water: c.water };
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    const t = tileFromEvent(e); if (!t) return;
    const f = ctx.sim.fruitAt(t.x, t.y);
    if (f) { ctx.sim.pourSugar(f.id); return; }   // click a mushroom cap = pour sugar into it
    dragging = true; lastKey = t.x + ',' + t.y;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    apply(t);
  });

  canvas.addEventListener('pointermove', e => {
    const t = tileFromEvent(e);
    if (e.pointerType === 'mouse' && !dragging) { const k = t ? t.x + ',' + t.y : ''; if (k !== lastKey) { lastKey = k; refreshHover(t); } return; }
    if (!dragging || !t) return;
    const k = t.x + ',' + t.y;
    if (k !== lastKey) { lastKey = k; apply(t); }
  });

  const end = e => { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { refreshHover(null); lastKey = ''; } });
}
