/**
 * Enemy archetypes. Deliberately no ranged type: a crowd cannot dodge, so an
 * enemy that kills at range turns squad size from a resource into a liability
 * and breaks the fantasy the game is built on.
 */
export const GRUNT = 0;
export const RUNNER = 1;
export const BRUTE = 2;
export const EXPLODER = 3;
export const ENEMY_KINDS = 4;

export interface EnemyStats {
  readonly name: string;
  /** Base hit points before the distance scaling below. */
  readonly hp: number;
  /**
   * How hard hp grows with distance travelled, in km. Squad DPS scales linearly
   * with squad size, which itself compounds through the run, so a flat hp value
   * is a wall for ten seconds and then confetti.
   */
  readonly hpGrowth: number;
  readonly speedMin: number;
  readonly speedMax: number;
  /** Blues lost when this reaches the crowd or breaks through it. */
  readonly cost: number;
  readonly radius: number;
  /** Drawing: body scale and head scale relative to a grunt, plus fill colour. */
  readonly bodyScale: number;
  readonly headScale: number;
  readonly color: string;
}

export const ENEMIES: readonly EnemyStats[] = [
  {
    name: 'GRUNT',
    hp: 1, hpGrowth: 0,
    speedMin: 110, speedMax: 155,
    cost: 1, radius: 9,
    bodyScale: 1, headScale: 1, color: '#ff3b47',
  },
  {
    name: 'RUNNER',
    hp: 1, hpGrowth: 0,
    speedMin: 250, speedMax: 310,
    cost: 1, radius: 8,
    bodyScale: 0.78, headScale: 0.85, color: '#ff7d6b',
  },
  {
    name: 'BRUTE',
    hp: 34, hpGrowth: 5.5,
    speedMin: 70, speedMax: 92,
    cost: 4, radius: 19,
    bodyScale: 2.1, headScale: 1.9, color: '#a8202c',
  },
  {
    name: 'EXPLODER',
    hp: 2, hpGrowth: 0.6,
    speedMin: 150, speedMax: 195,
    cost: 5, radius: 11,
    // A big head on a small body: the silhouette has to read as "do not let
    // this one through" at a glance, without leaving the red palette.
    bodyScale: 0.9, headScale: 1.85, color: '#ff5a2e',
  },
];

export function enemyHp(type: number, km: number): number {
  const e = ENEMIES[type];
  return e.hp + e.hpGrowth * km * km;
}

/**
 * Spawn weights at a given distance. The tide is grunts; runners arrive early
 * to punish a player parked on a crate, exploders and brutes later once the
 * crowd is big enough for their costs to be survivable.
 */
export function mixAt(km: number, out: Float32Array): void {
  out[GRUNT] = 1;
  out[RUNNER] = km < 0.7 ? 0 : Math.min(0.34, (km - 0.7) * 0.22);
  out[EXPLODER] = km < 2.2 ? 0 : Math.min(0.09, (km - 2.2) * 0.04);
  out[BRUTE] = km < 3.2 ? 0 : Math.min(0.055, (km - 3.2) * 0.02);
}

/** Picks a type from weights. `roll` is a uniform value in [0, 1). */
export function pickType(weights: Float32Array, roll: number): number {
  let total = 0;
  for (let i = 0; i < ENEMY_KINDS; i++) total += weights[i];
  let t = roll * total;
  for (let i = 0; i < ENEMY_KINDS; i++) {
    t -= weights[i];
    if (t <= 0) return i;
  }
  return GRUNT;
}
