# Code Review — RED TIDE

## Context

Full read-through of `RaskeMillioner/game` at `7120938` (post–Phase 7). The codebase is a
~2,700-line TypeScript/Canvas game with a headless simulation layer, 75 passing tests, a
clean `tsc --noEmit`, and a working 44 kB production build. Quality is high: the sim is
DOM-free and deterministic, balance is measured rather than guessed, and comments explain
*why* rather than *what*.

This document is the deliverable of a review pass looking for bugs, inconsistencies and
improvement opportunities. It is written to be handed to another agent for execution.
Findings are ordered by severity. Each carries a location, the concrete failure, and a
recommended fix.

**Verified baseline before any change:**
```
npx tsc --noEmit     # exit 0
npx vitest run       # 75 passed (4 files), ~31s
npm run build        # dist/assets/index-*.js  43.94 kB / 15.46 kB gzip
```

---

## P0 — Correctness bugs

### 1. Balance is silently coupled to the device's aspect ratio
`src/sim/world.ts:203`, `src/sim/world.ts:313`

```ts
this.anchorY = this.cameraY + this.viewH * SQUAD_SCREEN_FRAC;   // :203
const spawnY = this.cameraY + this.viewH + 60;                  // :313
```

`viewH` comes from `Renderer.resize()` as `LANE_W * (cssH / cssW)` — i.e. it *is* the
viewport aspect ratio. So the distance between the squad and the point reds spawn at is
`viewH * 0.78 + 60`:

| Device | viewH | Reds spawn ahead of squad |
|---|---|---|
| iPhone 14 portrait (390×844) — the probe's 1560 | 1558 | ~1275 |
| iPad portrait (768×1024) | 960 | ~810 |
| Any phone in **landscape** (844×390) | 333 | **~320** |

Every probe run, every test and every tuned win rate uses `VIEW_H = 1560`. On a tablet the
player gets ~37% less reaction time; in landscape the game is unplayable. `orientationchange`
is wired to `onResize` (`src/main.ts:76`), so landscape is reachable today.

Also note `src/sim/config.ts:66-75` documents `BULLET_RANGE = 1900` against "reds spawn about
1275 units ahead" — a constant derived from one viewport.

**Fix.** Decouple the sim from the viewport. Introduce `SPAWN_AHEAD` and `SQUAD_AHEAD` as
world-unit constants in `config.ts` (seed them at 1275 and 343 to keep current balance
bit-identical at VIEW_H 1560), use them in `world.ts:203` and `:313`, and keep `viewH` purely
for culling and `Grid.resize`. Add a test asserting a level's win rate is stable across
`viewH ∈ {960, 1560, 2100}`.

### 2. `gateFlash` fires on every objective the squad passes, collected or not
`src/sim/world.ts:604-609`

```ts
const before = this.rendered;          // capped at MAX_BLUE_RENDER (400)
...
if (this.count > before) this.gateFlash = 0.35;   // compares TRUE count to RENDERED count
```

`before` is the *rendered* count (≤ 400) but the comparison is against `this.count` (up to
4000). Once the squad exceeds 400, `this.count > before` is unconditionally true, so the HUD
count flashes white every time the squad draws level with *any* objective — including ones it
never broke and never collected. The reward feedback becomes noise exactly when the player
has grown enough to need it.

`stepGates` (`world.ts:291`) uses the same `const before = this.rendered` correctly, because
there it is only fed to `seedNewSlots`, which wants a rendered index.

**Fix.** Capture the true count separately:
```ts
const beforeRendered = this.rendered;
const beforeCount = this.count;
...
this.seedNewSlots(beforeRendered);
if (this.count > beforeCount) this.gateFlash = 0.35;
```

### 3. Two hazards visible at once render as one garbage polygon
`src/render/renderer.ts:313-359`

`drawHazard` walks the ground samples, `continue`s past any sample where `holeHalfWidthAt <= 0`
*without writing to `hazLX/hazLY/hazRX/hazRY`*, then draws a single contiguous polygon from
the first to the last sample that had a hole:

```ts
if (hw <= 0) continue;          // :326  — leaves lx[i], ly[i] holding LAST FRAME'S values
...
ctx.moveTo(lx[lo], ly[lo]);
for (let i = lo + 1; i <= hi; i++) ctx.lineTo(lx[i], ly[i]);   // :345 — reads stale slots
```

