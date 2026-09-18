import { Rng } from '../core/rng.js';
import { LANE_W, MAX_BLUE, WEAPONS } from './config.js';
import { centreAt, Corridor, halfWidthAt } from './corridor.js';
import { clearOfHole } from './gates.js';

export type ObjectiveKind = 'weapon' | 'recruit' | 'turret';

/**
 * A shootable structure in the lane. Objectives compete with the swarm for the
 * squad's fire: because the squad shoots straight ahead, hitting one means
 * standing in front of it while the reds keep closing.
 */
export interface Objective {
  readonly kind: ObjectiveKind;
  readonly x: number;
  readonly y: number;
  readonly maxHp: number;
  /** Weapon tiers granted, or bodies freed, depending on kind. */
  readonly value: number;
  hp: number;
  broken: boolean;
  /** Set to 1 on the frame it breaks, decays after, so the renderer can pop it. */
  flash: number;
  /** True once the squad has passed it and its reward has been settled. */
  resolved: boolean;
  /** True only if the reward was actually taken, as opposed to left behind. */
  collected: boolean;
  /** Firing accumulator for turrets; unused on other kinds. */
  fireTimer: number;
}

export const OBJECTIVE_W = 132;
export const OBJECTIVE_H = 96;
/**
 * Offset so objectives land midway between gates rather than on top of them.
 * Stacked in the same stretch of lane they compete for the same glance and the
 * player cannot read either in time.
 */
export const OBJECTIVE_FIRST = 900;
/** Objectives are kept this far from any gate so the two never compete for one glance. */
export const MIN_GATE_GAP = 750;
export const OBJECTIVE_SPACING = 1750;

/**
 * What this structure gives you, as the player needs to read it: the weapon it
 * actually grants rather than "+1 tier", or the bodies it frees.
 */
export function objectiveLabel(o: Objective, weaponTier: number): string {
  switch (o.kind) {
    case 'weapon':
      return WEAPONS[Math.min(WEAPONS.length - 1, weaponTier + o.value)].name;
    case 'recruit':
      return `+${o.value}`;
    case 'turret':
      return o.broken ? 'ACTIVE' : 'FLIP IT';
  }
}

/** Short caption naming the structure type, drawn under the value. */
export function objectiveCaption(o: Objective): string {
  switch (o.kind) {
    case 'weapon': return 'WEAPON';
    case 'recruit': return 'RECRUITS';
    case 'turret': return 'TURRET';
  }
}

export function damageObjective(o: Objective, amount: number): void {
  if (o.broken) return;
  o.hp -= amount;
  if (o.hp <= 0) {
    o.hp = 0;
    o.broken = true;
    o.flash = 1;
  }
}

/**
 * Settles a passed objective. Breaking a crate open is only half of it: the gun
 * lies where it fell, so the crowd has to actually run over it. Passing by in
 * the lane leaves it behind, which makes taking one a positioning decision
 * rather than an automatic reward for shooting.
 */
export function collectObjective(
  o: Objective,
  count: number,
  weaponTier: number,
  overlapped: boolean,
): { count: number; weaponTier: number } {
  o.resolved = true;
  if (!o.broken) return { count, weaponTier };
  switch (o.kind) {
    case 'weapon':
      if (!overlapped) return { count, weaponTier };
      o.collected = true;
      return { count, weaponTier: Math.min(WEAPONS.length - 1, weaponTier + o.value) };
    case 'recruit':
      o.collected = true;
      return { count: Math.min(MAX_BLUE, count + o.value), weaponTier };
    case 'turret':
      o.collected = true;
      return { count, weaponTier };
  }
}

/** Half-width of the band in which the crowd sweeps up a fallen pickup. */
export const PICKUP_PAD = 24;

/**
 * Objectives are offset to one side of the lane on purpose: lining one up means
 * leaving the position where your fire covers the swarm.
 */
export function buildObjectives(
  rng: Rng,
  count: number,
  gateYs: readonly number[] = [],
  first: number = OBJECTIVE_FIRST,
  spacing: number = OBJECTIVE_SPACING,
  corridor?: Corridor,
): Objective[] {
  const out: Objective[] = [];
  /** Pushes an objective clear of any gate it would otherwise sit on top of. */
  const clearOfGates = (y: number): number => {
    for (const gy of gateYs) {
      const gap = y - gy;
      if (gap > -MIN_GATE_GAP && gap < MIN_GATE_GAP) {
        return gap < 0 ? gy - MIN_GATE_GAP : gy + MIN_GATE_GAP;
      }
    }
    return y;
  };
  for (let i = 0; i < count; i++) {
    // Weapons are now the only route to a better gun, so crates alternate with
    // pods rather than competing with a third structure for lane space.
    const kind: ObjectiveKind = i % 3 === 0 ? 'weapon' : 'recruit';
    const side = rng.next() < 0.5 ? -1 : 1;
    const hp = 240 + i * 240;
    const value = kind === 'weapon' ? 1 : 55 + i * 48;
    const y = clearOfGates(first + i * spacing);
    // Offset to one side of the lane it actually stands in. On a straight lane
    // 0.56 of the half-width is LANE_W * 0.22 and * 0.78 exactly, so this is
    // unchanged there; in a pinch it stays reachable instead of sitting in the
    // wall.
    const centre = corridor ? centreAt(corridor, y) : LANE_W / 2;
    const half = corridor ? halfWidthAt(corridor, y) : LANE_W / 2;
    const x = corridor
      ? clearOfHole(corridor, y, centre + side * half * 0.56, OBJECTIVE_W / 2, centre, half)
      : centre + side * half * 0.56;
    out.push({
      kind,
      x,
      y,
      maxHp: hp,
      hp,
      value,
      broken: false,
      flash: 0,
      resolved: false,
      collected: false,
      fireTimer: 0,
    });
  }
  return out;
}

/**
 * Builds turret objectives: shootable structures that fire for the squad once
 * flipped. Same placement logic as `buildObjectives`, but a different kind and
 * a fixed HP budget that does not scale with level count.
 */
export function buildTurrets(
  rng: Rng,
  count: number,
  first: number,
  spacing: number,
  gateYs: readonly number[] = [],
  corridor?: Corridor,
): Objective[] {
  const out: Objective[] = [];
  const clearOfGates = (y: number): number => {
    for (const gy of gateYs) {
      const gap = y - gy;
      if (gap > -MIN_GATE_GAP && gap < MIN_GATE_GAP) {
        return gap < 0 ? gy - MIN_GATE_GAP : gy + MIN_GATE_GAP;
      }
    }
    return y;
  };
  for (let i = 0; i < count; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const y = clearOfGates(first + i * spacing);
    const centre = corridor ? centreAt(corridor, y) : LANE_W / 2;
    const half = corridor ? halfWidthAt(corridor, y) : LANE_W / 2;
    const x = corridor
      ? clearOfHole(corridor, y, centre + side * half * 0.56, OBJECTIVE_W / 2, centre, half)
      : centre + side * half * 0.56;
    out.push({
      kind: 'turret',
      x,
      y,
      maxHp: 320,
      hp: 320,
      value: 0,
      broken: false,
      flash: 0,
      resolved: false,
      collected: false,
      fireTimer: 0,
    });
  }
  return out;
}
