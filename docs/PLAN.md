# RED TIDE — Development Plan

A one-thumb iPhone game: a swarm of red stickmen sprints at your blue squad. Your squad
auto-fires forward, grows through gates and shootable structures, and every red that gets
past the line takes a body with it.

Revised after the first playtests. The original plan described a top-down auto-runner with
paired gates as the central decision; almost none of that survived contact with play, and
this document describes what the game actually is and where it goes next.

Phases 4, 5 and 6 are built. The game is a twelve-level campaign, not one endless run, the
lane has a shape, and it can split around something you have to steer past.

## 1. Where the code is

Playable and deployed at `raskemillioner.github.io/game/`. 44 kB, 16 kB gzipped, no runtime dependencies.

| Built | Notes |
|---|---|
| Third-person perspective | Ground-plane pinhole projection, camera behind and above; sim stays 2D |
| Crowd steering | Phyllotaxis formation, per-slot follow lag, relative one-thumb drag |
| Crowd combat | Emitter-capped fixed-forward fire, spatial hash, batched Path2D rendering |
| Red pursuit | Reds intercept the squad; leak rate under 1% for good play |
| Breakthrough attrition | A red that crosses behind the crowd kills one blue and dies |
| Gates | Single-option, narrow, missable; take it or dodge it |
| Objectives | Weapon crates and recruit pods, shot while the swarm closes |
| Enemy archetypes | Grunt, runner, brute, exploder; per-unit hp and a damage-pool bullet model |
| Levels | `LevelDef` + five templates generating a concrete spawn-event list from a stored seed |
| Finish line and win state | Levels end at a line; `won` and `dead` are separate outcomes |
| Campaign | Twelve levels, level select, next-level unlock persisted in `localStorage` |
| Corridor | Lane shape over `worldY`: narrowing, pinches and bends; the crowd compresses to fit |
| Hazards | Pits that split the lane into two spans; the crowd funnels down to thread one |
| Structures | Barricades: a hazard with hit points, broken by fire or dodged. Turrets: flipped by fire, then tracking the nearest red at 30 rounds a second |
| Balance harness | Headless seeded probe: strategy survival, per-type attribution, and per-level win rate against a target ramp; 80 tests |

**Not built:** bosses, audio, juice.

## 2. Confirmed design criteria

Carried forward: web-first TypeScript + Canvas 2D, player controls the blue squad,
auto-runner, flat stickman silhouettes, 1:1 attrition, four weapon tiers, GitHub Pages.

Settled in playtest:

| Decision | Choice |
|---|---|
| Camera | Third-person perspective, fake-3D in Canvas 2D |
| Aiming | Fixed forward — position *is* targeting |
| Gates | One option each, narrow, dodgeable; occasional punctuation, not the main loop |
| Objectives | The steady progression: weapon crates, recruit pods |
| Enemy archetypes | Brute, Runner, Exploder. **No ranged enemy** |
| Level authoring | Parameterised templates + seed |
| Level variety | Lane hazards, lane shape, new objective kinds |
| Meta progression | Level campaign, no persistent upgrades — every level starts at 16 blue and a pistol |

**No shooter enemy** is a deliberate constraint, not an omission. A crowd cannot dodge, so
an enemy that kills at range turns squad size from a resource into a liability and breaks
the fantasy the whole game is built on. Revisit only if levels start feeling same-y.

**No persistent upgrades** is what keeps this tunable. Every level is balanced against one
known starting state, so a level's difficulty means something.

## 3. The architecture gap

Of the three things phase 4 named as hardcoded, two are now data:

1. ~~**One enemy type.**~~ Built: `redType` and `redHp` alongside the position arrays, with a
   static per-type table, in phase 4.
2. ~~**Waves are a formula.**~~ Built: `Director.rate()` is gone. A template generates a list
   of `SpawnWave`s and the sim only decides where reds go, never how many or when.
