import { Rng } from '../core/rng.js';
import { LANE_W, MAX_BLUE, WEAPONS } from './config.js';

export type ObjectiveKind = 'weapon' | 'recruit';

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
  }
}

/** Short caption naming the structure type, drawn under the value. */
export function objectiveCaption(o: Objective): string {
  switch (o.kind) {
    case 'weapon': return 'WEAPON';
    case 'recruit': return 'RECRUITS';
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
    // Weapons are now the only route to a better gun, so crates alternate with
    // pods rather than competing with a third structure for lane space.
    const kind: ObjectiveKind = i % 3 === 0 ? 'weapon' : 'recruit';
    const side = rng.next() < 0.5 ? 0.22 : 0.78;
    const hp = 240 + i * 240;
    const value = kind === 'weapon' ? 1 : 55 + i * 48;
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
