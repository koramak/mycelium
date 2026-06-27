// main.js — fixed-timestep loop, pause, HUD wiring, run lifecycle.

import { createSim } from './sim.js';
import { createRenderer } from './render.js';
import { attachInput } from './input.js';

const canvas = document.getElementById('c');
const $ = id => document.getElementById(id);
const ctx = { sim: null };
const ui = { hoverTile: null, hoverPath: null, hoverCost: null, reachable: false, mode: 'grow' };

const STEP = 1 / 30;
let renderer, paused = false, acc = 0, last = performance.now();

const randSeed = () => (Math.random() * 2 ** 31) >>> 0;
function urlSeed() {
  const s = new URLSearchParams(location.search).get('seed');
  return s !== null && s !== '' ? (parseInt(s, 10) >>> 0) : null;
}

function newRun(seed) {
  ctx.sim = createSim(seed);
  renderer = createRenderer(canvas, ctx.sim);
  ui.hoverTile = ui.hoverPath = ui.hoverCost = null; ui.reachable = false;
  paused = false; acc = 0;
  $('overlay').classList.add('hidden');
}

const fmtTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function setRate(el, v) {
  if (v > 0.05) { el.textContent = '▲' + v.toFixed(1); el.style.color = '#7fe0a0'; }
  else if (v < -0.05) { el.textContent = '▼' + v.toFixed(1); el.style.color = '#e08585'; }
  else { el.textContent = '◦'; el.style.color = '#67718a'; }
}

function updateHud() {
  const st = ctx.sim.state;
  $('sugar').textContent = Math.floor(st.res.sugar);
  $('mineral').textContent = Math.floor(st.res.mineral);
  $('water').textContent = Math.floor(st.res.water);
  setRate($('sugarRate'), st.income.sugar);
  setRate($('mineralRate'), st.income.mineral);
  setRate($('waterRate'), st.income.water);
  $('size').textContent = st.size;
  $('peak').textContent = st.peak;
  $('time').textContent = fmtTime(st.time);
  $('seed').textContent = st.seed;

  const F = st.fire, b = $('banner');
  if (F.state === 'warning') { b.textContent = '🔥 WILDFIRE INCOMING — ' + Math.ceil(F.warnLeft) + 's — pull hyphae off the surface!'; b.className = 'warn'; }
  else if (F.state === 'active') { b.textContent = '🔥 WILDFIRE SWEEPING!'; b.className = 'active'; }
  else if (st.starving) { b.textContent = '⚠ STARVING — network dying back'; b.className = 'starve'; }
  else b.className = 'hidden';

  const cur = $('cursor');
  if (ui.hoverCost) { const c = ui.hoverCost; cur.textContent = c.tiles + ' tiles → 🍬' + Math.ceil(c.sugar) + '  💧' + Math.ceil(c.water) + '  ⛰' + Math.ceil(c.mineral); }
  else if (ui.hoverTile && !ui.reachable) cur.textContent = 'unreachable';
  else cur.textContent = '';

  $('btnPause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  const retract = ui.mode === 'retract';
  $('btnMode').textContent = retract ? '✂ Retracting' : '✚ Growing';
  $('btnMode').classList.toggle('retract', retract);
}

function showOverlay(r) {
  const ov = $('overlay'); if (!ov.classList.contains('hidden')) return;
  const cause = r.cause === 'burned' ? 'Your core burned in the wildfire.' : 'Your network starved and collapsed.';
  $('ovBody').innerHTML = cause + '<br><br>Peak network size: <b>' + r.peak + '</b><br>Survived: <b>' + fmtTime(r.time) +
    '</b><br>Seed: <b>' + r.seed + '</b>';
  ov.classList.remove('hidden');
}

function frame(now) {
  let dt = (now - last) / 1000; last = now; if (dt > 0.1) dt = 0.1;
  const st = ctx.sim.state;
  if (!paused && !st.over) { acc += dt; let guard = 0; while (acc >= STEP && guard++ < 8) { ctx.sim.tick(STEP); acc -= STEP; } }
  else acc = 0;
  renderer.draw(ui);
  updateHud();
  if (st.over) showOverlay(st.result);
  $('pauseBadge').classList.toggle('hidden', !paused || st.over);
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); if (!ctx.sim.state.over) paused = !paused; }
  else if (e.key === 'r' || e.key === 'R') newRun(randSeed());
});
$('btnNew').addEventListener('click', () => newRun(randSeed()));
$('btnReplay').addEventListener('click', () => newRun(ctx.sim.state.seed));
$('btnNew2').addEventListener('click', () => newRun(randSeed()));
$('btnPause').addEventListener('click', () => { if (!ctx.sim.state.over) paused = !paused; });
$('btnMode').addEventListener('click', () => { ui.mode = ui.mode === 'grow' ? 'retract' : 'grow'; });

newRun(urlSeed() ?? randSeed());
attachInput(canvas, ctx, ui);
requestAnimationFrame(frame);

// debug handle (harmless; handy for testing in the console)
window.__game = { get sim() { return ctx.sim; }, get paused() { return paused; }, ui };
