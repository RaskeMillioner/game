import { Rng } from '../core/rng.js';
import { GATE_FIRST, GATE_SPACING, LANE_W, MAX_BLUE, WEAPONS } from './config.js';

export type GateKind = 'mul' | 'add' | 'sub' | 'div' | 'weapon';

export interface GateOp {
  readonly kind: GateKind;
  readonly value: number;
}

export interface Gate {
  readonly y: number;
  /** Centre of the single panel. */
  readonly cx: number;
  readonly op: GateOp;
  taken: boolean;
}

/** Half-width of a gate panel. Narrow enough that a gate is easy to slip past. */
export const GATE_PANEL_W = 95;

/**
 * Whether the squad is passing through the panel. A gate offers one thing, so
 * the decision is take it or dodge it: a bad gate is a hazard to steer around
 * rather than the lesser half of a forced choice.
 */
export function gateHit(gate: Gate, x: number): boolean {
  const d = x - gate.cx;
  return d > -GATE_PANEL_W && d < GATE_PANEL_W;
}

export function gateLabel(op: GateOp): string {
  switch (op.kind) {
    case 'mul': return `×${op.value}`;
    case 'div': return `÷${op.value}`;
    case 'add': return `+${op.value}`;
    case 'sub': return `−${op.value}`;
    case 'weapon': return WEAPONS[op.value].name;
  }
}

export function gateIsGood(op: GateOp): boolean {
  return op.kind !== 'sub' && op.kind !== 'div';
}

/**
 * Applies a gate. Returns the new squad count; weapon gates leave the count alone
 * and are reported through `weaponTier`.
 */
export function applyGate(op: GateOp, count: number): { count: number; weaponTier: number | null } {
  switch (op.kind) {
    case 'mul': return { count: Math.min(MAX_BLUE, Math.floor(count * op.value)), weaponTier: null };
    case 'div': return { count: Math.max(0, Math.floor(count / op.value)), weaponTier: null };
    case 'add': return { count: Math.min(MAX_BLUE, count + op.value), weaponTier: null };
    case 'sub': return { count: Math.max(0, count - op.value), weaponTier: null };
    case 'weapon': return { count, weaponTier: op.value };
  }
}

/**
 * Builds the gate sequence for a run. Weapon gates are placed on a fixed cadence
 * so the escalation is authored, not left to luck; the rest are count choices
 * where one side is meaningfully better than the other.
 */
export function buildGates(rng: Rng, count: number): Gate[] {
  const gates: Gate[] = [];
  let tier = 1;
  for (let i = 0; i < count; i++) {
    const y = GATE_FIRST + i * GATE_SPACING;
    let op: GateOp;

    const roll = rng.next();
    // The opening gate is never a hazard. With one option per gate there is no
    // second door to take instead, and a flat subtraction on a starting squad
    // is simply an unavoidable death two seconds in.
    const hazardChance = i === 0 ? 0 : Math.min(0.34, 0.10 + i * 0.04);
    if (i > 0 && i % 3 === 2 && tier < WEAPONS.length) {
      op = { kind: 'weapon', value: tier };
      tier++;
    } else if (roll < hazardChance) {
      // Hazards stay proportional rather than absolute: a division always
      // hurts in step with what you have, where a fixed subtraction is
      // trivial when large and lethal when small.
      op = rng.next() < 0.6
        ? { kind: 'div', value: 2 }
        : { kind: 'sub', value: 25 + i * 30 };
    } else if (roll < 0.72) {
      op = { kind: 'mul', value: rng.next() < 0.3 ? 4 : 3 };
    } else {
      op = { kind: 'add', value: 95 + i * 85 };
    }

    // The opening gate sits dead centre: a player who has not yet learned that
    // gates are dodgeable should not lose the run to missing the first one.
    const cx = i === 0 ? LANE_W / 2 : LANE_W / 2 + rng.range(-135, 135);
    gates.push({ y, cx, op, taken: false });
  }
  return gates;
}

export const GATE_MID = LANE_W / 2;