Two consequences when a gap appears between two holes in the same view:
1. The gap's slots hold values from a previous frame, producing visually random geometry.
2. Even with fresh values, the two holes are joined into one blob.

This is live on **level 10 (NARROWS)**: the hazard at `at: 0.70, span: 0.15` covers world
y 13000–16000, and the barricade at `at: 0.85, span: 0.06` covers 16400–17000. The 400-unit
gap and a `FAR_DZ` of 5000 put both inside one frame's sample range.

**Fix.** Emit one path per contiguous run of hole samples: track run start/end while walking,
and flush a closed polygon (fill + stroke) whenever `hw <= 0` breaks the run, plus one flush at
the end. Alternatively pre-zero the four arrays each frame and emit multiple subpaths.

### 4. Turret bullets damage objectives (but are correctly excluded from barricades)
`src/sim/world.ts:582-597` vs `src/sim/world.ts:672-690`

`collideBarricades` explicitly skips turret fire:
```ts
if (this.bulFromTurret[i]) continue;   // :676
```
`collideObjectives` has no such check. A flipped turret firing straight up the lane will break
open the next crate, pod or turret that happens to share its column — for free, with no fire
diverted from the swarm. Given turrets alternate sides (`objectives.ts:193`) and crates pick a
random side (`objectives.ts:136`), collisions are a matter of seed.

This also silently inflates the probe's `turret value` measurement
(`src/tools/probe.ts:428-460`), which is the evidence the feature was kept on.

**Fix.** Add `if (this.bulFromTurret[i]) continue;` to the bullet loop in `collideObjectives`,
then re-run the probe and confirm turrets still separate `turret-seek` from `turret-avoid`.

### 5. Objectives are unhittable in the 1400–1900 band
`src/sim/world.ts:587`

```ts
if (dy < -OBJECTIVE_H || dy > 1400) continue;
```
`BULLET_RANGE` is 1900 (`config.ts:75`). Bullets exist and are live out to 1900 units, but an
objective more than 1400 ahead is culled from collision entirely, so shots that visually pass
through it do nothing. The magic `1400` matches no other constant in the codebase.

**Fix.** Replace with `dy > BULLET_RANGE` (import it — already imported in `world.ts:7`), or
introduce a named `OBJECTIVE_HIT_RANGE` in `config.ts` if the shorter range is deliberate.
Re-run the probe: this will make crates marginally easier, so check `obj-light` win rates.

### 6. A malformed level definition takes down the whole app with a blank screen
`src/sim/barricades.ts:37-42`, `src/main.ts:31`

`buildBarricades` throws on a barricade whose hole the corridor refused to write. That is the
right call for a data bug — but `new World(level, viewH)` runs at module top level in
`main.ts:31`, and there is no `try`/`catch` anywhere. A bad `BarricadeSpec` added to
`campaign.ts` ships as a black canvas with a console error.

**Fix.** Two parts:
- Keep the throw, but add a build-time guard test in `levels.test.ts` that calls `buildLevel`
  on every `CAMPAIGN` entry and asserts it does not throw. (Partially covered today by
  `corridor.test.ts:318`, but only for levels that already have barricades.)
- Wrap the `play()` path in `main.ts` so a level that fails to build falls back to the menu
  with a visible message rather than a blank screen.

---

## P1 — Performance

### 7. `sample()` allocates an object on every corridor lookup — thousands per frame
`src/sim/corridor.ts:218-225`

```ts
function sample(c: Corridor, y: number): { i: number; j: number; f: number } {
  ...
  return { i, j: i + 1, f: raw - i };
}
```
Every one of `centreAt`, `halfWidthAt`, `holeCentreAt`, `holeHalfWidthAt` allocates. The
comment at `corridor.ts:293-296` claims `clampToCorridor` is "deliberately allocation-free" —
it allocates **four** objects per call, and it is called once per red per frame (up to
`MAX_RED = 3200`) at `world.ts:365`, plus once in `stepAnchor` and once per spawned red.

Rough order of magnitude at a saturated swarm: ~13,000 short-lived objects per frame, ~780k/s.
This is exactly the GC pressure the typed-array design exists to avoid.

