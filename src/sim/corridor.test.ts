import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from './campaign.js';
import { LANE_W, SCROLL_SPEED } from './config.js';
import {
  buildCorridor, centreAt, clampToCorridor, CorridorSpec, halfWidthAt, HazardSpec,
  hazardOverlap, holeCentreAt, holeHalfWidthAt, isStraight, LANE_HALF, leftAt,
  MIN_HALF_WIDTH, MIN_SPAN_HALF, rightAt, spanHalfWidthAt, spansAt,
  SQUEEZE_THRESHOLD, STRAIGHT,
} from './corridor.js';
import { formationSqueeze } from './formation.js';
import { GATE_PANEL_W } from './gates.js';
import { buildLevel, LevelDef } from './levels.js';
import { World } from './world.js';

const VIEW_H = 1560;
const LEN = 15000;

const PINCH: CorridorSpec = { shape: 'pinch', tightness: 0.55, at: 0.5, span: 0.25 };
const BEND: CorridorSpec = { shape: 'bend', tightness: 0.6, sway: 0.45, at: 0.5, span: 0.4 };
const HAZARD: HazardSpec = { at: 0.5, span: 0.2, halfWidth: 120 };

describe('corridor geometry', () => {
  it('is a straight full-width lane by default', () => {
    // The whole migration rests on this: a level that asks for no shape must
    // behave exactly as it did before corridors existed.
    const c = buildCorridor(STRAIGHT, LEN);
    expect(isStraight(c)).toBe(true);
    for (let y = 0; y <= LEN; y += 250) {
      expect(centreAt(c, y)).toBe(LANE_HALF);
      expect(halfWidthAt(c, y)).toBe(LANE_HALF);
      expect(leftAt(c, y)).toBe(0);
      expect(rightAt(c, y)).toBe(LANE_W);
    }
  });

  it('is deterministic and covers the level past its end', () => {
    const a = buildCorridor(PINCH, LEN);
    const b = buildCorridor(PINCH, LEN);
    expect(Array.from(a.centre)).toEqual(Array.from(b.centre));
    expect(Array.from(a.halfWidth)).toEqual(Array.from(b.halfWidth));
    // Sampling past the finish must clamp rather than read off the end.
    expect(Number.isFinite(halfWidthAt(a, LEN * 2))).toBe(true);
    expect(Number.isFinite(centreAt(a, -500))).toBe(true);
  });

  it('actually narrows, and never past the floor', () => {
    const c = buildCorridor({ shape: 'pinch', tightness: 0.01, at: 0.5, span: 0.3 }, LEN);
    let min = Infinity;
    for (let y = 0; y <= LEN; y += 30) min = Math.min(min, halfWidthAt(c, y));
    expect(min).toBeGreaterThanOrEqual(MIN_HALF_WIDTH);
    // A tightness of 0.01 asks for a hairline; the floor is what stops a level
    // being unwinnable rather than hard.
    expect(min).toBe(MIN_HALF_WIDTH);
  });

  it('keeps the drivable span inside the lane it is drawn in, even at full sway', () => {
    // The samples are Float32Array, so an edge computed as exactly LANE_W in
    // double precision can come back a ten-millionth over. That is the storage
    // talking, not the clamp: EPS is float32's resolution near 720, and the
    // invariant that matters — the squad is never clamped onto ground the
    // renderer does not draw — holds far inside it.
    const EPS = 1e-4;
    const c = buildCorridor({ shape: 'bend', tightness: 0.5, sway: 5, at: 0.5, span: 0.5 }, LEN);
    for (let y = 0; y <= LEN; y += 30) {
      expect(leftAt(c, y)).toBeGreaterThanOrEqual(-EPS);
      expect(rightAt(c, y)).toBeLessThanOrEqual(LANE_W + EPS);
    }
  });

  it('clamps into the corridor, and to the centre when the pad will not fit', () => {
    const c = buildCorridor(PINCH, LEN);
    const y = LEN / 2;
    expect(clampToCorridor(c, y, -9999)).toBeCloseTo(leftAt(c, y), 5);
    expect(clampToCorridor(c, y, 9999)).toBeCloseTo(rightAt(c, y), 5);
    // A margin wider than the corridor would otherwise invert the bounds and
    // return a left edge to the right of the right one.
    expect(clampToCorridor(c, y, 0, 9999)).toBeCloseTo(centreAt(c, y), 5);
  });
});

