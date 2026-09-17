import { Rng } from '../core/rng.js';
import { GATE_FIRST, GATE_SPACING, SCROLL_SPEED } from './config.js';
import { buildCorridor, Corridor, CorridorSpec, STRAIGHT } from './corridor.js';
import {
  BRUTE, ENEMY_KINDS, EnemyType, EXPLODER, enemyHp, GRUNT, mixAt, pickType, RUNNER,
} from './enemies.js';
import { buildGates, Gate } from './gates.js';
import {
  buildObjectives, Objective, OBJECTIVE_FIRST, OBJECTIVE_SPACING,
} from './objectives.js';

/**
 * Levels. A level is a `LevelDef` — a small bag of numbers — plus a template,
 * which is a pure function from that definition and its seed to a concrete list
 * of spawn events. Generation never reads `Math.random`: level 7 is level 7 on
 * every device and in every probe run, which is what makes a campaign tunable
 * at all.
 *
 * This replaces the old spawn director, which was a single quadratic in
 * distance with no way to say "twelve runners now, then a brute".
 */

export const TEMPLATES = [
  'tide', 'runner-rush', 'brute-wall', 'gauntlet', 'choke', 'endless',
] as const;
export type TemplateId = typeof TEMPLATES[number];

/** Spawn weights per archetype. Anything omitted never spawns on that level. */
export type EnemyMix = Partial<Record<EnemyType, number>>;

/**
 * One release of reds. `y` is the squad's position when the wave is let go, not
 * where the reds appear — they always enter ahead of the camera.
 */
export interface SpawnWave {
  readonly y: number;
  readonly type: EnemyType;
  readonly count: number;
  /** Baked at generation time, so the sim never re-derives difficulty. */
  readonly hp: number;
  /** Multiplier on the swarm's frontage: above 1 the wave arrives wide. */
  readonly spread: number;
}

/** Where gates and structures sit in a level. Counts fall out of its length. */
export interface StructureSpec {
  readonly gateFirst: number;
  readonly gateSpacing: number;
  readonly objectiveFirst: number;
  readonly objectiveSpacing: number;
}

export const DEFAULT_STRUCTURES: StructureSpec = {
  gateFirst: GATE_FIRST,
  gateSpacing: GATE_SPACING,
  objectiveFirst: OBJECTIVE_FIRST,
  objectiveSpacing: OBJECTIVE_SPACING,
};

export interface LevelDef {
  readonly id: number;
  readonly name: string;
  /** Stored, never derived from Math.random — level 7 must be level 7. */
  readonly seed: number;
  readonly template: TemplateId;
  /** Scalar on spawn rate and enemy hp. The campaign's difficulty dial. */
  readonly difficulty: number;
  /** World units to the finish line. Infinite for the endless baseline. */
  readonly length: number;
  readonly mix: EnemyMix;
  readonly structures: StructureSpec;
  /** Lane shape. Omitted means a straight full-width lane. */
  readonly corridor?: CorridorSpec;
}

/** Everything a `World` needs to run a level, generated once at construction. */
export interface LevelPlan {
  readonly waves: readonly SpawnWave[];
  readonly gates: Gate[];
  readonly objectives: Objective[];
  readonly finishY: number;
  readonly corridor: Corridor;
}

/**
 * How far the generator runs for a level with no finish line. Past any run the
 * probe measures (~190s at SCROLL_SPEED), so nothing falls off the end.
 */
export const ENDLESS_HORIZON = 46000;

/** Last stretch kept free of gates and crates, so no reward lands on the line. */
const FINISH_CLEARANCE = 1200;

/**
 * Reds per second at world distance `y`, at difficulty 1. This is the endless
 * director's own curve, kept verbatim so the campaign inherits tuning that
 * already plays rather than starting from nothing.
 */
export function baseRate(y: number): number {
  const u = y / 1000;
  return 1.15 + u * 2.95 + u * u * 0.55;
}

/**
 * Nominal seconds between waves. Wave size grows with the spawn rate rather
 * than wave spacing shrinking, so a late-level tide is a few hundred events
 * instead of tens of thousands. At 0.12s the squad advances 29 units between
 * waves, well inside the depth the reds are scattered over, so the tide reads
 * exactly as continuous as the old per-frame accumulator did.
 */
const WAVE_TICK = 0.12;

/** Safety valve: a pathological rate must not generate an unbounded list. */
const MAX_WAVES = 8000;

interface Burst {
  /** Cycled, so a gauntlet can alternate archetypes between bursts. */
  readonly types: readonly EnemyType[];
  /** Spacing as a fraction of the level. */
  readonly every: number;
  readonly count: number;
  /** How much the burst grows by the end of the level, as a fraction. */
  readonly growth: number;
  readonly spread: number;
}

