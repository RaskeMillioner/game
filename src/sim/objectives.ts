import { Rng } from '../core/rng.js';
import { LANE_W, MAX_BLUE, WEAPONS } from './config.js';

export type ObjectiveKind = 'weapon' | 'recruit' | 'multiplier';

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
  /** Weapon tier granted, bodies freed, or peak multiplier depending on kind. */
  readonly value: number;
  hp: number;
  broken: boolean;
  /** Set to 1 on the frame it breaks, decays after, so the renderer can pop it. */
  flash: number;
  /** True once the squad has passed it and its reward has been settled. */
  resolved: boolean;
}

export const OBJECTIVE_W = 132;
export const OBJECTIVE_H = 96;
export const OBJECTIVE_FIRST = 900;
export const OBJECTIVE_SPACING = 1900;

/**
 * Multiplier boards never "break": damage charges them, and the multiplier they
 * are holding when you pass is what you get. Rewards committing hard rather
 * than landing one shot.
 */
export function multiplierOf(o: Objective): number {
  if (o.kind !== 'multiplier') return 1;
  const t = Math.min(1, 1 - o.hp / o.maxHp);
  return 1 + t * (o.value - 1);
}

export function damageObjective(o: Objective, amount: number): void {
  if (o.broken) return;
  o.hp -= amount;
  if (o.hp <= 0) {
    o.hp = 0;
    if (o.kind !== 'multiplier') {
      o.broken = true;
      o.flash = 1;
    }
  }
}

/** Applies a passed objective's reward. Returns the new count and weapon tier. */
export function collectObjective(
  o: Objective,
  count: number,
  weaponTier: number,
): { count: number; weaponTier: number } {
  o.resolved = true;
  switch (o.kind) {
    case 'weapon':
      return o.broken
        ? { count, weaponTier: Math.min(WEAPONS.length - 1, weaponTier + o.value) }
        : { count, weaponTier };
    case 'recruit':
      return o.broken
        ? { count: Math.min(MAX_BLUE, count + o.value), weaponTier }
        : { count, weaponTier };
    case 'multiplier':
      return { count: Math.min(MAX_BLUE, Math.floor(count * multiplierOf(o))), weaponTier };
  }
}

/**
 * Objectives are offset to one side of the lane on purpose: lining one up means
 * leaving the position where your fire covers the swarm.
 */
export function buildObjectives(rng: Rng, count: number): Objective[] {
  const out: Objective[] = [];
  for (let i = 0; i < count; i++) {
    const kind: ObjectiveKind = i % 3 === 0 ? 'weapon' : i % 3 === 1 ? 'multiplier' : 'recruit';
    const side = rng.next() < 0.5 ? 0.22 : 0.78;
    const hp = kind === 'multiplier' ? 300 + i * 200 : 165 + i * 125;
    const value = kind === 'weapon' ? 1 : kind === 'recruit' ? 40 + i * 30 : 3;
    out.push({
      kind,
      x: LANE_W * side,
      y: OBJECTIVE_FIRST + i * OBJECTIVE_SPACING,
      maxHp: hp,
      hp,
      value,
      broken: false,
      flash: 0,
      resolved: false,
    });
  }
  return out;
}