describe('the crowd in a narrow lane', () => {
  it('compresses rather than losing anyone', () => {
    const open = formationSqueeze(400, LANE_HALF);
    const tight = formationSqueeze(400, 150);
    expect(open).toBe(1);
    expect(tight).toBeLessThan(1);
    // A small crowd fits anywhere and is never squeezed.
    expect(formationSqueeze(12, 150)).toBe(1);
  });

  it('narrows the crowd and deepens it without costing bodies', () => {
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), corridor: PINCH, length: LEN };
    const w = new World(level, VIEW_H);
    w.count = 400;
    w.step(1 / 60);
    const openX = w.radiusX;
    const openY = w.radiusY;
    expect(w.squeeze).toBe(1);

    // Drive to the tightest point and hold there.
    while (w.state === 'running' && w.anchorY < LEN * 0.5) w.step(1 / 60);
    w.count = 400;
    w.step(1 / 60);
    expect(w.squeeze).toBeLessThan(1);
    expect(w.radiusX).toBeLessThan(openX);
    expect(w.radiusY).toBeGreaterThan(openY);
    // Area is conserved, so the crowd is the same crowd.
    expect(w.radiusX * w.radiusY).toBeCloseTo(openX * openY, 3);
    expect(w.count).toBe(400);
  });

  it('gives every shaped level a lane tight enough to actually squeeze', () => {
    // The first pass at THE PRESS bottomed out at a half-width of 231 against a
    // render-capped crowd radius of ~220, so it compressed nothing and the
    // "pinch" was scenery. A shape that never engages is a level that does not
    // play the way its name says it does.
    const shaped = CAMPAIGN.filter((l) => l.corridor && l.corridor.shape !== 'straight');
    expect(shaped.length).toBeGreaterThan(0);
    for (const level of shaped) {
      const c = buildLevel(level).corridor;
      let min = Infinity;
      for (let y = 0; y <= level.length; y += 60) min = Math.min(min, halfWidthAt(c, y));
      expect(min).toBeLessThan(SQUEEZE_THRESHOLD);
      expect(min).toBeGreaterThanOrEqual(MIN_HALF_WIDTH);
    }
  });

  it('keeps the anchor inside the corridor through a bend at full drag', () => {
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), corridor: BEND, length: LEN };
    const w = new World(level, VIEW_H);
    for (let i = 0; w.state === 'running' && i < 60 * 90; i++) {
      // Slam the target against both walls, alternating, which is the worst
      // case for a clamp that reads the corridor at the wrong y.
      w.targetX = i % 90 < 45 ? -5000 : 5000;
      w.step(1 / 60);
      expect(w.anchorX).toBeGreaterThanOrEqual(leftAt(w.corridor, w.anchorY) - 1);
      expect(w.anchorX).toBeLessThanOrEqual(rightAt(w.corridor, w.anchorY) + 1);
    }
  });
});

describe('content stays reachable', () => {
  it('puts every gate panel and every structure inside the corridor', () => {
    // The phase-5 bug class: content nudged somewhere the player can never
    // reach it. A gate whose panel is buried in the wall cannot be taken or
    // dodged, and a crate outside the lane is a reward that does not exist.
    const shapes: CorridorSpec[] = [STRAIGHT, PINCH, BEND];
    for (const level of CAMPAIGN) {
      for (const corridor of shapes) {
        const plan = buildLevel({ ...level, corridor });
        for (const g of plan.gates) {
          expect(g.cx - GATE_PANEL_W).toBeGreaterThanOrEqual(leftAt(plan.corridor, g.y) - 0.5);
          expect(g.cx + GATE_PANEL_W).toBeLessThanOrEqual(rightAt(plan.corridor, g.y) + 0.5);
        }
        for (const o of plan.objectives) {
          expect(o.x).toBeGreaterThanOrEqual(leftAt(plan.corridor, o.y));
          expect(o.x).toBeLessThanOrEqual(rightAt(plan.corridor, o.y));
        }
      }
    }
  });

  it('leaves straight levels byte-identical to the pre-corridor placement', () => {
    // Guards the migration: these are the exact constants the sim used before
    // the corridor existed, and any drift in them silently re-tunes the game.
    const plan = buildLevel({ ...(CAMPAIGN[0] as LevelDef), corridor: STRAIGHT });
    for (const o of plan.objectives) {
      // centre - 0.56 * halfWidth reaches LANE_W * 0.22 by a different route,
      // so it lands one ulp away rather than on the nose.
      const left = Math.abs(o.x - LANE_W * 0.22) < 1e-9;
      const right = Math.abs(o.x - LANE_W * 0.78) < 1e-9;
      expect(left || right).toBe(true);
    }
    for (const g of plan.gates) {
      expect(Math.abs(g.cx - LANE_W / 2)).toBeLessThanOrEqual(135);
    }
  });

  it('still lets the squad clear a level whose lane narrows', () => {
    // A corridor that makes a level unwinnable is a worse bug than one that
    // makes it ugly, and the floor on half-width exists to prevent exactly it.
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), corridor: PINCH };
    const w = new World(level, VIEW_H);
    const budget = Math.ceil(((level.length / SCROLL_SPEED) * 1.35 + 10) * 60);
    for (let i = 0; i < budget && w.state === 'running'; i++) {
      // Track the lane rather than holding a fixed x, which is what a player
      // sees themselves doing.
      w.targetX = centreAt(w.corridor, w.anchorY);
      w.step(1 / 60);
    }
    expect(w.state).toBe('won');
  });
});