3. ~~**The lane is a constant.**~~ Built: `LANE_W` is still the coordinate space, but the
   *drivable span* within it is now sampled data the sim and the renderer both read.
   Forks remain phase 10.

All three are now data. What is left is content built on top of them.

### Enemy types — built

`redType: Uint8Array` and `redHp: Float32Array` sit alongside the existing arrays, with a
static per-type table: hp, speed range, contact cost, radius, shade. Shipped values are in
`enemies.ts` and differ from the sketch below where the probe said they should.

| Type | HP | Speed | Cost on contact | Role |
|---|---|---|---|---|
| Grunt | 1 | 110–155 | 1 blue | The tide. What exists today |
| Runner | 1 | 260–320 | 1 blue | Arrives early and punishes a player lined up on a crate |
| Brute | 40–200 | 70–90 | 6 blue | Soaks the line; decide whether to spend fire on it or reposition |
| Exploder | 2 | 150–190 | 8 blue | Makes a leak frightening rather than a slow drip |

The damage model changed with it: a bullet's `pierce` budget is a damage pool, and each red
consumes `min(hp, remaining)`. For 1-HP enemies that is identical to the old behaviour, so
grunts were unaffected. Per-unit hp now scales with distance multiplied by the level's
difficulty, so one curve covers both the ramp inside a level and the ramp across the
campaign.

Rendering stayed batched — one `Path2D` per type rather than per unit, so four fills instead
of one. Overlap within a type is still invisible, so still no depth sort.

### Levels — built

```ts
interface LevelDef {
  id: number;
  name: string;
  seed: number;          // stored, never derived from Math.random — level 7 must be level 7
  template: TemplateId;  // 'tide' | 'runner-rush' | 'brute-wall' | 'gauntlet' | 'choke' | 'endless'
  difficulty: number;    // scalar on spawn rate and enemy hp
  length: number;        // world units to the finish line
  mix: Partial<Record<EnemyType, number>>;  // spawn weights
  structures: StructureSpec;                // gate and objective cadence
}
```

`corridor` and `hazards` are deliberately absent until phase 6 owns them: a field nothing
reads is a promise, not a design.

A template is a pure function `(def, seed) -> SpawnWave[]`, each wave carrying its type,
count, spread and a baked hp — so the sim never re-derives difficulty at runtime. Generation
is deterministic, so a level is reproducible, diffable and measurable by the probe.

The endless run survives as a template of its own. It is not in the campaign; it is the
baseline the harness measures against, and keeping it exactly reproduces the balance the
first four phases were tuned to — which is what let the campaign inherit tuning that already
plays rather than starting from nothing.

Two decisions worth writing down:

- **Wave size grows with the spawn rate; wave spacing does not shrink.** A late-level tide is
  a few hundred events rather than tens of thousands. At 0.12s between waves the squad
  advances 29 units, well inside the depth reds are scattered over, so the tide reads exactly
  as continuous as the old per-frame accumulator did.
- **Structure ramps are indexed within a level, not across the campaign.** Every level starts
  at 16 blue with a pistol, so the growth curve inside a level has to be the same one every
  time for its difficulty to mean anything. Difficulty comes from the enemies, not from
  handing later levels weaker gates.

### Hazards — built

A hazard is a pit punched out of the middle of the lane. The corridor returns **two spans**
around it and the player commits to one. That is phase 10's fork machinery arriving early,
and it was the only honest option: a render-capped crowd is 440 wide against a 720 lane and
is clamped to stay inside it, so it always covers the centre line. Anything central is
unavoidable unless a real gap is opened either side of it.

Stored as two more sampled arrays beside `centre`/`halfWidth`. A zero-width hole is a strict
no-op, which is what kept the ten hazard-free levels' win rates identical to the digit.

**A general fork is still phase 10.** This works only because red pursuit is positional —
reds intercept the squad wherever it is and the spawn bias already tracks `anchorX` — so
adjacent, short-lived branches need no per-branch swarm logic. Long, widely separated
branches still do.

