# 🍄 Mycelium — *First Bloom*

A single-player, real-time-with-pause **strategic-survival roguelike** about growing the
biggest fungal network you can. Side-view underground cross-section, original pixel art,
no microtransactions. This repo is the **M1 web prototype** — the playable core loop.

> **▶ Play it live:** https://koramak.github.io/mycelium/

## How to play

You start as a single spore. Extend your **mycelium** through the soil to tap resources,
balance your economy, and survive escalating **wildfires** — grow the largest network you can.

- **Left-drag** — grow toward a spot (auto-pathfinds from your network)
- **Right-drag** — retract hyphae (pull them off the surface before a fire!)
- **Space** — pause (it's real-time, so pausing to plan is fair game)
- **R** — new run · add `?seed=123` to the URL to replay an exact map

### The loop
- Three resources: **🍬 Sugar** (tree roots, near the surface), **⛰ Minerals** (buried logs),
  **💧 Water** (deep pockets). Growth costs a mix of all three.
- Every hypha tile has **upkeep** — a bigger network costs more to maintain, so you need
  income from nodes to expand. Run a resource dry and the network **starves and dies back**.
- A telegraphed **wildfire** sweeps the surface on a timer, burning exposed hyphae and
  leaving **ash** (a minerals bonus when you regrow into it). Fires arrive sooner and dig
  deeper over time — eventually you fall, and your **peak network size is your score.**
- Sugar sits near the dangerous surface while water/minerals sit safe and deep — so the
  economy keeps pulling you *toward* the fire. That tension is the heart of the game.

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
| `src/sim.js` | Pure simulation — seeded RNG, grid, resources, growth, fire. No DOM. |
| `src/render.js` | Canvas renderer (the glowing mycelium network, soil, nodes, fire). |
| `src/input.js` | Pointer → sim commands + hover path preview. |
| `src/main.js` | Fixed-timestep loop (30 Hz), pause, HUD, run lifecycle. |

## Roadmap

- **M1 — First Bloom** ✅ core loop (this prototype)
- **M2** — 4 mushroom archetypes (Decomposer / Symbiont / Parasite / Pioneer), the
  **overproduction** mechanic, and animals
- **M3** — original pixel art + audio pass, daily-seed challenge
- **M4** — port to LÖVE2D, iOS build, Game Center leaderboards
- **M5** — App Store premium release

---
*Prototype built with [Claude Code](https://claude.com/claude-code).*