describe('hazards', () => {
  it('leaves the lane whole when a level asks for none', () => {
    // The migration guard, exactly as the straight corridor was for 6a: a level
    // without hazards must behave as though holes were never added.
    const c = buildCorridor(STRAIGHT, LEN);
    expect(isStraight(c)).toBe(true);
    for (let y = 0; y <= LEN; y += 250) {
      expect(holeHalfWidthAt(c, y)).toBe(0);
      expect(spansAt(c, y)).toEqual([{ lo: 0, hi: LANE_W }]);
      expect(spanHalfWidthAt(c, y, 360)).toBe(LANE_HALF);
      expect(hazardOverlap(c, y, 360, 220)).toBe(0);
    }
  });

  it('splits the lane into two ordered spans, both wide enough to thread', () => {
    const c = buildCorridor(STRAIGHT, LEN, [HAZARD]);
    let sawSplit = false;
    for (let y = 0; y <= LEN; y += 30) {
      const spans = spansAt(c, y);
      expect(spans.length).toBeGreaterThan(0);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].lo).toBeGreaterThan(spans[i - 1].hi);
      }
      for (const s of spans) expect(s.hi).toBeGreaterThan(s.lo);
      if (spans.length === 2) {
        sawSplit = true;
        // A gap no crowd can thread is an unwinnable level, not a hard one.
        for (const s of spans) {
          expect((s.hi - s.lo) / 2).toBeGreaterThanOrEqual(MIN_SPAN_HALF - 0.5);
        }
      }
    }
    expect(sawSplit).toBe(true);
  });

  it('never leaves a hazard wide enough to close a side', () => {
    // An absurd request has to be clamped rather than honoured.
    const c = buildCorridor(STRAIGHT, LEN, [{ at: 0.5, span: 0.2, halfWidth: 5000 }]);
    for (let y = 0; y <= LEN; y += 30) {
      for (const s of spansAt(c, y)) {
        expect((s.hi - s.lo) / 2).toBeGreaterThanOrEqual(MIN_SPAN_HALF - 0.5);
      }
    }
  });

  it('keeps the squad out of the pit however it is steered', () => {
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), hazards: [HAZARD], length: LEN };
    const w = new World(level, VIEW_H);
    for (let i = 0; w.state === 'running' && i < 60 * 90; i++) {
      // Includes the frame the hole eases open underneath a squad sitting dead
      // centre, which is the case a naive clamp gets wrong.
      w.targetX = i % 120 < 60 ? -5000 : 5000;
      w.step(1 / 60);
      const hw = holeHalfWidthAt(w.corridor, w.anchorY);
      if (hw <= 0) continue;
      const hc = holeCentreAt(w.corridor, w.anchorY);
      expect(Math.abs(w.anchorX - hc)).toBeGreaterThan(hw - 1);
    }
  });

  it('squeezes the crowd into the gap, narrowing its guns', () => {
    // The mechanism that actually makes a hazard dangerous: not the bodies it
    // takes, but the firing line it costs you while you thread it.
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), hazards: [HAZARD], length: LEN };
    const w = new World(level, VIEW_H);
    w.count = 400;
    w.step(1 / 60);
    const openX = w.radiusX;

    let narrowest = Infinity;
    while (w.state === 'running' && w.anchorY < LEN * 0.55) {
      w.count = 400;
      w.step(1 / 60);
      if (holeHalfWidthAt(w.corridor, w.anchorY) > 0) narrowest = Math.min(narrowest, w.radiusX);
    }
    expect(narrowest).toBeLessThan(openX * 0.75);
  });

  it('charges for standing in the pit, and charges more the deeper you are', () => {
    const c = buildCorridor(STRAIGHT, LEN, [HAZARD]);
    const y = LEN / 2;
    const hc = holeCentreAt(c, y);
    const hw = holeHalfWidthAt(c, y);
    expect(hw).toBeGreaterThan(0);
    const dead = hazardOverlap(c, y, hc, 200);
    const grazing = hazardOverlap(c, y, hc + hw + 150, 200);
    const clear = hazardOverlap(c, y, hc + hw + 400, 200);
    expect(dead).toBeGreaterThan(grazing);
    expect(grazing).toBeGreaterThan(0);
    expect(clear).toBe(0);
    // A crowd centred on the pit is mostly, but never entirely, inside it.
    expect(dead).toBeLessThanOrEqual(1);
  });

  it('costs bodies to cross a pit and far less to thread one', () => {
    // HAZARD sits on the lane's centre line, so the left span is roughly
    // [0, 240] and the right [480, 720]. Both drivers are written against those
    // absolutes rather than reacting to the hole, so neither is at the mercy of
    // how far ahead it happens to look.
    const level: LevelDef = { ...(CAMPAIGN[0] as LevelDef), hazards: [HAZARD], length: LEN };

    const run = (drive: (w: World, i: number) => void): number => {
      const w = new World(level, VIEW_H);
      for (let i = 0; w.state === 'running' && w.anchorY < LEN * 0.65; i++) {
        w.count = 400;
        drive(w, i);
        w.step(1 / 60);
      }
      return w.hazardLosses;
    };

    // Picks the left side before the hazard exists and never leaves it.
    const threading = run((w) => { w.targetX = 120; });
    // Traverses the pit on a slow enough cadence to actually be inside it,
    // rather than snapping between the two walls.
    const crossing = run((w, i) => { w.targetX = (i / 90) % 2 < 1 ? 120 : 600; });

    expect(threading).toBeLessThan(crossing / 2);
  });
});

