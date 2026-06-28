# 🍄 Mycelium — *First Bloom*

A single-player, real-time-with-pause **strategic-survival roguelike** about growing the
biggest fungal network you can. Side-view underground cross-section, original pixel art,
no microtransactions. This repo is the **M1 web prototype** — the playable core loop.

> **▶ Play it live:** https://koramak.github.io/mycelium/

## How to play

You start as a single spore. Push your **mycelium** through dark, fog-hidden soil to hunt
**nitrogen**, trade it to trees for sugar, and run a self-sustaining economy — grow the
largest network you can before it starves.

- **Tap / drag** — grow toward a spot (auto-pathfinds from your network)
- **Space** — pause (it's real-time, so pausing to plan is fair game)
- **R** — new run · add `?seed=123` to the URL to replay an exact map

### The loop — a two-input pipeline, one currency
- **🟢 Nitrogen** is mined from **organic-matter nodes** buried in the soil. Extraction
  scales with how many of your tiles touch a node — a scouting tip gets a trickle;
  *surround* it and it gushes. Nodes are hidden by **fog of war** until your network
  nears them (subtle soil discoloration hints when one is close).
- Deliver nitrogen to a **tree root** and it's exchanged for **🍬 Sugar** — your one
  currency. The **hub tree** by your core trades best; **distant roots** add throughput
  once your nitrogen income outgrows the hub.
- **💧 Water** seeps in passively — the deeper your network reaches, the wetter the soil.
- Growth and **upkeep** both burn Sugar + Water; run either dry and the network
  **starves and dies back** from the edges. **Upgrades** — *Foraging · Mycelium ·
  Symbiosis*, three tiers each — cost Sugar. Your **peak network size is your score.**
- Buried **logs** are a discovery reward: touch one and your network bursts through it
  for free. Sugar lives at the surface (trees) while water lies deep — so the economy
  pulls you in both directions at once.

## Run locally

No build step, no dependencies — just a static server:

```bash
python3 -m http.server 8000   # or: python3 server.py
```
Then open http://localhost:8000

## Architecture

The simulation is deliberately **headless and deterministic** so it can port cleanly to
[LÖVE2D](https://love2d.org/) / Lua for the eventual iOS build (Balatro's stack):

| File | Role |
|------|------|
| `src/sim.js` | Pure simulation — seeded RNG, grid, fog, nitrogen/tree/water economy, growth. No DOM. |
| `src/render.js` | Canvas renderer (glowing network, fog, nodes, tree roots, two-way resource flow). |
| `src/input.js` | Pointer → sim commands + hover path preview. |
| `src/main.js` | Fixed-timestep loop (30 Hz), pause, HUD, upgrade tracks, run lifecycle. |

## Roadmap

- **M1 — First Bloom** ✅ core loop (this prototype)
- **M2** — 4 mushroom archetypes (Decomposer / Symbiont / Parasite / Pioneer), the
  **overproduction** mechanic, and animals
- **M3** — original pixel art + audio pass, daily-seed challenge
- **M4** — port to LÖVE2D, iOS build, Game Center leaderboards
- **M5** — App Store premium release

---
*Prototype built with [Claude Code](https://claude.com/claude-code).*
