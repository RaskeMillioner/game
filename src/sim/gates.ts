import { Rng } from '../core/rng.js';
import { GATE_FIRST, GATE_SPACING, LANE_W, MAX_BLUE, WEAPONS } from './config.js';

export type GateKind = 'mul' | 'add' | 'sub' | 'div' | 'weapon';

export interface GateOp {
  readonly kind: GateKind;
  readonly value: number;
}

export interface Gate {
  readonly y: number;
  readonly left: GateOp;
  readonly right: GateOp;
  taken: boolean;
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
    let left: GateOp;
    let right: GateOp;

    if (i > 0 && i % 3 === 2 && tier < WEAPONS.length) {
      // Weapon vs. bodies: the choice the whole game is built around.
      const bodies = 25 + i * 12;
      left = { kind: 'weapon', value: tier };
      right = { kind: 'add', value: bodies };
      tier++;
    } else if (rng.next() < Math.min(0.62, 0.12 + i * 0.06)) {
      // A real trap: one side actively costs you.
      left = { kind: 'mul', value: 2 };
      right = rng.next() < 0.5
        ? { kind: 'sub', value: 15 + i * 8 }
        : { kind: 'div', value: 2 };
    } else {
      left = { kind: 'mul', value: rng.next() < 0.25 ? 3 : 2 };
      right = { kind: 'add', value: 20 + i * 15 };
    }

    if (rng.next() < 0.5) [left, right] = [right, left];
    gates.push({ y, left, right, taken: false });
  }
  return gates;
}

export const GATE_MID = LANE_W / 2;
