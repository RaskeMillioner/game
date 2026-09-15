# RED TIDE — Development Plan

A one-thumb iPhone game: a swarm of red stickmen sprints at your blue squad. Your squad
auto-fires forward, grows through gates and shootable structures, and every red that gets
past the line takes a body with it.

Revised after the first playtests. The original plan described a top-down auto-runner with
paired gates as the central decision; almost none of that survived contact with play, and
this document describes what the game actually is and where it goes next.

## 1. Where the code is

Playable and deployed at `raskemillioner.github.io/game/`. 16 kB, no runtime dependencies.

| Built | Notes |
|---|---|
| Third-person perspective | Ground-plane pinhole projection, camera behind and above; sim stays 2D |
| Crowd steering | Phyllotaxis formation, per-slot follow lag, relative one-thumb drag |
| Crowd combat | Emitter-capped fixed-forward fire, spatial hash, batched Path2D rendering |
| Red pursuit | Reds intercept the squad; leak rate under 1% for good play |
| Breakthrough attrition | A red that crosses behind the crowd kills one blue and dies |
| Gates | Single-option, narrow, missable; take it or dodge it |
| Objectives | Weapon crates and recruit pods, shot while the swarm closes |
| Balance harness | Headless seeded probe, 60 runs per strategy; 15 sim tests |

**Not built:** levels, win condition, enemy variety, bosses, hazards, audio, juice, menus.
Everything today is one endless run against one enemy type.

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

Three things are hardcoded that the next phase needs to be data:

1. **One enemy type.** Reds are a struct-of-arrays with position and speed. No type, no HP.
2. **Waves are a formula.** `Director.rate()` is a quadratic in distance. There is no way to
   say "twelve runners at four seconds, then a brute".
3. **The lane is a constant.** `LANE_W = 720` is baked into the sim, the clamp, spawning
   and the renderer. Nothing can narrow, bend or fork.

### Enemy types

Add `redType: Uint8Array` and `redHp: Float32Array` alongside the existing arrays, with a
static per-type table: hp, speed range, contact cost, radius, shade.

| Type | HP | Speed | Cost on contact | Role |
|---|---|---|---|---|
| Grunt | 1 | 110–155 | 1 blue | The tide. What exists today |
| Runner | 1 | 260–320 | 1 blue | Arrives early and punishes a player lined up on a crate |
| Brute | 40–200 | 70–90 | 6 blue | Soaks the line; decide whether to spend fire on it or reposition |
| Exploder | 2 | 150–190 | 8 blue | Makes a leak frightening rather than a slow drip |

The damage model changes with it: a bullet's `pierce` budget becomes a damage pool, and each
red consumes `min(hp, remaining)`. For 1-HP enemies that is identical to today's behaviour,
so grunts are unaffected and the change is backward-compatible.

Rendering stays batched — one `Path2D` per type rather than per unit, so four fills instead
of one. Overlap within a type is still invisible, so still no depth sort.

### Levels

```ts
interface LevelDef {
  id: number;
  name: string;
  seed: number;          // stored, never derived from Math.random — level 7 must be level 7
  template: TemplateId;  // 'tide' | 'runner-rush' | 'brute-wall' | 'gauntlet' | 'choke'
  difficulty: number;    // scalar driving spawn rate and enemy HP
  length: number;        // world units to the finish line
  mix: Partial<Record<EnemyType, number>>;  // spawn weights
  corridor: CorridorSpec;
  hazards: HazardSpec;
  structures: StructureSpec;
}
```

A template is a pure function `(spec, seed) -> concrete event list`. Generation is
deterministic, so a level is reproducible, diffable, and measurable by the probe. Levels end
at a finish line rather than in death; reaching it completes the level.

### Corridor

`LANE_W` stays fixed at 720 as the virtual coordinate space. Lane *shape* becomes a
separate corridor function over `worldY` returning one or more drivable spans. The anchor
clamp, red spawning and the renderer's ground edges all read the corridor instead of the
constant. Narrowing and bends fall out of this directly; forks need the corridor to return
a list of spans rather than one, which is the only genuinely awkward part.

## 4. Phases

| # | Phase | Output | Owner |
|---|---|---|---|
| 4 | Enemy types | Per-unit HP, damage-pool bullets, grunt/runner/brute/exploder, per-type batching | Me |
| 5 | Level system | `LevelDef`, template generators, finish line, win/lose, level select, campaign flow | Split |
| 6 | Corridor + hazards | Corridor over worldY, narrowing and bends, static hazards that split the crowd | Me |
| 7 | Structures | New objective kinds: turrets to free, barricades that must be broken to pass | Sonnet |
| 8 | Juice + audio | Screen shake, hit flash, damage popups, synthesized SFX, no audio files | Sonnet |
| 9 | Content pass | 20 levels generated, measured and tuned against the probe | Me |
| 10 | Forks | Corridor returning multiple spans; only if levels feel same-y without it | Me |

**Phase 4 is the gate on everything else.** Enemy variety is what makes a level feel
different; corridors and hazards are dressing on top of it. If brutes and exploders do not
change how a run plays, more level machinery will not help.

## 5. The probe has to grow up

Today the probe measures one endless run across six strategies. For a campaign it needs to
answer a different question: *is level 12 tuned?*

- Per-level win rate across N seeds for a reference strategy, flagging any level outside a
  target band (roughly 45–70% for a competent player).
- A difficulty curve across the campaign, so the ramp is visible as a shape rather than
  asserted level by level.
- Per-enemy-type kill and leak attribution, so "exploders are what is killing people on
  level 9" is a measurement rather than a guess.

This is the only reason tuning 20 levels is tractable at all. It is worth building properly
at the start of phase 9 rather than bolted on at the end.

## 6. Risks

- **Phase 4 invalidates the current balance.** Per-unit HP changes what a bullet is worth,
  so every number tuned so far gets re-derived. Expected, and cheap because the probe is
  headless — but it means no tuning effort before phase 4 is worth much.
- **Exploders may be too swingy.** 8 bodies per leak against a 40-strong squad is a quarter
  of the run gone in one mistake. Needs its own probe column from the day it lands.
- **Generated levels can feel samey.** Templates plus seeds trade authorial control for
  volume. If level 9 and level 14 play the same, the fix is more templates, not more seeds.
- **Forks fight the spawn model.** Reds spawn biased toward the squad's column and the
  anchor clamps to one span; a fork means deciding what the swarm does on the path not
  taken. This is why forks are last and conditional.
- **Difficulty is still the hard part, not the code.** Everything above is tractable
  engineering. Whether level 11 is fun is not, and only playtest answers it.

## 7. Open question for the next playtest

Run length is currently ~85s for strong play, down from 120s before boost boards were
removed. Once levels exist this stops mattering as a single number — each level sets its own
length — but it is the first thing phase 9 has to decide: how long is one level, really?
