import { LANE_W } from './config.js';

/**
 * The drivable lane.
 *
 * `LANE_W` stays fixed at 720 as the virtual coordinate space — the renderer,
 * the drag maths and every cull check still use it. What varies with distance
 * is the *span within it* the squad can actually occupy.
 *
 * The shape is sampled rather than analytic, and baked at level generation the
 * same way spawn waves are: a template produces the samples, and the sim only
 * ever reads them. That keeps arbitrary shapes cheap to evaluate, lets the
 * renderer walk the same array it steers by, and leaves phase 10's fork as a
 * change to what the accessors return rather than to how any of this works.
 */

export type CorridorShape = 'straight' | 'narrow' | 'bend' | 'pinch';

export interface CorridorSpec {
  readonly shape: CorridorShape;
  /**
   * Tightest half-width as a fraction of the full lane's, at the shape's
   * narrowest point. 1 leaves the lane alone.
   */
  readonly tightness?: number;
  /** Peak lateral displacement of the centre line, as a fraction of the lane's half-width. */
  readonly sway?: number;
  /** Where along the level the shape's feature sits, 0..1. */
  readonly at?: number;
  /** How much of the level the feature occupies, 0..1. */
  readonly span?: number;
}

export const STRAIGHT: CorridorSpec = { shape: 'straight' };

/** Full-lane half-width: what every shape is measured against. */
export const LANE_HALF = LANE_W / 2;

/**
 * Sample spacing. 60 units is a quarter-second of travel at SCROLL_SPEED, far
 * finer than any shape the templates produce, so linear interpolation between
 * samples is invisible.
 */
export const CORRIDOR_STEP = 60;

/**
 * The narrowest the lane may ever get. Below roughly this the crowd's own
 * frontage cannot produce a firing line wide enough to cover the swarm, and a
 * level stops being hard and starts being unwinnable.
 */
export const MIN_HALF_WIDTH = 120;

/**
 * Half-width below which a render-capped crowd starts to compress. The crowd's
 * radius tops out at `formationRadius(MAX_BLUE_RENDER)` ≈ 220 however large the
 * squad truly is, so a "pinch" looser than this squeezes nothing and is only
 * scenery — which is what the first pass at THE PRESS turned out to be.
 */
export const SQUEEZE_THRESHOLD = 232;

export interface Corridor {
  readonly step: number;
  readonly centre: Float32Array;
  readonly halfWidth: Float32Array;
}

/** Fraction of the way through `span` centred on `at`, or -1 outside it. */
function featureT(t: number, at: number, span: number): number {
  const half = span / 2;
  const start = at - half;
  if (t < start || t > at + half || span <= 0) return -1;
  return (t - start) / span;
}

/** Smooth 0 -> 1 -> 0 across a feature, so a shape eases in rather than stepping. */
function bump(u: number): number {
  return 0.5 - 0.5 * Math.cos(u * Math.PI * 2);
}

/**
 * Builds a corridor for a level. Pure in the spec and the level's length, so
 * the shape is as reproducible as everything else a level is made of.
 */
export function buildCorridor(spec: CorridorSpec, length: number): Corridor {
  const count = Math.max(2, Math.ceil(length / CORRIDOR_STEP) + 2);
  const centre = new Float32Array(count);
  const halfWidth = new Float32Array(count);

  const tightness = spec.tightness ?? 1;
  const sway = spec.sway ?? 0;
  const at = spec.at ?? 0.5;
  const span = spec.span ?? 0.3;

  for (let i = 0; i < count; i++) {
    const y = i * CORRIDOR_STEP;
    const t = length > 0 ? Math.min(1, y / length) : 0;
    let c = LANE_HALF;
    let hw = LANE_HALF;

    switch (spec.shape) {
      case 'straight':
        break;
      case 'narrow': {
        // One long taper in and back out, occupying most of the level.
        const u = featureT(t, at, span);
        if (u >= 0) hw = LANE_HALF * (1 - (1 - tightness) * bump(u));
        break;
      }
      case 'pinch': {
        // Same maths, but the template supplies a short span — a hard squeeze
        // you steer through rather than a stretch you settle into.
        const u = featureT(t, at, span);
        if (u >= 0) hw = LANE_HALF * (1 - (1 - tightness) * bump(u));
        break;
      }
      case 'bend': {
        // The centre swings and the lane tightens a little with it: a bend the
        // full width of the lane reads as scenery, not as something to steer.
        const u = featureT(t, at, span);
        if (u >= 0) {
          c = LANE_HALF + Math.sin(u * Math.PI * 2) * sway * LANE_HALF;
          hw = LANE_HALF * (1 - (1 - tightness) * bump(u));
        }
        break;
      }
    }

    if (hw < MIN_HALF_WIDTH) hw = MIN_HALF_WIDTH;
    // The drivable span has to stay inside the lane it is drawn in, or the
    // squad clamps to an edge the renderer never draws.
    if (c - hw < 0) c = hw;
    if (c + hw > LANE_W) c = LANE_W - hw;
    centre[i] = c;
    halfWidth[i] = hw;
  }

  return { step: CORRIDOR_STEP, centre, halfWidth };
}

/** Index and blend factor for a world position. Clamps at both ends. */
function sample(c: Corridor, y: number): { i: number; j: number; f: number } {
  const last = c.centre.length - 1;
  if (!(y > 0)) return { i: 0, j: 0, f: 0 };
  const raw = y / c.step;
  if (raw >= last) return { i: last, j: last, f: 0 };
  const i = raw | 0;
  return { i, j: i + 1, f: raw - i };
}

export function centreAt(c: Corridor, y: number): number {
  const { i, j, f } = sample(c, y);
  return c.centre[i] + (c.centre[j] - c.centre[i]) * f;
}

export function halfWidthAt(c: Corridor, y: number): number {
  const { i, j, f } = sample(c, y);
  return c.halfWidth[i] + (c.halfWidth[j] - c.halfWidth[i]) * f;
}

export function leftAt(c: Corridor, y: number): number {
  return centreAt(c, y) - halfWidthAt(c, y);
}

export function rightAt(c: Corridor, y: number): number {
  return centreAt(c, y) + halfWidthAt(c, y);
}

/** Clamps a lateral position into the corridor, keeping `pad` clear of each edge. */
export function clampToCorridor(c: Corridor, y: number, x: number, pad = 0): number {
  const centre = centreAt(c, y);
  const half = halfWidthAt(c, y);
  // A pad wider than the corridor would invert the bounds; fall back to the
  // centre line rather than returning a right edge left of the left one.
  if (pad * 2 >= half * 2) return centre;
  const lo = centre - half + pad;
  const hi = centre + half - pad;
  return x < lo ? lo : x > hi ? hi : x;
}

/** True if this corridor is the full lane everywhere — the no-op case. */
export function isStraight(c: Corridor): boolean {
  for (let i = 0; i < c.centre.length; i++) {
    if (c.centre[i] !== LANE_HALF || c.halfWidth[i] !== LANE_HALF) return false;
  }
  return true;
}