interface Template {
  /** Multiplier on the baseline tide. Bursts are density too, so a template that has them runs thinner. */
  readonly tide: number;
  /** Rate multiplier across the level, sampled at `t` in 0..1. */
  readonly shape: (t: number) => number;
  /** Fraction of the level before an archetype first appears. */
  readonly intro: Partial<Record<EnemyType, number>>;
  readonly burst?: Burst;
  /** Overrides the level's own mix. Only the endless baseline uses it. */
  readonly weights?: (u: number, t: number, out: Float32Array) => void;
}

/** How long an archetype takes to reach its full weight once it has appeared. */
const INTRO_RAMP = 0.12;

const TEMPLATE_TABLE: Record<TemplateId, Template> = {
  /** The straight fight: a grunt tide with the specials easing in behind it. */
  tide: {
    tide: 1,
    shape: () => 1,
    intro: { [RUNNER]: 0.10, [EXPLODER]: 0.30, [BRUTE]: 0.38 },
  },

  /**
   * Runners arrive in packs on a tight cadence. The tide behind them is thin on
   * purpose: the threat is that a pack lands while you are lined up on a crate.
   */
  'runner-rush': {
    tide: 0.85,
    shape: () => 1,
    intro: { [RUNNER]: 0, [EXPLODER]: 0.45, [BRUTE]: 1 },
    burst: { types: [RUNNER], every: 0.13, count: 12, growth: 1.6, spread: 1.6 },
  },

  /**
   * Brutes in small walls. Each one soaks fire the tide would otherwise be
   * taking, so the decision is whether to spend on it or step around it.
   */
  'brute-wall': {
    tide: 0.82,
    shape: () => 1,
    intro: { [RUNNER]: 0.18, [EXPLODER]: 0.5, [BRUTE]: 0 },
    burst: { types: [BRUTE], every: 0.19, count: 2, growth: 0.8, spread: 0.7 },
  },

  /** Every archetype, early, alternating. The level that tests all of it. */
  gauntlet: {
    tide: 0.80,
    shape: () => 1,
    intro: { [RUNNER]: 0.04, [EXPLODER]: 0.12, [BRUTE]: 0.18 },
    burst: { types: [RUNNER, BRUTE, EXPLODER], every: 0.12, count: 5, growth: 1.1, spread: 1.2 },
  },

  /**
   * A pressure spike through the middle third, which the corridor now gives a
   * shape to travel through.
   *
   * The density is unchanged, and that is a finding rather than an oversight.
   * Halving it on the assumption that a narrowed lane would supply the missing
   * pressure made NARROWS markedly *easier* (48% -> 65% win rate), because
   * compression cuts three ways and only one of them favours the swarm: the
   * firing line narrows, but the crowd also gets deeper — so a red must run
   * further to break through — and the swarm's own frontage is derived from the
   * crowd's, so it arrives narrower and funnels into the guns. Net, a squeeze
   * protects the player.
   *
   * So the corridor is navigational and visual variety, not a difficulty dial.
   * Narrow sections get their teeth from hazards in phase 6b.
   */
  choke: {
    tide: 0.78,
    shape: (t) => (t > 0.34 && t < 0.68 ? 2.2 : 0.85),
    intro: { [RUNNER]: 0.08, [EXPLODER]: 0.34, [BRUTE]: 0.34 },
  },

  /**
   * The pre-campaign baseline: one endless run against the original mix curve.
   * Not shipped in the campaign — it is what the balance harness measures
   * against, so that a level's numbers can be read next to a known quantity.
   */
  endless: {
    tide: 1,
    shape: () => 1,
    intro: {},
    weights: (u, _t, out) => mixAt(u, out),
  },
};

/** The endless baseline as a level, so every caller has the same entry point. */
export function endlessLevel(seed: number): LevelDef {
  return {
    id: 0,
    name: 'ENDLESS',
    seed,
    template: 'endless',
    difficulty: 1,
    length: Number.POSITIVE_INFINITY,
    mix: { [GRUNT]: 1, [RUNNER]: 1, [BRUTE]: 1, [EXPLODER]: 1 },
    structures: DEFAULT_STRUCTURES,
  };
}

/** How far the generator runs: the finish line, or the endless horizon. */
function horizonOf(def: LevelDef): number {
  return Number.isFinite(def.length) ? def.length : ENDLESS_HORIZON;
}

function weightsFromMix(
  def: LevelDef,
  tpl: Template,
  t: number,
  out: Float32Array,
): void {
  out.fill(0);
  for (let type = 0; type < ENEMY_KINDS; type++) {
    const weight = def.mix[type as EnemyType] ?? 0;
    if (weight <= 0) continue;
    const intro = tpl.intro[type as EnemyType] ?? 0;
    if (t < intro) continue;
    // Eased in rather than switched on: an archetype that appears at full
    // weight the instant it unlocks reads as a spawn bug, not as escalation.
    out[type] = weight * Math.min(1, (t - intro) / INTRO_RAMP);
  }
  // Grunts are the floor. Without this a level whose specials have not yet
  // introduced would have no weights at all and spawn nothing.
  if (out[GRUNT] <= 0) out[GRUNT] = def.mix[GRUNT] ?? 1;
}

