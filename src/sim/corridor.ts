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

/**
 * A static obstruction in the middle of the lane. The corridor splits around it
 * into two drivable spans and the player commits to one.
 *
 * Wall-hugging hazards were the cheaper option and were rejected: a
 * render-capped crowd is 440 wide against a 720 lane and is clamped to stay
 * inside it, so it always covers the lane's centre. Anything central is
 * therefore unavoidable, and the only way to make one fair is to open a real
 * gap either side of it.
 */
export interface HazardSpec {
  /** Where along the level the hazard sits, 0..1. */
  readonly at: number;
  /** How much of the level it occupies, 0..1. */
  readonly span: number;
  /** Half-width of the obstruction, in world units. */
  readonly halfWidth: number;
  /** Lateral offset of the obstruction from the lane centre, in world units. */
  readonly offset?: number;
}

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

/**
 * Narrowest either span beside a hazard may become. A crowd bottoms out at
 * `MIN_SQUEEZE` and cannot thread a gap tighter than about this, so a hazard
 * wide enough to close one below it would make a level unwinnable rather than
 * hard — the same role `MIN_HALF_WIDTH` plays for the lane itself.
 */
export const MIN_SPAN_HALF = 100;

export interface Corridor {
  readonly step: number;
  readonly centre: Float32Array;
  readonly halfWidth: Float32Array;
  /** Centre of the hazard hole at each sample. Meaningless where the hole is empty. */
  readonly holeCentre: Float32Array;
  /** Half-width of the hole. Zero means one span, exactly as before hazards existed. */
  readonly holeHalfWidth: Float32Array;
}

/** One drivable stretch of lane. Two of them where a hazard splits the corridor. */
export interface Span {
  readonly lo: number;
  readonly hi: number;
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
export function buildCorridor(
  spec: CorridorSpec,
  length: number,
  hazards: readonly HazardSpec[] = [],
): Corridor {
  const count = Math.max(2, Math.ceil(length / CORRIDOR_STEP) + 2);
  const centre = new Float32Array(count);
  const halfWidth = new Float32Array(count);
  const holeCentre = new Float32Array(count);
  const holeHalfWidth = new Float32Array(count);

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
    // Seeded to the lane's centre rather than left at zero. Samples between a
    // closed hole and an open one are interpolated, and a default of zero makes
    // the hole appear to sweep in from the left lane edge as it opens instead
    // of growing where it stands — which also lets a span interpolate far below
    // the floor the generator just enforced.
    holeCentre[i] = c;

    // Hazards are punched out after the lane's own shape is settled, so a
    // hazard inside a pinch is measured against the pinch rather than the
    // nominal lane.
    for (const hz of hazards) {
      const u = featureT(t, hz.at, hz.span);
      if (u < 0) continue;
      // Eased open from nothing, so a squad sitting dead centre is nudged to a
      // side over a second or so rather than teleported out of the way.
      const grown = hz.halfWidth * bump(u);
      if (grown <= 0) continue;
      const hc = c + (hz.offset ?? 0);
      // Never so wide that either span closes below what a fully compressed
      // crowd can thread.
      const roomLeft = (hc - (c - hw)) - MIN_SPAN_HALF * 2;
      const roomRight = ((c + hw) - hc) - MIN_SPAN_HALF * 2;
      const allowed = Math.max(0, Math.min(grown, roomLeft, roomRight));
      if (allowed <= 0) continue;
      holeCentre[i] = hc;
      holeHalfWidth[i] = allowed;
    }
  }

