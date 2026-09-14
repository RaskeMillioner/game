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
 * Multiplier boards never "break": damage charges them, and the multiplier they
 * are holding when you pass is what you get. Rewards committing hard rather
 * than landing one shot.
 */
export function multiplierOf(o: Objective): number {
  if (o.kind !== 'multiplier') return 1;
  const t = Math.min(1, 1 - o.hp / o.maxHp);
  return 1 + t * (o.value - 1);
}

/**
 * What this structure gives you, as the player needs to read it: the weapon it
 * actually grants rather than "+1 tier", the bodies it frees, or the multiplier
 * the board is currently holding.
 */
export function objectiveLabel(o: Objective, weaponTier: number): string {
  switch (o.kind) {
    case 'weapon':
      return WEAPONS[Math.min(WEAPONS.length - 1, weaponTier + o.value)].name;
    case 'recruit':
      return `+${o.value}`;
    case 'multiplier':
      return `\u00d7${multiplierOf(o).toFixed(1)}`;
  }
}

/** Short caption naming the structure type, drawn under the value. */
export function objectiveCaption(o: Objective): string {
  switch (o.kind) {
    case 'weapon': return 'WEAPON';
    case 'recruit': return 'RECRUITS';
    case 'multiplier': return 'BOOST';
  }
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
export function buildObjectives(rng: Rng, count: number, gateYs: readonly number[] = []): Objective[] {
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
    const kind: ObjectiveKind = i % 3 === 0 ? 'weapon' : i % 3 === 1 ? 'multiplier' : 'recruit';
    const side = rng.next() < 0.5 ? 0.22 : 0.78;
    const hp = kind === 'multiplier' ? 420 + i * 330 : 240 + i * 240;
    const value = kind === 'weapon' ? 1 : kind === 'recruit' ? 40 + i * 30 : 3;
    out.push({
      kind,
      x: LANE_W * side,
      y: clearOfGates(OBJECTIVE_FIRST + i * OBJECTIVE_SPACING),
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