The toll for standing in a pit is proportional to the crowd, so it means something at every
squad size. It never caps growth the way an undodgeable proportional source would, because
a pit can be steered around.

**Hazards are a real skill test, and establishing that took three measurements, two of them
wrong.** The fair comparison is one player against itself:

| Reference player | Toll, as % of peak squad | Win rate |
|---|---|---|
| `obj-light` — ignores pits | 14.2% | 75% |
| `obj-pit` — same player, routes around them | **0.8%** | 63% |

Routing around a pit cuts its toll seventeen-fold. It also costs pickups, so paying the
toll and keeping the objectives is often the *better* play — which is what makes a pit a
decision rather than a rule.

The two discarded measurements are worth recording, because both looked convincing:

- A first run showed a dodging strategy paying 3.7% against 15.5%. That was measured
  against broken geometry: `holeCentre` was left at zero wherever a hole was closed, so
  interpolating into an open sample swept the pit in from the left lane edge instead of
  growing it in place. Seeding the array to the lane's centre fixed it.
- The corrected run showed the dodger paying *more* (18.7%), which read as the skill being
  fake. It was not: that strategy threads pits perfectly — zero overlap, zero bodies — and
  then starves, because dodging was all it did. Toll as a share of peak squad flatters
  nobody who dies before they have a crowd to lose.

The crowd also reads the lane `SQUEEZE_LOOKAHEAD` ahead rather than underfoot, so it funnels
down before the lip arrives. Without that the pit opened beneath a full-width formation and
took its cut before anyone could be narrow — an unavoidable toll wearing a skill test's
clothes.

### Corridor — built

`LANE_W` stays fixed at 720 as the virtual coordinate space. The *drivable span* within it
is sampled every 60 units into two `Float32Array`s — centre and half-width — baked at
level generation exactly as spawn waves are. The anchor clamp, red spawning, gate and
structure placement and the renderer's ground all read the corridor instead of the
constant. Forks still need the accessors to return a list of spans rather than one, which
remains the only genuinely awkward part, and stays in phase 10.

A straight full-width corridor is a **strict no-op**, verified to the digit: the anchor
clamp's cap works out to `LANE_W * 0.36` and structures land on `LANE_W * 0.22` / `0.78`
exactly as before. That is what let ten of twelve levels keep their measured win rates
unchanged while two gained geometry.

**A narrow lane compresses the crowd; it never kills it.** `slotX` scales by
`min(1, halfWidth / radius)` and `slotY` by its inverse, so area and every body are
conserved, and `radius` splits into `radiusX` (firing line, swarm frontage, pickup
overlap) and `radiusY` (breakthrough depth). Killing the overhang instead would make squad
size a liability in narrow sections — the same argument that rules out a ranged enemy,
wearing a different hat.

**The corridor is not a difficulty dial, and that was a surprise.** Halving `choke`'s
density spike on the assumption that a narrowed lane would supply the missing pressure
made NARROWS markedly *easier* — 48% to 65%. Compression cuts three ways and only one
favours the swarm:

| Effect of a squeeze | Who it helps |
|---|---|
| Firing line narrows, covering less of the swarm | the swarm |
| Crowd deepens, so a red must run further to break through | the player |
| Swarm frontage derives from the crowd's, so it arrives narrower and funnels into the guns | the player |

Net, a squeeze protects the player. The density spike was doing the work all along and has
been restored. Lane shape is navigational and visual variety; narrow sections get their
teeth from hazards.

A second trap, found only by screenshotting it: the crowd's radius tops out at
`formationRadius(MAX_BLUE_RENDER)` around 220 however large the squad truly is, so a pinch
looser than a half-width of ~232 squeezes nothing at all. The first THE PRESS bottomed out
at 231 and was pure scenery. `SQUEEZE_THRESHOLD` and a test now hold every shaped level
below it.

### Structures

Phase 7 adds two kinds of thing to the lane: a **barricade**, which is in your way, and a
**turret**, which is on your side once you have paid for it. Both are built. What follows
is the spec they were built from, and what the probe actually measured after building.