**Fix.** Return the index/blend through module-level scratch scalars or split into two tiny
helpers (`sampleIndex(c, y): number` returning `i`, and a shared `let sampleF: number`), or
inline the two-sample lerp into each accessor. Verify with a headless allocation count or a
before/after frame-time measurement; behaviour must stay bit-identical (assert via the existing
determinism tests).

### 8. `this.squeeze` is recomputed per unit inside the firing-line loop
`src/sim/world.ts:427-435`, getter at `src/sim/world.ts:148-167`

```ts
for (let i = 0; i < n; i++) {
  let c = (((slotX[i] * this.squeeze + r) / span) * cols) | 0;   // :428
```
The `squeeze` getter performs **five** `spanHalfWidthAt` lookaheads, each of which is three
`sample()`-allocating accessor calls. With `n` up to 400 and up to 4 volleys per frame
(`stepFiring` caps at 4, `world.ts:401`), that is up to ~24,000 redundant corridor lookups and
~72,000 allocations per frame at minigun cadence.

The getter is also called separately by `radiusX`, `radiusY`, `stepSquad` and `seedNewSlots`,
each recomputing the same value within the same tick.

**Fix.**
- Hoist `const sq = this.squeeze;` out of the `buildFiringLine` loop (mechanical, zero
  behaviour change).
- Cache the squeeze per `step()`: compute once at the top of `step()` into a private field and
  have the getter return the cached value. Guard the tests that read `w.squeeze` after mutating
  `w.count` mid-test (`corridor.test.ts:99`, `:105`) — they step before reading, so a
  step-scoped cache is safe, but confirm.

---

## P2 — Inconsistencies and latent issues

### 9. `emitBursts` silently loses its waves to the tide's budget
`src/sim/levels.ts:276` and `src/sim/levels.ts:303`

Both loops guard on `out.length < MAX_WAVES` against the *same shared array*. `emitTide` runs
first and fills it, so on any level dense enough to hit 8000 waves the scripted bursts — the
thing that makes `runner-rush`, `brute-wall` and `gauntlet` distinct templates — are dropped
entirely and silently. Today's campaign stays well under the cap, but the failure mode is
invisible: the level just becomes a plain tide.

**Fix.** Give each emitter its own budget (e.g. `MAX_TIDE_WAVES` / `MAX_BURST_WAVES`), or emit
bursts first. Add a test asserting every burst template produces at least one wave of each
`burst.types` entry.

### 10. Overlapping hazards silently clobber each other
`src/sim/corridor.ts:195-211`

The per-sample hazard loop writes `holeCentre[i]` and `holeHalfWidth[i]` unconditionally, so at
a sample covered by two hazards, the **last one in the array wins** — the first is erased with
no warning. `buildLevel` concatenates `def.hazards` and `def.barricades` into one list
(`levels.ts:354`), so a barricade overlapping a hazard would quietly delete the hazard and its
`Barricade` record would point at a hole that belongs to something else.

Not currently triggered by the campaign, but level 10 has a hazard ending at t≈0.775 and a
barricade starting at t≈0.82 — about one sample of margin.

**Fix.** Either take the *widest* hole at each sample (`if (allowed > holeHalfWidth[i])`), or
throw at build time on overlapping specs. Add a test with two deliberately overlapping specs.

### 11. Frame-rate-coupled and inconsistent flash decay
`src/sim/world.ts:611-613` vs `src/sim/world.ts:692-696`

```ts
if (o.flash > 0) o.flash = Math.max(0, o.flash - 1 / 30);    // objectives: hardcoded, ignores dt
if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / 0.4);  // barricades: dt-based, 0.4s
```
The sim runs at a fixed 1/60 so this is deterministic today, but the objective decay ignores its
own `dt` parameter and runs at a different duration (0.5s) than the barricade's (0.4s) for no
stated reason.

**Fix.** Use `dt / FLASH_DECAY` for both, with `FLASH_DECAY` in `config.ts`.

### 12. An active turret renders as grey "TAKEN" — FIXED
`src/sim/objectives.ts:100-102`, `src/render/renderer.ts:534-535`, `:558`

**Fixed** alongside retargeting turrets: `taken` now excludes a broken turret, so one that is
still firing keeps its colour and its label. It had to be — with the barrel tracking a target,
greying the turret out hides the only thing worth watching.