  return { step: CORRIDOR_STEP, centre, halfWidth, holeCentre, holeHalfWidth };
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

export function holeCentreAt(c: Corridor, y: number): number {
  const { i, j, f } = sample(c, y);
  return c.holeCentre[i] + (c.holeCentre[j] - c.holeCentre[i]) * f;
}

export function holeHalfWidthAt(c: Corridor, y: number): number {
  const { i, j, f } = sample(c, y);
  return c.holeHalfWidth[i] + (c.holeHalfWidth[j] - c.holeHalfWidth[i]) * f;
}

/**
 * The drivable stretches at this point: one normally, two where a hazard splits
 * the lane. Everything that steers, spawns or places content reads this rather
 * than the raw edges, so a hazard is never something a caller can forget about.
 */
export function spansAt(c: Corridor, y: number, out: Span[] = []): Span[] {
  out.length = 0;
  const centre = centreAt(c, y);
  const half = halfWidthAt(c, y);
  const lo = centre - half;
  const hi = centre + half;
  const hw = holeHalfWidthAt(c, y);
  if (hw <= 0) {
    out.push({ lo, hi });
    return out;
  }
  const hc = holeCentreAt(c, y);
  const left = { lo, hi: Math.max(lo, hc - hw) };
  const right = { lo: Math.min(hi, hc + hw), hi };
  if (left.hi > left.lo) out.push(left);
  if (right.hi > right.lo) out.push(right);
  // A hole that somehow swallowed the lane still has to leave somewhere to
  // stand, or the squad is clamped onto ground that does not exist.
  if (out.length === 0) out.push({ lo, hi });
  return out;
}

export function leftAt(c: Corridor, y: number): number {
  return centreAt(c, y) - halfWidthAt(c, y);
}

export function rightAt(c: Corridor, y: number): number {
  return centreAt(c, y) + halfWidthAt(c, y);
}

/**
 * Clamps a lateral position into the drivable lane, keeping `pad` clear of each
 * edge. Where a hazard splits the corridor this clamps into whichever span `x`
 * is nearer, so dragging across the hole pops the squad to the other side
 * rather than refusing to move — crossing is an expensive option, never a
 * forbidden one.
 */
export function clampToCorridor(c: Corridor, y: number, x: number, pad = 0): number {
  const centre = centreAt(c, y);
  const half = halfWidthAt(c, y);
  let lo = centre - half;
  let hi = centre + half;

  // Deliberately allocation-free rather than routed through `spansAt`: this
  // runs once per red per frame, up to a few thousand times, and handing back
  // span objects there was measurable garbage for no gain.
  const hw = holeHalfWidthAt(c, y);
  if (hw > 0) {
    const hc = holeCentreAt(c, y);
    const holeLo = hc - hw;
    const holeHi = hc + hw;
    if (x < hc) {
      // Nearer the left span — unless the hole has swallowed it, in which case
      // there is nowhere to stand on that side and the right one takes over.
      if (holeLo > lo) hi = Math.min(hi, holeLo);
      else lo = Math.max(lo, holeHi);
    } else if (holeHi < hi) lo = Math.max(lo, holeHi);
    else hi = Math.min(hi, holeLo);
  }

  const width = hi - lo;
  // A pad wider than the span would invert the bounds; fall back to its middle
  // rather than returning a left edge to the right of the right one.
  if (pad * 2 >= width) return (lo + hi) / 2;
  const a = lo + pad;
  const b = hi - pad;
  return x < a ? a : x > b ? b : x;
}

/** Half-width of the drivable span `x` sits in. What the crowd must squeeze into. */
export function spanHalfWidthAt(c: Corridor, y: number, x: number): number {
  const half = halfWidthAt(c, y);
  const hw = holeHalfWidthAt(c, y);
  if (hw <= 0) return half;
  const centre = centreAt(c, y);
  const hc = holeCentreAt(c, y);
  const lo = centre - half;
  const hi = centre + half;
  const left = Math.max(0, Math.min(hi, hc - hw) - lo);
  const right = Math.max(0, hi - Math.max(lo, hc + hw));
  const chosen = x < hc ? (left > 0 ? left : right) : (right > 0 ? right : left);
  return (chosen > 0 ? chosen : hi - lo) / 2;
}

/** How much of a crowd centred at `x` with half-width `rx` lies inside the hazard. */
export function hazardOverlap(c: Corridor, y: number, x: number, rx: number): number {
  const hw = holeHalfWidthAt(c, y);
  if (hw <= 0 || rx <= 0) return 0;
  const hc = holeCentreAt(c, y);
  // Fraction of the crowd's width caught, then weighted by how much of a disc's
  // area sits in that strip — a crowd's edge holds far fewer bodies than its
  // middle, so a clip is not as costly as a plain width ratio implies.
  const lo = Math.max(x - rx, hc - hw);
  const hi = Math.min(x + rx, hc + hw);
  if (hi <= lo) return 0;
  const a = Math.max(-1, Math.min(1, (lo - x) / rx));
  const b = Math.max(-1, Math.min(1, (hi - x) / rx));
  const area = (t: number): number => t * Math.sqrt(1 - t * t) + Math.asin(t);
  return (area(b) - area(a)) / Math.PI;
}

/** True if this corridor is the full lane everywhere, unsplit — the no-op case. */
export function isStraight(c: Corridor): boolean {
  for (let i = 0; i < c.centre.length; i++) {
    if (c.centre[i] !== LANE_HALF || c.halfWidth[i] !== LANE_HALF) return false;
    if (c.holeHalfWidth[i] !== 0) return false;
  }
  return true;
}