#### A barricade is a pit you are allowed to fill in

A barricade is specified exactly as a hazard is and baked into the same `holeCentre` /
`holeHalfWidth` sample arrays. Every consumer that already copes with a split corridor —
the anchor clamp, red spawning, `spanHalfWidthAt`, the crowd squeeze, the renderer's ground
edges — copes with a barricade without a line of new code. The difference is hit points:
shoot it enough and its hole collapses to zero, and the lane is whole again by the time the
squad arrives.

The decision it poses is **spend fire, or spend position.** Shooting the wall is shooting
away from the swarm, exactly as a crate is. Not shooting it means committing to one of the
two spans beside it — the pit decision — and giving up whatever sits behind it on the other
side.

The obvious reading, a wall that stops the squad dead until it is broken, was rejected on
architecture rather than taste. `cameraY` advances at a constant `SCROLL_SPEED`, and every
spawn wave, gate and crate is keyed to `y`. A wall that halts the squad makes scroll
variable, which invalidates wave pacing, the probe's timing, the hazard toll and the finish
clock in one move. That is a phase of its own, not a structure kind.

Three constraints the build has to respect:

- **Neither span may close below `MIN_SPAN_HALF`.** The floor a pit already respects. A
  barricade wide enough to breach it is unwinnable rather than hard.
- **Breaking one mutates the corridor.** This is the genuinely invasive part, and it is
  worth saying plainly: everything phase 6 wrote assumes the samples are baked at
  generation and never touched again. The cheapest honest shape is for each barricade to
  record the sample range it wrote and, on breaking, rewrite that range to zero.
  `isStraight` and the no-op guarantee must survive it.
- **Partial damage buys nothing.** A hole that narrows as it takes hits was considered and
  rejected: it makes the toll continuous and the decision mushy. Break it or don't.

#### A turret is a second firing line you have to stand near

Shoot a turret to flip it friendly. It then **tracks the nearest red and shoots at it**, at
30 rounds a second, for as long as the squad is in range, and is left behind when you pass
it. No steering state, no formation attachment, no new bullet machinery.

**Aiming is what makes a turret a gun.** It shipped in phase 7 firing dead forward up its
own column, on the reasoning that fixed-forward fire is the game's whole verb. That
reasoning does not transfer: the squad fires forward because *position is targeting* and the
player steers it, and a turret has no position to steer. A fixed emitter bolted to the lane
edge hits whatever happens to wander into one column, which the probe priced at ten kills a
run and zero win rate. Aiming also gives the range gate a meaning it lacked — a turret the
squad has already passed now shoots the reds chasing it, instead of throwing bullets up an
empty lane.

A turret acquires once per frame rather than once per shot, by linear scan over the reds
within `TURRET_TARGET_RANGE`. Not the spatial hash: turrets fire before the grid is rebuilt,
so it holds last frame's positions, and its query caps its output — the wrong shape for a
search that has to see every candidate. At most a couple of turrets are ever in range at
once, so the scan is cheap and, unlike a capped query, exact.

With no target it holds fire *and does not bank the interval*, or a turret that idles through
a lull dumps the whole lull as one burst the instant a red appears.

Two numbers decide whether it is worth having:

- **Its damage is flat, not squad-derived.** Squad damage scales with the crowd; a turret
  scaled the same way would be nothing to a small squad and a rounding error to a large one
  — the worst of both. Flat damage makes a turret worth most to a player who has been
  mauled, which is a role nothing else in the game fills.
- **It sits off-centre, like every other objective.** Standing where the turret covers means
  standing where your own fire does not. That is the verb the whole game runs on, and it is
  the only thing keeping a turret from being a weapon crate with a new label.

`MAX_EMITTERS` is 26 and belongs to the squad's firing line. A turret's emitters come out of
a separate budget or a turret quietly steals columns from the crowd it is supposed to help.