describe('content stays clear of hazards', () => {
  it('never puts a gate panel or a structure in a pit', () => {
    // The phase-5 bug class once more: a reward inside a hazard is a reward
    // that cannot be taken, and a gate panel in one can be neither used nor
    // dodged.
    for (const level of CAMPAIGN) {
      const plan = buildLevel({ ...level, hazards: [HAZARD] });
      for (const g of plan.gates) {
        const hw = holeHalfWidthAt(plan.corridor, g.y);
        if (hw <= 0) continue;
        const hc = holeCentreAt(plan.corridor, g.y);
        expect(Math.abs(g.cx - hc)).toBeGreaterThanOrEqual(hw - 0.5);
      }
      for (const o of plan.objectives) {
        const hw = holeHalfWidthAt(plan.corridor, o.y);
        if (hw <= 0) continue;
        const hc = holeCentreAt(plan.corridor, o.y);
        expect(Math.abs(o.x - hc)).toBeGreaterThanOrEqual(hw - 0.5);
      }
    }
  });

  it('leaves a hazard level winnable by the player the campaign is tuned for', () => {
    // Deliberately the probe's own reference strategy rather than a
    // hazard-dodging one. A player who commits to a side perfectly abandons the
    // objectives to do it and wins far less often — the toll is meant to be a
    // decision, not a rule, so the level has to be clearable while paying it.
    const level = CAMPAIGN.find((l) => (l.hazards?.length ?? 0) > 0) as LevelDef;
    expect(level).toBeDefined();
    let won = 0;
    for (let seed = 0; seed < 5; seed++) {
      const w = new World({ ...level, seed: (level.seed + seed * 2654435761) >>> 0 }, VIEW_H);
      const budget = Math.ceil(((level.length / SCROLL_SPEED) * 1.35 + 10) * 60);
      for (let i = 0; i < budget && w.state === 'running'; i++) {
        const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
        if (o && o.y - w.anchorY < 900) {
          w.targetX = o.x;
        } else {
          // Falls back to the next gate rather than to the lane's centre line.
          // Centre is where a hazard opens, so parking there — which used to be
          // the safest thing a player could do — is now the worst.
          const g = w.gates.find((x) => !x.taken && x.y > w.anchorY - 200);
          w.targetX = g ? g.cx : centreAt(w.corridor, w.anchorY);
        }
        w.step(1 / 60);
      }
      if (w.state === 'won') won++;
    }
    expect(won).toBeGreaterThan(2);
  });
});