`collectObjective` sets `collected = true` for a turret once the squad draws level with it.
The renderer then takes the `taken` branch: grey fill (`OBJ_BROKEN_COLOR`) and the label
`'TAKEN'` — overriding `objectiveLabel`'s `'ACTIVE'` and the `'FIRING'` caption. So a turret
that is *still shooting* (for another `TURRET_RANGE` = 800 units behind the squad) looks
spent.

**Fix.** Exclude turrets from the `taken` visual branch: `const taken = o.collected && o.kind !== 'turret';`
and let the existing `o.kind === 'turret' && o.broken` branches supply the active colour and
label.

### 13. Turrets fire in both directions and waste bullets behind the squad — RESOLVED
`src/sim/world.ts:651-653`

**No longer a defect.** Turrets now track the nearest red instead of firing up their own
column, so a turret the squad has passed shoots the reds chasing it rather than throwing
bullets up an empty lane. The `Math.abs` range gate is deliberate and stays. The original
finding is kept below for the record.

```ts
if (Math.abs(this.anchorY - o.y) > TURRET_RANGE) continue;
```
The absolute value means a turret keeps firing for 800 units *after* the squad has passed it.
Those bullets travel forward at 1000/s (`TURRET_BULLET_SPEED`) from behind the crowd, so they
overtake it and are spent against nothing. They also consume slots in the shared `MAX_BULLET`
pool, competing with the squad's own volleys.

**Fix.** Either gate on `o.y >= this.anchorY - someSmallPad` (turret only fires while it is
still ahead of, or level with, the crowd), or document the current behaviour as intentional.
Re-run the probe's turret section either way.

### 14. Dead branch in the breakthrough check
`src/sim/world.ts:368`

```ts
if (this.redY[i] < breachY || this.redY[i] < cullY) {
```
`cullY = cameraY - 160` and `breachY = anchorY - radiusY - 12 ≈ cameraY + 343 - radiusY - 12`.
Since `radiusY` maxes out around 580 (at `MIN_SQUEEZE`), `breachY` is above `cullY` in all but
extreme compression — so the second test almost never fires first. When it does, an off-screen
red is charged as a leak, which is defensible but never stated.

**Fix.** Either drop the `cullY` test (and its `const` at `:341`), or add a comment saying an
off-screen red is deliberately priced the same as a breakthrough.

### 15. `MAX_RED` saturation is unobservable
`src/sim/world.ts:319`, `src/sim/config.ts:22-27`

```ts
for (let i = 0; i < wave.count && this.redCount < MAX_RED; i++) {
```
The config comment states this plainly: *"headroom here is a correctness concern, not just a
memory one"* — a saturated cap flattens late-run difficulty. But nothing counts the drops, no
test asserts headroom, and the probe never reports it.

**Fix.** Add a `droppedSpawns` counter on `World`, surface it in `probe.ts`'s per-level table,
and add a test asserting it stays at 0 across the campaign under the reference strategy.

### 16. Objective damage ordering is arbitrary within a grid cell
`src/sim/world.ts:526-551`

A piercing bullet spends its damage pool across reds in `grid.query` return order — i.e. cell
order, not distance from the bullet. Within a 56-unit cell a bullet can kill a red *behind*
it before one in front. Cosmetic and bounded, but worth a comment or a cheap sort by `dy` if
brute encounters ever read wrong.

---

## P3 — Dead code and duplication

| Location | Finding |
|---|---|
| `src/sim/formation.ts:14`, `:24-28` | `frontOrder` is built (an `Array.from` + full sort at module load) and **never read**. `buildFiringLine` supersedes it. Delete both. |
| `src/sim/gates.ts:119` | `GATE_MID` is exported and unused. Delete. |
| `src/core/rng.ts:21-23` | `Rng.int()` is unused. Delete or keep with a comment. |
| `src/sim/objectives.ts:122-131` and `:180-188` | `clearOfGates` is duplicated verbatim in `buildObjectives` and `buildTurrets`. Extract to one module-level function. |
| `src/sim/objectives.ts:171-178` | `buildTurrets(_rng, ...)` takes an unused `Rng`. Every caller passes one (`levels.ts:374`). Drop the parameter. |
| `src/sim/corridor.ts:153-165` | The `'narrow'` and `'pinch'` cases are byte-identical. Merge into one fall-through case; the distinction lives in the template's `span`, as the comment already says. |
| `src/render/renderer.ts:451-453` | `const halves = [{ ... }]` is a single-element array allocated per gate per frame — vestigial from the two-panel gate design. Inline it. |
| `src/render/renderer.ts:443`, `:504` | Bare `{ ... }` blocks wrapping whole method bodies, left over from a refactor. Remove the braces. |
| `src/render/renderer.ts:544` | `const frac = o.hp / o.maxHp` is computed before the `if (!brokenFlat)` that is its only consumer. Move it inside. |
| `src/render/renderer.ts:534` | `OBJ_COLOR[o.kind as ObjectiveKind]` — `o.kind` is already `ObjectiveKind`. Drop the cast. |