**Rate of fire is a feel dial; damage per second is the balance dial.** Measured at a fixed
810 damage a second, 20/s × 40 and 45/s × 18 produce the same win rates and the same kill
counts to within noise. 30 × 30 is what ships: fast enough to read as a stream of tracers
rather than a metronome, at a damage per second the probe sized rather than guessed.

#### The data

```ts
interface StructureSpec {
  // existing: gateFirst, gateSpacing, objectiveFirst, objectiveSpacing
  turretFirst?: number;
  turretSpacing?: number;
}

interface LevelDef {
  // existing: ..., corridor?, hazards?
  barricades?: readonly BarricadeSpec[];   // HazardSpec plus hp
}
```

Turrets are a new `ObjectiveKind`, not a new system: shootable, off-centre, resolved as the
squad draws level with them, which is the `Objective` lifecycle exactly. Barricades are
deliberately *not* objectives — they are corridor data that happens to have hp, and filing
them under objectives would put two systems in charge of one hole.

**Absent means strictly absent.** A level naming neither field is bit-identical to today,
held by an explicit test rather than by assumption — the same discipline that let ten of
twelve levels keep their measured win rates through phase 6.

Four levels gained content: levels 6 and 10 have barricades; levels 7 and 9 have turrets.

#### What the probe measured (phase 7)

**Barricades.** Level 10's original placement at t=0.52 (the bend's tightest point,
laneHalf≈155) could not fit a 160-wide hole — the lane leaves only 55 units each side, below
MIN_SPAN_HALF=100. Moved to t=0.85 where the corridor opens to laneHalf≈360, giving
a hole half-width of 159.6 with 200.4 each side.

Probe (20 seeds per level):

```
lvl  strategy           win%   hazard losses
  6  obj-light             80%              0
  6  obj-pit               45%              0
  6  barricade-shoot       75%              0

 10  obj-light             60%            382
 10  obj-pit               20%             15
 10  barricade-shoot       60%            382
```

Level 6: the barricade creates no hazard losses for any strategy — the wall is thin enough
and the lane wide enough that fire breaks it before the squad arrives. barricade-shoot is
slightly worse than obj-light because committing fire to the barricade hole costs crate and
gate collection. Level 10: barricade-shoot equals obj-light (both 60%, 382 losses). The
barricade at t=0.85 is so close to the end of the level that it breaks naturally; the
comparison that was meant to separate them does not. The barricade mechanic is functional
and well-tested, but neither placed specimen creates a decision the probe can measure.

**Turrets.** These are the phase 7 measurements, kept because they are the case for the
change that followed. Three bugs were fixed before measuring:

1. `stepTurrets` had `|| o.resolved` in its guard — turrets stopped exactly when the squad
   drew level, cutting the trailing half of `TURRET_RANGE`. Removed.
2. All three level-7 turrets landed on x=158 (rng drew left three times). `buildTurrets`
   now alternates sides by index.
3. Turret HP was fixed at 320 while crates ramp 240→2400. HP now ramps: 280 + i×200.
4. Squad bullets reused turret-bullet slots without zeroing `bulFromTurret`, causing false
   kills after the turret was out of range. Fixed by zeroing `bulFromTurret[j]` when
   emitting squad bullets.

Probe (20 seeds per level):

```
lvl  measurement        strategy        turret kills   win%
  7  a: with turrets    obj-light                9.8     65%
  7  a: no turrets      obj-light                0.0     65%
  7  b: decision        turret-seek             17.3     65%
  7  b: decision        turret-avoid             2.9     70%

  9  a: with turrets    obj-light                1.4     45%
  9  a: no turrets      obj-light                0.0     45%
  9  b: decision        turret-seek              3.5     45%
  9  b: decision        turret-avoid             0.1     25%
```

