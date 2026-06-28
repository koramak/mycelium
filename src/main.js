// main.js — fixed-timestep loop, pause, HUD wiring, run lifecycle.

import { createSim } from './sim.js';
import { createRenderer } from './render.js';
import { attachInput } from './input.js';

const canvas = document.getElementById('c');
const $ = id => document.getElementById(id);
const ctx = { sim: null };
const ui = { hoverTile: null, hoverPath: null, hoverCost: null, reachable: false };

const STEP = 1 / 30;
let renderer, paused = false, acc = 0, last = performance.now();

const UPG = {
  foraging: { name: 'Foraging', tiers: [
    { t: 'Faster extraction', d: 'Nitrogen drains +60% faster per contact' },
    { t: 'Wider reveal',      d: 'Fog reveal radius +2 tiles' },
    { t: 'Deep extraction',   d: 'Mine the locked deep-soil reserves' }] },
  mycelium: { name: 'Mycelium', tiers: [
    { t: 'Growth speed',   d: 'Tiles extend +50% faster' },
    { t: 'Thicker trunks', d: 'Faster transport · +50% nitrogen buffer' },
    { t: 'Reduced upkeep', d: 'Every tile costs −40% to maintain' }] },
  symbiosis: { name: 'Symbiosis', tiers: [
    { t: 'Better trade',  d: '+40% sugar returned per nitrogen' },
    { t: 'Faster roots',  d: 'Distant roots ramp up ~2× faster' },
    { t: 'Tree vitality', d: '+60% nitrogen trade capacity' }] },
};

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
  else if (v < -0.05) { el.textContent = '▼' + Math.abs(v).toFixed(1); el.style.color = '#e08585'; }
  else { el.textContent = '◦'; el.style.color = '#67718a'; }
}

function updateUpgrade(track) {
  const st = ctx.sim.state;
  const tier = st.upg[track];
  const cost = ctx.sim.upgradeCost(track);
  const btn = $('btn' + track[0].toUpperCase() + track.slice(1));
  const pips = '●'.repeat(tier) + '○'.repeat(3 - tier);
  const head = `<div class="urow"><b>${UPG[track].name}</b><span class="pips">${pips}</span></div>`;
  if (cost === null) { // all three tiers bought — show what's been achieved
    const last = UPG[track].tiers[2];
    btn.innerHTML = head + `<div class="unext">✓ Fully upgraded</div><div class="udesc">${last.d}</div>`;
    btn.disabled = true; btn.classList.remove('afford'); btn.title = 'All three tiers purchased';
  } else { // show what the NEXT tier does + its price; advances after each purchase
    const nx = UPG[track].tiers[tier];
    btn.innerHTML = head + `<div class="unext">Next: ${nx.t}</div><div class="udesc">${nx.d}</div><div class="ucost">${cost} 🍬</div>`;
    const afford = st.res.sugar >= cost;
    btn.disabled = !afford; btn.classList.toggle('afford', afford);
    btn.title = nx.d;
  }
}

function updateHud() {
  const st = ctx.sim.state;
  $('sugar').textContent = Math.floor(st.res.sugar);
  $('water').textContent = Math.floor(st.res.water);
  $('nitrogen').textContent = Math.floor(st.res.nitrogen);
  setRate($('sugarRate'), st.income.sugar);
  setRate($('waterRate'), st.income.water);
  setRate($('nitrogenRate'), st.income.nitrogen);
  $('exchange').textContent = st.exchangeRate.toFixed(1);
  $('size').textContent = st.size;
  $('peak').textContent = st.peak;
  $('time').textContent = fmtTime(st.time);
  $('seed').textContent = st.seed;

  const b = $('banner');
  if (st.starving) { b.textContent = '⚠ STARVING — network dying back from the edges'; b.className = 'starve'; }
  else b.className = 'hidden';

  const cur = $('cursor');
  if (ui.hoverCost) { const c = ui.hoverCost; cur.textContent = c.tiles + ' tiles → 🍬' + Math.ceil(c.sugar) + '  💧' + Math.ceil(c.water); }
  else if (ui.hoverTile && !ui.reachable) cur.textContent = 'unreachable';
  else cur.textContent = '';

  const status = $('status');
  if (st.bottleneck === 'sugar') { status.textContent = '⚠ Stalled — need 🍬 Sugar (deliver nitrogen to a tree root)'; status.style.color = '#ffb24a'; }
  else if (st.bottleneck === 'water') { status.textContent = '⚠ Stalled — need 💧 Water (grow deeper for wetter soil)'; status.style.color = '#ffb24a'; }
  else if (st.nitrogenFull) { status.textContent = '🟢 Nitrogen overflowing — trade more: reach another tree root or upgrade Symbiosis'; status.style.color = '#9be86a'; }
  else if (!st.queue.length) { status.textContent = '◦ Idle — tap where you want to grow'; status.style.color = '#67718a'; }
  else { status.textContent = '▸ Growing…'; status.style.color = '#7fe0a0'; }

  updateUpgrade('foraging'); updateUpgrade('mycelium'); updateUpgrade('symbiosis');
  $('btnPause').textContent = paused ? '▶ Resume' : '⏸ Pause';
}

function showOverlay(r) {
  const ov = $('overlay'); if (!ov.classList.contains('hidden')) return;
  $('ovBody').innerHTML = 'Your network starved and collapsed.<br><br>Peak network size: <b>' + r.peak +
    '</b><br>Survived: <b>' + fmtTime(r.time) + '</b><br>Seed: <b>' + r.seed + '</b>';
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
$('btnForaging').addEventListener('click', () => ctx.sim.buyUpgrade('foraging'));
$('btnMycelium').addEventListener('click', () => ctx.sim.buyUpgrade('mycelium'));
$('btnSymbiosis').addEventListener('click', () => ctx.sim.buyUpgrade('symbiosis'));

newRun(urlSeed() ?? randSeed());
attachInput(canvas, ctx, ui);
requestAnimationFrame(frame);

// debug handle (harmless; handy for testing in the console)
window.__game = { get sim() { return ctx.sim; }, get paused() { return paused; }, ui };