---

## P4 — Tooling, CI and docs

### 17. Every agent branch deploys over production
`.github/workflows/deploy.yml:6-8`

```yaml
branches: [main, 'claude/**']
```
combined with `concurrency: { group: pages, cancel-in-progress: true }`. Any push to any
`claude/**` branch publishes to the live GitHub Pages site and can cancel an in-flight `main`
deploy. The comment says this is for playtesting the dev branch, which is reasonable — but it
should not share a URL and a concurrency group with production.

**Fix.** Restrict Pages deploys to `main`. If branch previews are wanted, publish them to a
separate path/environment or use `workflow_dispatch` only.

### 18. Non-reproducible installs
`.github/workflows/test.yml:19` uses `npm ci || npm install`; `deploy.yml:23` uses `npm install`.

`npm ci || npm install` silently masks a `package-lock.json` that has drifted out of sync with
`package.json` — the exact failure `npm ci` exists to surface. And the deploy job never uses the
lockfile at all, so the artifact that ships is not the artifact that was tested.

**Fix.** Use `npm ci` in both jobs, unconditionally. Fix the lockfile if it fails.

### 19. `--passWithNoTests` hides a broken test glob
`.github/workflows/test.yml:22`

`npm test -- --passWithNoTests` means a mistake in `vite.config.ts`'s `include: ['src/**/*.test.ts']`
turns a green CI into a meaningless one. Drop the flag; there are 75 tests.

### 20. `vite.config.ts` carries an untyped `test` block
`vite.config.ts:1`

`defineConfig` is imported from `'vite'`, whose `UserConfig` has no `test` property. It works at
runtime only because `tsconfig.json`'s `include: ["src"]` excludes the config file from
typechecking — so a typo in the Vitest config is a silent no-op.

**Fix.** `import { defineConfig } from 'vitest/config';` and add `vite.config.ts` to the
tsconfig `include` (or a second tsconfig for config files).

### 21. No linter
There is no ESLint (or Biome/oxlint) configuration in the repository. `tsc` with `strict`,
`noUnusedLocals` and `noUnusedParameters` catches a lot, but not unused *exports* (see §P3),
`no-floating-promises`, or consistency rules.

**Fix.** Add `eslint` + `typescript-eslint` with `knip` or `ts-prune` for unused exports, and
wire it into `test.yml`. Low effort, and it would have caught four of the P3 items.

### 22. `.weapons.mjs` is not gitignored
`.gitignore` lists `.probe.mjs` but not `.weapons.mjs`, which `src/tools/weapons.ts:10-11`
instructs the reader to produce. Add it, or generalise to `.*.mjs`.

### 23. `README.md` is one word
`README.md` contains only `# game`. For a project with a 523-line design document, a
deterministic balance harness and a deployed build, a README should at minimum carry: what the
game is, the live URL, `npm run dev` / `test` / `build`, how to run the probe and the weapons
tool, and a pointer to `docs/PLAN.md`.

### 24. `docs/PLAN.md` has drifted
- ~~Line 20 (§1 table): *"48 tests"*~~ — refreshed to 80.
- ~~Line 14: *"34 kB, 12 kB gzipped"*~~ — refreshed to 44 kB / 16 kB.
- `src/sim/campaign.ts:15` says *"Phase 9 extends this to twenty levels"* — the campaign has
  twelve and Phase 7 has shipped.
- The enemy table (PLAN lines 84-88) lists Brute cost 6 / Exploder cost 8 against shipped
  values of 4 and 5. The doc does disclaim this as a sketch, so this is lowest priority.