/**
 * The tide: a continuous flow whose density follows the level's rate curve.
 * Clumping is preserved from the old director — a wall of red reads better
 * than an even drizzle.
 */
function emitTide(def: LevelDef, tpl: Template, rng: Rng, out: SpawnWave[]): void {
  const horizon = horizonOf(def);
  const weights = new Float32Array(ENEMY_KINDS);
  let y = 0;
  while (y < horizon && out.length < MAX_WAVES) {
    const t = y / horizon;
    const u = y / 1000;
    const rate = Math.max(0.2, baseRate(y) * tpl.tide * tpl.shape(t) * def.difficulty);
    if (tpl.weights) tpl.weights(u, t, weights);
    else weightsFromMix(def, tpl, t, weights);
    const type = pickType(weights, rng.next()) as EnemyType;
    let count = Math.max(1, Math.round(rate * WAVE_TICK));
    if (rng.next() < 0.25) count *= 2;
    out.push({
      y,
      type,
      count,
      hp: enemyHp(type, u * def.difficulty),
      spread: 1,
    });
    y += (count / rate) * SCROLL_SPEED;
  }
}

/** Scripted packs on top of the tide: the "twelve runners, then a brute" part. */
function emitBursts(def: LevelDef, tpl: Template, rng: Rng, out: SpawnWave[]): void {
  const burst = tpl.burst;
  if (!burst) return;
  const horizon = horizonOf(def);
  const step = burst.every * horizon;
  let i = 0;
  for (let y = step; y < horizon && out.length < MAX_WAVES; y += step, i++) {
    const t = y / horizon;
    const type = burst.types[i % burst.types.length] as EnemyType;
    // Deliberately not scaled by difficulty: the level's scalar already lifts
    // the tide rate and every enemy's hp, and multiplying a third term by it
    // made the brute templates two to three times as steep as the rest, which
    // read as those levels being mistuned rather than as brutes being hard.
    const count = Math.max(1, Math.round(burst.count * (1 + burst.growth * t)));
    out.push({
      // Jittered so a burst never lands on exactly the same stride as a gate.
      y: y + rng.range(-step * 0.15, step * 0.15),
      type,
      count,
      hp: enemyHp(type, (y / 1000) * def.difficulty),
      spread: burst.spread,
    });
  }
}

/**
 * Generates a level. Pure in everything but the definition and its seed, so the
 * result is reproducible, diffable and measurable by the probe.
 *
 * The plan carries its own RNG stream, separate from the one the running sim
 * uses for spawn jitter: level content and runtime noise are different things,
 * and mixing them makes a content change perturb every shot fired afterwards.
 */
export function buildLevel(def: LevelDef): LevelPlan {
  const tpl = TEMPLATE_TABLE[def.template];
  const rng = new Rng((def.seed ^ 0x9e3779b9) >>> 0);

  const waves: SpawnWave[] = [];
  emitTide(def, tpl, rng, waves);
  emitBursts(def, tpl, rng, waves);
  waves.sort((a, b) => a.y - b.y);

  const horizon = horizonOf(def);
  // Structures stop short of the line: a gate you take two seconds before the
  // level ends is a reward with nothing left to spend it on.
  const usable = Math.max(0, horizon - FINISH_CLEARANCE);
  const s = def.structures;
  const gateCount = usable > s.gateFirst
    ? Math.floor((usable - s.gateFirst) / s.gateSpacing) + 1
    : 0;
  const objectiveCount = usable > s.objectiveFirst
    ? Math.floor((usable - s.objectiveFirst) / s.objectiveSpacing) + 1
    : 0;

  // Built before the structures, because where a gate or a crate can sit is a
  // question about the lane at that point rather than about the lane's width.
  const corridor = buildCorridor(def.corridor ?? STRAIGHT, horizon);

  const gates = buildGates(rng, gateCount, s.gateFirst, s.gateSpacing, corridor);
  // Nudging an objective clear of a gate can push it past where it was meant to
  // sit, and anything past the line is content the player can never reach — or,
  // worse, a crate drawn on the far side of a finished level.
  const objectives = buildObjectives(
    rng,
    objectiveCount,
    gates.map((g) => g.y),
    s.objectiveFirst,
    s.objectiveSpacing,
    corridor,
  ).filter((o) => o.y < usable);

  return { waves, gates, objectives, finishY: def.length, corridor };
}
