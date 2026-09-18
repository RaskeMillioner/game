import { Rng } from '../core/rng.js';
import { GATE_FIRST, GATE_SPACING, LANE_W, MAX_BLUE } from './config.js';
import { centreAt, Corridor, halfWidthAt, holeCentreAt, holeHalfWidthAt } from './corridor.js';

export type GateKind = 'mul' | 'add' | 'sub' | 'div';

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

/** How far either side of the lane's centre a gate may sit, room permitting. */
export const GATE_DRIFT = 135;

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
  }
}

/**
 * Builds the gate sequence for a level. The ramp is indexed within the level,
 * not across the campaign: every level starts at 16 blue with a pistol, so the
 * growth curve inside a level has to be the same one every time for its
 * difficulty to mean anything.
 */
export function buildGates(
  rng: Rng,
  count: number,
  first: number = GATE_FIRST,
  spacing: number = GATE_SPACING,
  corridor?: Corridor,
): Gate[] {
  const gates: Gate[] = [];
  for (let i = 0; i < count; i++) {
    const y = first + i * spacing;
    let op: GateOp;

    const roll = rng.next();
    // The opening gate is never a hazard. With one option per gate there is no
    // second door to take instead, and a flat subtraction on a starting squad
    // is simply an unavoidable death two seconds in.
    const hazardChance = i === 0 ? 0 : Math.min(0.34, 0.10 + i * 0.04);
    if (roll < hazardChance) {
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

    // Placed relative to the lane where the gate actually stands, not to the
    // lane's nominal width: in a bend or a pinch a fixed offset puts the panel
    // outside the drivable span, where it can never be taken or dodged.
    const centre = corridor ? centreAt(corridor, y) : LANE_W / 2;
    const half = corridor ? halfWidthAt(corridor, y) : LANE_W / 2;
    // A gate wanders GATE_DRIFT either side, except where the corridor is too
    // tight to fit the whole panel at that offset — so an open lane keeps the
    // placement it has always had, and a pinch keeps the panel reachable
    // instead of burying half of it in the wall. The opening gate sits dead
    // centre: a player who has not yet learned that gates are dodgeable should
    // not lose the run to missing the first one.
    const drift = Math.min(GATE_DRIFT, Math.max(0, half - GATE_PANEL_W));
    let cx = i === 0 ? centre : centre + rng.range(-drift, drift);
    // A panel buried in a hazard can be neither taken nor dodged, so a gate
    // that lands on one slides to the middle of the roomier side.
    if (corridor) cx = clearOfHole(corridor, y, cx, GATE_PANEL_W, centre, half);
    gates.push({ y, cx, op, taken: false });
  }
  return gates;
}

export const GATE_MID = LANE_W / 2;

/**
 * Slides `x` out of the hazard at `y`, if there is one, onto the middle of
 * whichever side has more room for something `pad` wide. Shared by gates and
 * structures: content the player cannot reach is worse than no content.
 */
export function clearOfHole(
  corridor: Corridor,
  y: number,
  x: number,
  pad: number,
  centre: number,
  half: number,
): number {
  const hw = holeHalfWidthAt(corridor, y);
  if (hw <= 0) return x;
  const hc = holeCentreAt(corridor, y);
  if (Math.abs(x - hc) > hw + pad) return x;
  const lo = centre - half;
  const hi = centre + half;
  const leftRoom = (hc - hw) - lo;
  const rightRoom = hi - (hc + hw);
  return leftRoom >= rightRoom ? lo + leftRoom / 2 : hi - rightRoom / 2;
}