Level 7: turrets add ~10 kills per run but move the win rate by 0 points (65% with or
without). The decision test reverses: turret-avoid (70%) beats turret-seek (65%). Committing
fire to the turret costs enemies killed, and the fire support it returns is not worth the
trade at level 7's difficulty. Level 9: turrets also add ≤2 kills per run and do not move
the "with vs without" win rate. The decision test separates sharply: turret-avoid (25%) is
20 points worse than turret-seek (45%), because avoid steers away from turrets even after
they are flipped, losing both the positional benefit and the fire support.

**The plan pre-authorised this answer.** Turrets add kills but do not improve win rates on
either level. On level 7 the feature is not a decision; on level 9 it is a decision but only
because avoid is self-defeating (steering away from a broken turret means steering into worse
position). Recommendation: **cut turrets from level 7**; keep level 9 where the decision is
real. Phase 8 should evaluate whether a single turret level warrants the feature's ongoing
complexity.

#### What the probe measured (aimed turrets)

The cut was not taken. A turret that tracks the nearest red at 30 rounds a second, at 30
damage a round, was measured instead, and it is the better answer on both levels. Same 20
seeds per level, same strategies:

```
lvl  measurement        strategy        turret kills   win%
  7  a: with turrets    obj-light               37.0     65%
  7  a: no turrets      obj-light                0.0     65%
  7  b: decision        turret-seek             67.3     80%     (was 65%)
  7  b: decision        turret-avoid            48.0     70%     (was 70%)

  9  a: with turrets    obj-light                9.2     45%
  9  a: no turrets      obj-light                0.0     45%
  9  b: decision        turret-seek             21.6     50%     (was 45%)
  9  b: decision        turret-avoid             3.1     25%     (was 25%)
```

**Level 7's reversal is gone.** Phase 7's damning result was that `turret-avoid` (70%) beat
`turret-seek` (65%) — diverting fire onto a turret cost more than the turret returned. Aimed,
seek beats avoid by ten points and the recommendation to cut turrets from level 7 is
withdrawn. Level 9 already separated and separates wider now, 50% against 25%.

**Damage per second is not the binding constraint; targets in range are.** Swept from 96 to
6000 damage a second, level 7's turret kills under `obj-light` rise 19 → 49 and then stop,
while `turret-seek` keeps climbing to 114. The ceiling is how many reds come within reach of a
gun bolted to the lane edge, and the only way to raise it is to stand there — which is exactly
the decision a turret is supposed to pose. Past ~800 damage a second, extra damage buys a
turret-seeking player win rate and buys everyone else nothing, so the number was set where the
decision is real rather than where the turret is strongest.

**No difficulty was lifted.** Level 7 moved 70% → 73% against a 70% target, level 9 did not
move at all, and both sit well inside the ±12 band. Three points on 40 seeds is noise, not a
drift worth chasing with the difficulty dial.

**Campaign win rates after phase 7** (obj-light, 40 seeds, target 95%→50% ±12):

```
 1 FIRST CONTACT    100%  (target  95%)
 2 OPEN GROUND       93%  (target  91%)
 3 SPRINTERS         95%  (target  87%)
 4 THE PRESS         90%  (target  83%)
 5 HEAVY             75%  (target  79%)
 6 SHORT FUSE        78%  (target  75%)   ← barricade added
 7 RED MILE          73%  (target  70%)   ← aimed turrets (was 70%)
 8 STAMPEDE          68%  (target  66%)
 9 THE WALL          53%  (target  62%)   ← turrets added; unmoved by aiming them
10 NARROWS           53%  (target  58%)   ← barricade moved to t=0.85
11 GAUNTLET          48%  (target  54%)
12 RED TIDE          50%  (target  50%)
```

All twelve levels inside the ±12 point tolerance. The ten levels with neither turrets nor
barricades are unchanged to the digit, through phase 7 and through aiming the turrets after
it.

## 4. Phases