**Fix.** Refresh the three stale numbers and the campaign comment; consider generating the test
count and bundle size rather than writing them down.

---

## P5 — Design and balance observations

These are findings, not defects. They need a human's call before any change.

### 25. `difficulty` is not monotonic, and its effect on HP is quadratic
`src/sim/campaign.ts`: 0.40, 0.52, 0.55, **0.76**, 0.55, 0.80, 0.85, **1.30**, 0.67, 0.98,
1.04, 1.02. Level 8 is the campaign's peak and level 9 drops by half.

This is plausibly deliberate — `difficulty` is a per-template dial and the probe measures the
*win-rate* ramp, not the difficulty column. But `levels.ts:73` describes it as "The campaign's
difficulty dial", which invites reading the column as the ramp. Worth a comment in
`campaign.ts` saying the number is template-relative and the ramp lives in the probe's win-rate
table.

Compounding this: `enemyHp` (`enemies.ts:74-77`) is `hp + hpGrowth * scale²` where
`scale = km * difficulty`. Difficulty therefore scales spawn *rate* linearly
(`levels.ts:279`) but brute/exploder HP **quadratically** — doubling difficulty quadruples
brute HP. `levels.test.ts:107` only asserts `>`. Document the exponent, and consider whether
`difficulty` should enter `enemyHp` linearly.

### 26. Levels 11 and 12 are near-duplicates
Both are `gauntlet`, at difficulty 1.04 and 1.02, with near-identical mixes and neither a
corridor, hazard, barricade nor turret. The finale is the eleventh level, longer. Levels 4, 6,
7, 9 and 10 each carry geometry or structures; the two that close the campaign carry none.

### 27. Coverage gaps
No tests exist for `core/grid.ts` (the spatial hash — a wrong query silently drops hits),
`core/rng.ts` (determinism is asserted only indirectly), `render/projection.ts`, or
`gates.applyGate`'s clamping arithmetic (`gates.ts:53-60`). All four are pure and trivially
testable.

### 28. Accessibility and production hygiene
- `index.html:5` sets `maximum-scale=1, user-scalable=no`, which blocks pinch-zoom entirely.
  Justified for a drag-to-steer canvas, but worth a deliberate note.
- The `<canvas>` has no fallback content or `aria-label`, and there is no `<noscript>`.
- `src/render/renderer.ts:788-792` renders the FPS counter in production builds.

---

## Recommended execution order

Each group is independently shippable; run `npx tsc --noEmit && npx vitest run && npm run build`
after each.

1. **Mechanical, zero-risk** — §P3 dead code and duplication (items in the table), §22, §23,
   §24. One commit.
2. **Clear bugs, small diffs** — §2 (`gateFlash`), §12 (turret "TAKEN"), §11 (flash decay),
   §14 (dead branch). One commit.
3. **Renderer** — §3 (`drawHazard` contiguous runs). Verify visually on level 10 around
   world y 14000–17000; a Playwright screenshot via the dev `__world()` hook is the cheapest
   check.
4. **Sim behaviour, needs a probe re-run** — §4 (turret bullets vs objectives), §5 (objective
   hit range). Run `probe.ts` before and after and record the before/after tables in the
   commit message; expect small win-rate shifts. §13 is resolved and §12 is fixed; note that
   §4 matters more now than when it was written, because an aimed turret fires 30 rounds a
   second rather than 4 and so breaks open far more objectives it was never meant to touch.
5. **Performance** — §7 (`sample()` allocation), §8 (squeeze caching). Behaviour must be
   bit-identical: the determinism tests (`world.test.ts:57`) and
   `levels.test.ts:55` are the guard.
6. **Structural, highest value** — §1 (viewport-independent balance). This is the one change
   that alters what players experience; do it last, on its own, with the new
   cross-`viewH` test written first.
7. **CI and tooling** — §17, §18, §19, §20, §21. Separate PR; §17 changes deployment
   behaviour and should be confirmed with the repository owner first.
8. **Defensive** — §6 (level-build error boundary), §9 (wave budgets), §10 (overlapping
   hazards), §15 (`MAX_RED` telemetry). Each with the test named in its section.

Leave §25–§28 for a human decision; they are design questions, not defects.

