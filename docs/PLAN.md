# RED TIDE — Development Plan

A one-thumb iPhone game: a swarm of red stickmen sprints at your blue squad. Your squad
auto-fires forward, grows through gates and shootable structures, and every red that gets
past the line takes a body with it.

Revised after the first playtests. The original plan described a top-down auto-runner with
paired gates as the central decision; almost none of that survived contact with play, and
this document describes what the game actually is and where it goes next.

Phases 4 and 5 are built. The game is a twelve-level campaign, not one endless run.

## 1. Where the code is

Playable and deployed at `raskemillioner.github.io/game/`. 34 kB, 12 kB gzipped, no runtime dependencies.

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
| Balance harness | Headless seeded probe: strategy survival, per-type attribution, and per-level win rate against a target ramp; 48 tests |

**Not built:** corridor shape, hazards, new structure kinds, bosses, audio, juice.

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
3. **The lane is a constant.** `LANE_W = 720` is still baked into the sim, the clamp,
   spawning and the renderer. Nothing can narrow, bend or fork. This is phase 6.

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

### Corridor

`LANE_W` stays fixed at 720 as the virtual coordinate space. Lane *shape* becomes a
separate corridor function over `worldY` returning one or more drivable spans. The anchor
clamp, red spawning and the renderer's ground edges all read the corridor instead of the
constant. Narrowing and bends fall out of this directly; forks need the corridor to return
a list of spans rather than one, which is the only genuinely awkward part.

## 4. Phases

| # | Phase | Output | Owner |
|---|---|---|---|
| 4 | ~~Enemy types~~ | **Done.** Per-unit HP, damage-pool bullets, grunt/runner/brute/exploder, per-type batching | Me |
| 5 | ~~Level system~~ | **Done.** `LevelDef`, template generators, finish line, win/lose, level select, campaign flow | Split |
| 6 | Corridor + hazards | Corridor over worldY, narrowing and bends, static hazards that split the crowd | Me |
| 7 | Structures | New objective kinds: turrets to free, barricades that must be broken to pass | Sonnet |
| 8 | Juice + audio | Screen shake, hit flash, damage popups, synthesized SFX, no audio files | Sonnet |
| 9 | Content pass | 20 levels generated, measured and tuned against the probe | Me |
| 10 | Forks | Corridor returning multiple spans; only if levels feel same-y without it | Me |

**Phase 6 is next.** The lane is the last of the three hardcoded things, and `choke` is
currently a density spike standing in for geometry it does not have yet.

Phase 9 now inherits a working per-level harness rather than building one, and extends the
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
- **Forks fight the spawn model.** Reds spawn biased toward the squad's column and the
  anchor clamps to one span; a fork means deciding what the swarm does on the path not
  taken. This is why forks are last and conditional.
- **A tuned win rate is not a fun level.** Every level now sits inside its target band, which
  says only that a scripted reference player clears it about as often as intended. Whether
  level 11 is *fun* is not something the probe can answer, and nothing but playtest will.

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