| # | Phase | Output | Owner |
|---|---|---|---|
| 4 | ~~Enemy types~~ | **Done.** Per-unit HP, damage-pool bullets, grunt/runner/brute/exploder, per-type batching | Me |
| 5 | ~~Level system~~ | **Done.** `LevelDef`, template generators, finish line, win/lose, level select, campaign flow | Split |
| 6a | ~~Corridor~~ | **Done.** Corridor over worldY, narrowing, pinches and bends; crowd compression | Me |
| 6b | ~~Hazards~~ | **Done.** Pits that split the corridor into two spans; proportional toll for standing in one | Me |
| 7 | ~~Structures~~ | **Done.** Barricades that must be broken or dodged; turrets to free, since retargeted onto the nearest red | Sonnet |
| 8 | Juice + audio | Screen shake, hit flash, damage popups, synthesized SFX, no audio files | Sonnet |
| 9 | Content pass | 20 levels generated, measured and tuned against the probe | Me |
| 10 | Forks | Corridor returning multiple spans; only if levels feel same-y without it | Me |

**Phase 8 is next.** Phase 7 shipped as specified — a barricade is a hazard with hit points,
a turret is a friendly emitter, and a level that names neither is unchanged to the digit —
except that the turret stopped being *static*: it now tracks the nearest red, which is what
turned it from a measured non-decision into the best decision on level 7.

All six P0 correctness bugs in `docs/CODE_REVIEW.md` are fixed (§1, §2, §4, §5 in PR #9;
§3, §6 after it). The rest of that backlog (P1–P4) is cleanup and does not block phase 9.
One open balance question came out of §4: with turret fire no longer cracking objectives for
free, `turret-avoid` beats `turret-seek` on level 7 again (75% against 65%), so the case for
turrets on that level needs revisiting before phase 9 retunes it.

Phase 9 inherits a working per-level harness rather than building one, and extends the
campaign from twelve levels to twenty.

## 5. The probe grew up

Built in phase 5 rather than deferred to phase 9, because tuning twelve levels by hand was
not tractable without it. The probe now reports, alongside the endless strategy table:

- Per-level win rate across 40 seed variants under a reference strategy, flagged against a
  target. The shipped level is deterministic, so running its one stored seed returns 0% or
  100% and tells you nothing; what is measured is whether the template and difficulty put the
  level in band, and the stored seed is one draw from that band.
- A difficulty curve across the campaign, as a shape rather than a list of assertions.
- Per-enemy-type kill, contact and leak attribution, priced in bodies lost.

**The target is a ramp, not a flat band.** A first level that kills half the players who
reach it is a broken first level however well it sits inside 45–70%. The probe targets 95%
on level 1 falling to 50% on level 12, with a ±12 point tolerance; all twelve currently sit
inside it.

Two findings came straight out of using it:

- Scaling a burst's size by difficulty *and* its hp by difficulty *and* the tide rate by
  difficulty made the brute templates two to three times as steep as everything else, which
  read as those levels being mistuned rather than as brutes being hard. Bursts no longer
  scale with difficulty.
- Templates differ enough in how hard they respond to the difficulty dial that the raw
  scalars are not comparable between levels — `runner-rush` needs 1.30 for the same pressure
  `brute-wall` reaches at 0.67. The campaign's ramp is the win-rate column, not the
  difficulty column.

### What phase 7 needs it to measure

Three additions, each shaped the way phase 6's hazard claim eventually had to be — one
reference player against itself, differing in exactly one habit:

1. A turret-seeking strategy against `obj-light`. Same priorities, one extra detour. If the
   two cannot be told apart, a turret is not a decision.
2. `barricade-shoot` against `barricade-dodge`. Does breaking the wall beat threading the
   gap beside it? If dodging always wins, the hp is wrong; if shooting always wins, the wall
   is scenery.
3. Turret damage in the attribution table, so "a turret is a comeback tool" is a column
   rather than a hope.

**Two of phase 6's three hazard measurements were wrong before they were right, and both
wrong ones were plausible.** That is now a standing rule, not an anecdote: no phase 7 claim
about skill counts until it has survived the same treatment.

## 6. Risks

