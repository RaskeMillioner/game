import { describe, expect, it } from 'vitest';
import { LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_RED, START_BLUE } from './config.js';
import { gateIsGood, GATE_PANEL_W } from './gates.js';
import { World } from './world.js';

const VIEW_H = 1560;

function run(seed: number, steps: number, drive?: (w: World, i: number) => void): World {
  const w = new World(seed, VIEW_H);
  for (let i = 0; i < steps && w.state === 'running'; i++) {
    drive?.(w, i);
    w.step(1 / 60);
  }
  return w;
}

/** Steers into the next gate if it is worth taking, and around it if not. */
function seekGate(preferGood: boolean) {
  return (w: World): void => {
    const next = w.gates.find((g) => !g.taken && g.y > w.anchorY - 200);
    if (!next) {
      w.targetX = LANE_W / 2;
      return;
    }
    // With one option per gate the decision is take it or dodge it, so half the
    // skill is steering clear of a panel that would cost you.
    if (gateIsGood(next.op) === preferGood) {
      w.targetX = next.cx;
      return;
    }
    const room = next.cx > LANE_W / 2 ? -1 : 1;
    w.targetX = next.cx + room * (GATE_PANEL_W + 130);
  };
}

/** Diverts onto a nearby objective, falling back to gate seeking. */
function seekObjectives(commit: number) {
  const fallback = seekGate(true);
  return (w: World): void => {
    const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
    if (o && !o.broken && o.y - w.anchorY < commit) {
      w.targetX = o.x;
      return;
    }
    fallback(w);
  };
}

describe('World', () => {
  it('is deterministic for a given seed', () => {
    const a = run(12345, 1800);
    const b = run(12345, 1800);
    expect(a.kills).toBe(b.kills);
    expect(a.count).toBe(b.count);
    expect(a.state).toBe(b.state);
    expect(a.cameraY).toBeCloseTo(b.cameraY, 5);
  });

  it('diverges across seeds', () => {
    expect(run(1, 1800).kills).not.toBe(run(999, 1800).kills);
  });

  it('kills reds from the first seconds', () => {
    const w = run(7, 300);
    expect(w.kills).toBeGreaterThan(0);
  });

  it('gives a blind player a survivable opening in the large majority of runs', () => {
    // Asserted over a population, not one seed: a 10-strong squad with a pistol
    // will occasionally draw a lethal opening clump, and tuning the game to make
    // one arbitrary seed survive would be fitting noise.
    const RUNS = 200;
    let died = 0;
    for (let s = 0; s < RUNS; s++) {
      const w = run(s * 104729 + 3, 15 * 60, (world) => {
        world.targetX = LANE_W / 2;
      });
      if (w.state === 'dead') died++;
    }
    expect(died / RUNS).toBeLessThan(0.12);
  }, 30_000);

  /** Mean peak squad size over a population of seeds under one steering strategy. */
  function meanPeak(strategy: (w: World) => void, seeds: number): number {
    let total = 0;
    for (let s = 0; s < seeds; s++) {
      const w = new World(s * 7919 + 13, VIEW_H);
      let peak = w.count;
      for (let i = 0; i < 60 * 75 && w.state === 'running'; i++) {
        strategy(w);
        w.step(1 / 60);
        if (w.count > peak) peak = w.count;
      }
      total += peak;
    }
    return total / seeds;
  }

  it('still rewards taking the better gate', () => {
    // Gates are occasional and narrow now, so they punctuate a run rather than
    // driving it: the margin here is real but no longer the whole game. What
    // carries a run is objective play, asserted separately below.
    const good = meanPeak(seekGate(true), 14);
    const bad = meanPeak(seekGate(false), 14);
    expect(good).toBeGreaterThan(START_BLUE * 4);
    expect(good).toBeGreaterThan(bad * 1.3);
  }, 30_000);

  it('makes opportunistic objective play the strongest line', () => {
    const withObjectives = meanPeak(seekObjectives(900), 14);
    const gatesOnly = meanPeak(seekGate(true), 14);
    expect(withObjectives).toBeGreaterThan(gatesOnly * 1.5);
  }, 30_000);

  it('punishes over-committing to objectives', () => {
    // Locking onto a distant structure means sailing past the narrow gates,
    // and gates are where the large multipliers live.
    const greedy = meanPeak(seekObjectives(2600), 14);
    const opportunistic = meanPeak(seekObjectives(900), 14);
    expect(greedy).toBeLessThan(opportunistic * 0.6);
  }, 30_000);

  it('overruns a player who consistently takes the worse gate', () => {
    let died = 0;
    const RUNS = 24;
    for (let s = 0; s < RUNS; s++) {
      if (run(s * 7919 + 13, 60 * 120, seekGate(false)).state === 'dead') died++;
    }
    expect(died / RUNS).toBeGreaterThan(0.85);
  }, 30_000);

  it('grows past the render cap while the true count keeps scaling damage', () => {
    const w = new World(42, VIEW_H);
    w.count = 2000;
    w.step(1 / 60);
    expect(w.rendered).toBe(MAX_BLUE_RENDER);
    expect(w.count).toBe(2000);
  });

  it('respects array capacities under sustained pressure', () => {
    const w = run(88, 60 * 120, seekGate(true));
    expect(w.redCount).toBeLessThanOrEqual(MAX_RED);
    expect(w.bulletCount).toBeLessThanOrEqual(MAX_BULLET);
    expect(w.rendered).toBeLessThanOrEqual(MAX_BLUE_RENDER);
  });

  it('keeps the squad inside the lane', () => {
    const w = run(5, 60 * 45, (world, i) => {
      world.targetX = i % 120 < 60 ? -5000 : 5000;
    });
    expect(w.anchorX).toBeGreaterThan(0);
    expect(w.anchorX).toBeLessThan(LANE_W);
  });
});

