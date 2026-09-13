# RED TIDE — Development Plan

A one-thumb iPhone game: a swarm of red stickmen sprints at your blue squad. Your squad
auto-fires, multiplies through gates, and upgrades weapons. Squad size is your health bar.

## 1. Confirmed design criteria

| Decision | Choice |
|---|---|
| Stack | Web-first, TypeScript + Canvas 2D (no engine) |
| Player controls | The blue squad |
| Movement | Auto-runner, portrait; world scrolls down, one-finger drag steers the formation left/right |
| Growth | Choice gates driven through, **plus** pickups dropped by dead reds |
| Run structure | Discrete levels, 60–90s, each ending in a boss |
| Combat | 1:1 attrition — both sides are crowds; squad count *is* HP |
| Art | Flat stickmen silhouettes, procedurally drawn, zero art assets |
| Weapons | 4 tiers with distinct feel: Pistol → Rifle → Shotgun → Minigun |
| Meta progression | None in prototype; revisit after first playtest |
| Difficulty | Ramp: levels 1–5 power fantasy, 6–10 tight, 11–15 brutal |
| Playtest delivery | GitHub Pages, auto-deployed on push |

## 2. Core loop

1. Level starts: 10 blue, Pistol, at 78% screen height. Camera scrolls the world down at a
   fixed rate; the squad is always advancing.
2. Player drags anywhere on screen; the formation anchor tracks the finger horizontally
   (clamped to the lane, with smoothing so 200 units feel like one mass).
3. Blue units auto-fire upward on their weapon's cadence. No aim input.
4. Reds stream down from off-screen, running at the squad. A red that touches the formation
   kills exactly one blue and dies. Count hits 0 → fail.
5. Gate pairs span the lane every ~8s: `×2 / +30`, `×2 / −20`, `SHOTGUN / +40`. You steer
   into one. This is the decision the whole game hangs on.
6. Dead reds sometimes drop pickups (recruit tokens `+1–3`, ammo crates = 5s fire-rate boost)
   with a small magnet radius — a greed lure that pulls you off the safe line.
7. Level ends with a Brute: a giant red with a visible HP bar. Your squad's DPS vs its walk
   speed. It reaches you → it kills 20 blue per swipe.

**Failure is always legible.** You lost because you took `+30` over `×2`, or you chased a
pickup into the swarm. Never because of something off-screen.

## 3. Architecture

```
src/
  main.ts            entry, canvas setup, DPR + safe-area handling
  core/
    loop.ts          fixed 60Hz sim step, decoupled variable-rate render
    rng.ts           seeded PRNG — deterministic runs make sim tests possible
    pool.ts          object pools for units/bullets/particles (zero GC in the hot loop)
    grid.ts          uniform spatial hash for broad-phase collision
  sim/
    world.ts         authoritative state; no DOM, no canvas — headless-testable
    squad.ts         formation packing, anchor steering, count changes
    swarm.ts         red spawn director, per-wave pacing
    combat.ts        firing cadence, bullet integration, attrition resolution
    gates.ts         gate ops (×2, +N, −N, weapon tier)
    pickups.ts       drops, magnet radius, effects
    boss.ts          brute HP, swipe attack
    levels.ts        pure data: wave tables, gate sequences, difficulty curve
  render/
    renderer.ts      single canvas; batches all reds into one Path2D, all blues into another
    fx.ts            hit flashes, corpse decals, screen shake, damage numbers
    hud.ts           squad counter, weapon badge, boss bar, level banner
  audio/
    audio.ts         WebAudio, synthesized SFX — no audio files to ship
```

**Non-negotiable separation:** `sim/` never imports `render/`. The simulation runs headless
in Node, which is what makes balance testable without a browser.

### Performance budget (the actual risk)
Target: 60fps on an iPhone with ~400 blue + ~600 red + 300 bullets live.
- Two `Path2D` objects per frame (one per team), each accumulating hundreds of subpaths,
  then **two** `fill()` calls total. Not 1000 draw calls.
- Uniform-grid broad phase, cell size = contact radius. Never O(n²).
- Pool everything; no allocation inside the step.
- Cap *rendered* blue at 400 and show the true number on the HUD — nobody can count past 400.
- Sim at fixed 60Hz with a max of 3 catch-up steps, so a stall never spirals.

## 4. Phases

| # | Phase | Output | Owner |
|---|---|---|---|
| 0 | Scaffold | Vite + TS + Vitest, GitHub Actions → Pages, correct `base`, fullscreen portrait shell with safe-area insets | Sonnet |
| 1 | Feel skeleton | Scrolling lane, blue formation, drag steering, red runners, flat stickman rendering | Me |
| 2 | Combat | Firing, bullets, spatial hash, 1:1 attrition, fail state | Me |
| 3 | Gates + pickups | Gate pairs and ops, drops, magnet | Sonnet, on my interfaces |
| 4 | Level shape | Wave director, Brute boss, win/lose screens, level select | Sonnet |
| 5 | Juice | Screen shake, hit flash, corpse decals, popup numbers, synthesized SFX | Sonnet |
| 6 | Content + tuning | 15 levels, difficulty ramp, balance pass against sim tests | Me |
| 7 | Playtest | Deploy, you play on your phone, I iterate | Both |

**Phase 1 + 2 is the go/no-go.** If steering 200 stickmen into a red tide isn't fun with
placeholder everything, no amount of phases 3–6 saves it. Nothing else gets built until
that's on your phone.

## 5. Delegation to Sonnet

Sonnet takes work that is well-specified and independently verifiable: the build/CI scaffold,
gate and pickup systems against interfaces I define, UI screens, the audio layer, level data
tables, and the headless sim tests. I keep the parts where the whole thing lives or dies:
the sim architecture, collision and performance, and every tuning constant that decides
whether it feels good. Sonnet works from written interface contracts, in parallel, on
separate files; I integrate and own the merge.

## 6. Known risks

- **iOS Safari perf.** Mitigated by the batching plan above; measured every phase, not at the end.
- **Touch fighting the browser.** `touch-action: none`, `user-select: none`, no default gestures,
  `viewport-fit=cover` + `env(safe-area-inset-*)` so the notch and home bar don't eat the play field.
- **No haptics.** The Vibration API doesn't exist in iOS Safari. Impact has to come from
  visuals and sound alone — worth knowing before it's a disappointment.
- **Balance is the hard part, not the code.** Deterministic seeded sim tests let us run a
  level 500 times headlessly and check the win-rate curve instead of guessing.
- **GitHub Pages needs enabling.** Repo Settings → Pages → Source: *GitHub Actions*. Free
  Pages requires a public repo on a personal account.

## 7. Tuning starting points

| Weapon | Rate | Pattern | Feel |
|---|---|---|---|
| Pistol | 2.5/s | 1 bullet | Weak, the baseline you want to escape |
| Rifle | 6/s | 1 bullet | Competent |
| Shotgun | 2/s | 5 pellets, 30° | Deletes clumps, gaps between shots |
| Minigun | 14/s | 1 bullet, slight spread | A hose |

Start squad 10. Gate cadence ~8s. Scroll speed 240px/s. Red contact radius 14px.
Level 1 total reds ~120; level 15 ~2000. All of it is data in `levels.ts`, all of it will
be wrong on the first pass, and all of it changes after you play it.
