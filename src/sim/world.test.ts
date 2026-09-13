import { describe, expect, it } from 'vitest';
import { LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_RED, START_BLUE } from './config.js';
import { gateIsGood, GATE_MID } from './gates.js';
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

/**
 * Steers into the better or worse half of the next gate. Note there is no way to
 * skip a gate — they span the lane — so "never grow" is not a reachable state.
 */
function seekGate(preferGood: boolean) {
  return (w: World): void => {
    const next = w.gates.find((g) => !g.taken && g.y > w.anchorY - 200);
    if (!next) {
      w.targetX = LANE_W / 2;
      return;
    }
    const leftGood = gateIsGood(next.left);
    const rightGood = gateIsGood(next.right);
    const goLeft = leftGood !== rightGood ? leftGood === preferGood : preferGood;
    w.targetX = goLeft ? GATE_MID * 0.5 : GATE_MID * 1.5;
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

  it('makes gate choice the dominant decision', () => {
    // Compared across a population: any single run can be lost to an unlucky
    // opening clump regardless of how well it is played.
    const good = meanPeak(seekGate(true), 14);
    const bad = meanPeak(seekGate(false), 14);
    expect(good).toBeGreaterThan(START_BLUE * 10);
    expect(good).toBeGreaterThan(bad * 5);
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