describe('red pursuit', () => {
  it('brings reds onto the squad instead of past it', () => {
    // Regression: reds used to descend at a constant rate regardless of where
    // the squad was, so most of them sailed by and were never a threat.
    const w = run(21, 60 * 40, (world) => {
      world.targetX = LANE_W * 0.25;
    });
    const resolved = w.kills + w.leaked;
    expect(resolved).toBeGreaterThan(50);
    expect(w.leaked / resolved).toBeLessThan(0.1);
  });

  it('closes on a squad parked far from the spawn column', () => {
    const w = new World(4, VIEW_H);
    w.targetX = 60;
    w.anchorX = 60;
    for (let i = 0; i < 90; i++) w.step(1 / 60);
    expect(w.redCount).toBeGreaterThan(0);
    let near = 0;
    for (let i = 0; i < w.redCount; i++) {
      if (Math.abs(w.redX[i] - w.anchorX) < 220) near++;
    }
    expect(near / w.redCount).toBeGreaterThan(0.5);
  });
});

describe('objectives', () => {
  it('breaks under sustained fire and pays out', () => {
    const w = new World(11, VIEW_H);
    w.count = 260;
    const target = w.objectives.find((o) => o.kind === 'recruit');
    expect(target).toBeDefined();
    if (!target) return;
    const before = w.count;
    while (w.anchorY < target.y && w.state === 'running') {
      w.targetX = target.x;
      w.step(1 / 60);
    }
    expect(target.broken).toBe(true);
    expect(target.resolved).toBe(true);
    expect(w.count).toBeGreaterThan(before - 100 + target.value / 2);
  });

  it('charges a multiplier board rather than breaking it', () => {
    const w = new World(11, VIEW_H);
    w.count = 260;
    const board = w.objectives.find((o) => o.kind === 'multiplier');
    expect(board).toBeDefined();
    if (!board) return;
    while (w.anchorY < board.y && w.state === 'running') {
      w.targetX = board.x;
      w.step(1 / 60);
    }
    expect(board.broken).toBe(false);
    expect(board.hp).toBeLessThan(board.maxHp);
    expect(board.resolved).toBe(true);
  });

  it('leaves objectives intact when the squad never lines up on them', () => {
    const w = new World(11, VIEW_H);
    w.count = 260;
    const board = w.objectives.find((o) => o.kind === 'weapon');
    expect(board).toBeDefined();
    if (!board) return;
    const away = board.x < LANE_W / 2 ? LANE_W - 40 : 40;
    while (w.anchorY < board.y && w.state === 'running') {
      w.targetX = away;
      w.step(1 / 60);
    }
    expect(board.broken).toBe(false);
  });
});