- ~~**Phase 4 invalidates the current balance.**~~ It did, and the probe re-derived it. The
  endless template preserves that tuning exactly, which is what let phase 5 start from a
  known-good curve instead of a blank one.
- **Exploders are the single largest cost in a run.** The attribution column prices them at
  ~42% of all bodies lost on an endless run, from a couple of leaks — brutes are the other
  39%, grunts only 14%. That is the intended shape (a leak should be frightening), but it
  means exploder weight is the most dangerous number in any level's mix.
- **Each level is a whole run's worth of pacing.** 77–91 seconds to clear, twelve times over.
  If the campaign is too long to sit through, the fix is shorter levels, not fewer.
- **Generated levels can feel samey.** Templates plus seeds trade authorial control for
  volume. If level 9 and level 14 play the same, the fix is more templates, not more seeds.
- **Lane shape may not be worth its complexity.** It measurably does not change difficulty,
  so it has to earn its place on how it looks and how it plays under the thumb. Hazards have
  since given a narrow lane something to do, but the pinch itself is still decoration.
- **Dodging a pit may simply be the wrong play.** Routing around one costs more win rate
  than the toll does (63% against 75%), so a player who learns to dodge perfectly is
  playing worse. That is a fine trade only if the margin is narrow enough to stay a
  judgement call; if hazards get harsher, dodging has to start winning.
- **Two of the three hazard measurements were wrong before they were right.** Both wrong
  ones were plausible and pointed opposite ways. Any future claim that a mechanic does or
  does not reward skill needs the same treatment: one player against itself, differing in
  exactly one habit.
- **Forks fight the spawn model.** Reds spawn biased toward the squad's column and the
  anchor clamps to one span; a fork means deciding what the swarm does on the path not
  taken. This is why forks are last and conditional.
- **A tuned win rate is not a fun level.** Every level now sits inside its target band, which
  says only that a scripted reference player clears it about as often as intended. Whether
  level 11 is *fun* is not something the probe can answer, and nothing but playtest will.
- **A breakable corridor is a mutable corridor.** Every line phase 6 wrote assumes the
  samples are baked at generation. Barricades are the one place phase 7 can break a system
  that currently works.
- ~~**A turret may simply be a weapon crate.**~~ It was, while it fired dead forward: the
  probe could not separate a turret level from a crate level and the answer was going to be
  to cut it. Aiming separated them. The risk it leaves behind is the opposite one — **a
  turret is only ever worth what standing next to it is worth.** Damage per second stops
  buying anything above ~800 for a player who does not detour, so any future attempt to make
  turrets matter more by raising their damage will measure as nothing.
- **Barricade hp is the dangerous number**, the way exploder weight is dangerous in a mix.
  Too low and the wall is scenery; too high and dodging is always correct and the wall is a
  pit with extra steps.
- **Phase 7 adds no pressure, only tools.** Every structure in it is net player-positive, so
  the levels that gain content will drift up the win-rate ramp and need their difficulty
  lifted. That lift has to come from the enemies — handing a level weaker gates to
  compensate would break the rule that a level's growth curve is the same every time.

## 7. Open question for the next playtest

**How long is one level, really?** Levels currently run 12,000–23,000 world units, which the
probe measures as 77–91 seconds for a winning run. That is a whole endless run's worth of
pacing per level, and twelve of them back to back may be more than anyone wants in one
sitting. The number to watch is not survival time any more — it is whether level 9 still
feels worth starting after level 8.

A second one, now that they exist: **do the templates read as different levels, or as the
same level at different densities?** `runner-rush` and `brute-wall` diverge on the probe's
leak column — 1.8% against 4.7% — but that is a measurement, not a feeling. If they play the
same, the fix is more templates, not more seeds.

A third, now that phase 7 has landed: **does a turret read as a different reward from a
crate?** The probe now says it changes the win rate — ten points on level 7, twenty-five on
level 9, between seeking one and avoiding it. It still cannot say whether a gun swinging onto
a red and stitching it down the lane *feels* like anything other than opening a box, and that
is the whole case for building it.
