// input.js — maps pointer events to sim commands; maintains hover preview state.
// `ctx.sim` is read live so it survives new runs. `ui` is shared with the renderer/HUD.

export function attachInput(canvas, ctx, ui) {
  let leftDown = false, rightDown = false, lastKey = '';

  function tileFromEvent(e) {
    const sim = ctx.sim, r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * sim.state.W);
    const y = Math.floor((e.clientY - r.top) / r.height * sim.state.H);
    if (x < 0 || y < 0 || x >= sim.state.W || y >= sim.state.H) return null;
    return { x, y };
  }

  function refreshHover(t) {
    const sim = ctx.sim;
    if (!t) { ui.hoverTile = null; ui.hoverPath = null; ui.hoverCost = null; ui.reachable = false; lastKey = ''; return; }
    const key = t.x + ',' + t.y;
    if (key === lastKey) return;
    lastKey = key;
    ui.hoverTile = t;
    const path = sim.pathTo(t.x, t.y);
    if (!path || !path.length) { ui.hoverPath = null; ui.hoverCost = null; ui.reachable = !!path; return; }
    ui.hoverPath = path; ui.reachable = true;
    const c = sim.pathResourceCost(path);
    ui.hoverCost = { tiles: path.length, sugar: c.sugar, water: c.water, mineral: c.mineral };
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    const t = tileFromEvent(e); if (!t) return;
    if (e.button === 0) { leftDown = true; ctx.sim.growToward(t.x, t.y); }
    else if (e.button === 2) { rightDown = true; ctx.sim.retract(t.x, t.y); refreshHover(t); lastKey = ''; }
  });

  canvas.addEventListener('mousemove', e => {
    const t = tileFromEvent(e);
    refreshHover(t);
    if (!t) return;
    if (leftDown) ctx.sim.growToward(t.x, t.y);
    else if (rightDown) { ctx.sim.retract(t.x, t.y); lastKey = ''; }
  });

  window.addEventListener('mouseup', () => { leftDown = false; rightDown = false; });
  canvas.addEventListener('mouseleave', () => refreshHover(null));
}
