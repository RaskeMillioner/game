import { describe, expect, it } from 'vitest';
import { LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_RED, SCROLL_SPEED, START_BLUE, TURRET_RANGE, WEAPONS } from './config.js';
import {
  BRUTE, ENEMIES, ENEMY_KINDS, enemyHp, GRUNT, pickType, RUNNER,
} from './enemies.js';
import { gateIsGood, GATE_PANEL_W } from './gates.js';
import { CAMPAIGN } from './campaign.js';
import { endlessLevel } from './levels.js';
import { World } from './world.js';

const VIEW_H = 1560;

function run(seed: number, steps: number, drive?: (w: World, i: number) => void): World {
  const w = new World(endlessLevel(seed), VIEW_H);
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
    // Stay on it until it is resolved, not merely broken: a cracked crate is a
    // pickup lying in the lane, and the crowd has to run over it to take it.
    const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
    if (o && o.y - w.anchorY < commit) {
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
      const w = new World(endlessLevel(s * 7919 + 13), VIEW_H);
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

  /** Mean seconds survived over a population of seeds under one strategy. */
  function meanSurvival(strategy: (w: World) => void, seeds: number): number {
    let total = 0;
    for (let s = 0; s < seeds; s++) {
      const w = new World(endlessLevel(s * 7919 + 13), VIEW_H);
      let i = 0;
      for (; i < 60 * 75 && w.state === 'running'; i++) {
        strategy(w);
        w.step(1 / 60);
      }
      total += i / 60;
    }
    return total / seeds;
  }

  it('keeps gate play and objective play both viable and close', () => {
    // Asserted on survival, not peak squad: outlasting the swarm is what
    // "strongest" means, and a late multiplier can inflate peak without the run
    // going any further.
    //
    // Deliberately a band rather than a ranking. Objective play only pulls ahead
    // over a long horizon — measured across 150s it leads by 5-12%, but inside
    // the 60-90s a level is meant to last the two lines are level. Asserting a
    // winner here would be fitting noise.
    const withObjectives = meanSurvival(seekObjectives(900), 14);
    const gatesOnly = meanSurvival(seekGate(true), 14);
    const blind = meanSurvival((w) => { w.targetX = LANE_W / 2; }, 14);
    // Only 1.1: a squad parked at lane centre still collects most gates, since
    // a gate's centre wanders +/-135 either side of the lane and its panel is 95
    // wide. The margin skill buys over doing nothing is thinner than it should
    // be, and that is a finding about the gates, not about these strategies.
    expect(withObjectives).toBeGreaterThan(blind * 1.1);
    expect(gatesOnly).toBeGreaterThan(blind * 1.1);
    expect(withObjectives).toBeGreaterThan(gatesOnly * 0.85);
    expect(gatesOnly).toBeGreaterThan(withObjectives * 0.85);
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
    const w = new World(endlessLevel(42), VIEW_H);
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
    // The squad parks off-centre on purpose — that is the case the old model
    // got wrong — and results are pooled across seeds so the ratio rests on a
    // decent sample even though a parked squad does not survive long.
    let kills = 0;
    let leaked = 0;
    for (let seed = 0; seed < 6; seed++) {
      const w = run(21 + seed * 977, 60 * 40, (world) => {
        world.targetX = LANE_W * 0.25;
      });
      kills += w.kills;
      leaked += w.leaked;
    }
    const resolved = kills + leaked;
    expect(resolved).toBeGreaterThan(200);
    expect(leaked / resolved).toBeLessThan(0.1);
  });

  it('closes on a squad parked far from the spawn column', () => {
    const w = new World(endlessLevel(4), VIEW_H);
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
    const w = new World(endlessLevel(11), VIEW_H);
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

  it('leaves objectives intact when the squad never lines up on them', () => {
    const w = new World(endlessLevel(11), VIEW_H);
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

describe('enemy types', () => {
  it('scales brute hp with distance and leaves grunts flat', () => {
    expect(enemyHp(GRUNT, 0)).toBe(enemyHp(GRUNT, 8));
    expect(enemyHp(BRUTE, 4)).toBeGreaterThan(enemyHp(BRUTE, 0));
  });

  it('picks types in proportion to their weights', () => {
    const weights = new Float32Array(ENEMY_KINDS);
    weights[GRUNT] = 3;
    weights[RUNNER] = 1;
    expect(pickType(weights, 0.0)).toBe(GRUNT);
    expect(pickType(weights, 0.74)).toBe(GRUNT);
    expect(pickType(weights, 0.9)).toBe(RUNNER);
  });

  it('introduces every archetype over the course of a run', () => {
    const seen = new Set<number>();
    for (let s = 0; s < 8 && seen.size < ENEMY_KINDS; s++) {
      const w = new World(endlessLevel(s * 31 + 5), VIEW_H);
      for (let i = 0; i < 60 * 90 && w.state === 'running'; i++) {
        seekObjectives(900)(w);
        w.step(1 / 60);
        for (let r = 0; r < w.redCount; r++) seen.add(w.redType[r]);
      }
    }
    expect(seen.size).toBe(ENEMY_KINDS);
  });

  it('charges more than one blue per special that gets through', () => {
    // Attribution has to hold as an identity: every body lost is a contact or a
    // breakthrough, priced by the type that caused it.
    const w = run(17, 60 * 90, seekObjectives(900));
    let events = 0;
    let priced = 0;
    for (let t = 0; t < ENEMY_KINDS; t++) {
      events += w.contactsByType[t] + w.leaksByType[t];
      priced += (w.contactsByType[t] + w.leaksByType[t]) * ENEMIES[t].cost;
    }
    expect(events).toBeGreaterThan(50);
    expect(priced).toBeGreaterThan(events);
  });

  it('counts a ranged kill separately from one that reaches the crowd', () => {
    const w = run(23, 60 * 60, seekObjectives(900));
    let shot = 0;
    let reached = 0;
    for (let t = 0; t < ENEMY_KINDS; t++) {
      shot += w.killsByType[t];
      reached += w.contactsByType[t];
    }
    // A kill at range costs nothing; only the second number prices bodies.
    expect(shot).toBeGreaterThan(reached);
    expect(w.kills).toBe(shot + reached);
  });

  it('spends a bullet as a damage pool rather than one kill per pierce', () => {
    const w = new World(endlessLevel(9), VIEW_H);
    w.count = 400;
    // Step once so anchorY is real: placing the brute relative to an unstepped
    // world drops it inside the crowd's own radius, where it contacts instantly.
    w.step(1 / 60);
    // The squad advances at SCROLL_SPEED, so the standoff has to outlast the
    // window: far enough that the crowd cannot close on a stationary target
    // before the bullets arrive.
    const standoff = w.radiusY + 700;
    w.redCount = 1;
    w.redX[0] = w.anchorX;
    w.redY[0] = w.anchorY + standoff;
    w.redType[0] = BRUTE;
    w.redHp[0] = 1e6;
    w.redSpeed[0] = 0;
    w.redOff[0] = 0;
    for (let i = 0; i < 70; i++) w.step(1 / 60);
    // Found by scan, not by index: swap-removal of other reds reshuffles slots.
    let brute = -1;
    for (let i = 0; i < w.redCount; i++) if (w.redType[i] === BRUTE) brute = i;
    expect(brute).toBeGreaterThanOrEqual(0);
    // It survived, but the fire landed: under a one-kill-per-pierce model a
    // single bullet would have deleted it regardless of hp.
    expect(w.redHp[brute]).toBeLessThan(1e6);
  });
});

describe('turrets', () => {
  it('can be broken by squad fire from a plausible playing position', () => {
    const level = CAMPAIGN.find((l) => (l.structures.turretFirst ?? 0) > 0)!;
    expect(level).toBeDefined();
    const w = new World(level, VIEW_H);
    const turret = w.objectives.find((o) => o.kind === 'turret');
    expect(turret).toBeDefined();
    if (!turret) return;
    const budget = Math.ceil(((level.length / SCROLL_SPEED) * 1.35 + 10) * 60);
    for (let i = 0; i < budget && !turret.broken; i++) {
      w.count = Math.max(w.count, 200);  // keep enough squad to fire and stay alive
      w.targetX = turret.x;
      w.step(1 / 60);
    }
    expect(turret.broken).toBe(true);
  }, 15_000);

  it('fires while in TURRET_RANGE, registers kills, and stops beyond it', () => {
    const level = CAMPAIGN.find((l) => (l.structures.turretFirst ?? 0) > 0)!;
    const w = new World(level, VIEW_H);
    const turret = w.objectives.find((o) => o.kind === 'turret');
    if (!turret) return;

    // Manually flip the turret and advance to just within range
    turret.hp = 0;
    turret.broken = true;
    while (w.anchorY < turret.y - TURRET_RANGE + 50 && w.state === 'running') {
      w.step(1 / 60);
    }
    w.count = 200;

    // Should emit at least one turret bullet within the first 30 frames
    let firedInRange = false;
    for (let i = 0; i < 30 && w.state === 'running'; i++) {
      w.step(1 / 60);
      for (let j = 0; j < w.bulletCount; j++) {
        if (w.bulFromTurret[j]) { firedInRange = true; break; }
      }
      if (firedInRange) break;
    }
    expect(firedInRange).toBe(true);

    // Kills should accumulate while the squad and turret are in range
    const killsBefore = w.turretKills;
    for (let i = 0; i < 180 && w.state === 'running' && w.anchorY < turret.y + TURRET_RANGE; i++) {
      w.step(1 / 60);
    }
    expect(w.turretKills).toBeGreaterThan(killsBefore);

    // Past TURRET_RANGE the turret is silent; let in-flight bullets expire (2s)
    while (w.anchorY < turret.y + TURRET_RANGE + 100 && w.state === 'running') {
      w.step(1 / 60);
    }
    for (let i = 0; i < 120 && w.state === 'running'; i++) w.step(1 / 60);
    const frozen = w.turretKills;
    for (let i = 0; i < 60 && w.state === 'running'; i++) w.step(1 / 60);
    expect(w.turretKills).toBe(frozen);
  }, 20_000);

  /**
   * Flips the level's first turret and runs until it is inside TURRET_RANGE,
   * leaving the world one step short of firing. `silence` empties the wave list
   * and clears the swarm, which is the only way to get a red-free window inside
   * a real level: spawning happens inside `step`, before the turrets fire.
   */
  function armedTurret(silence: boolean) {
    const level = CAMPAIGN.find((l) => (l.structures.turretFirst ?? 0) > 0)!;
    const w = new World(level, VIEW_H);
    const turret = w.objectives.find((o) => o.kind === 'turret')!;
    turret.hp = 0;
    turret.broken = true;
    while (w.anchorY < turret.y - TURRET_RANGE + 50 && w.state === 'running') w.step(1 / 60);
    w.count = 200;
    if (silence) {
      (w as unknown as { waves: readonly unknown[] }).waves = [];
      w.redCount = 0;
    }
    return { w, turret };
  }

  /** Velocities of the turret bullets emitted by a single step. */
  function turretShots(w: World, dt = 1 / 60): { vx: number; vy: number }[] {
    w.bulletCount = 0;
    w.step(dt);
    const out: { vx: number; vy: number }[] = [];
    for (let j = 0; j < w.bulletCount; j++) {
      if (w.bulFromTurret[j]) out.push({ vx: w.bulVX[j], vy: w.bulVY[j] });
    }
    return out;
  }

  /** Drops a red at (x, y) with enough hp to survive the frame it is shot at. */
  function plantRed(w: World, x: number, y: number): void {
    const i = w.redCount++;
    w.redX[i] = x;
    w.redY[i] = y;
    w.redSpeed[i] = 0;
    w.redOff[i] = 0;
    w.redType[i] = GRUNT;
    w.redHp[i] = 1e6;
  }

  it('aims at a red that is off its own column, not straight up the lane', () => {
    const { w, turret } = armedTurret(true);
    plantRed(w, turret.x + 300, turret.y + 120);
    turret.fireTimer = 1 / 12;

    const shots = turretShots(w);
    expect(shots.length).toBeGreaterThan(0);
    // Pointed right and forward, which a fixed forward emitter never is.
    expect(shots[0].vx).toBeGreaterThan(0);
    expect(shots[0].vy).toBeGreaterThan(0);
    expect(Math.hypot(shots[0].vx, shots[0].vy)).toBeCloseTo(1000, 0);
  }, 20_000);

  it('shoots backwards at a red behind it rather than up an empty lane', () => {
    const { w, turret } = armedTurret(true);
    plantRed(w, turret.x, turret.y - 250);
    turret.fireTimer = 1 / 12;

    const shots = turretShots(w);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].vy).toBeLessThan(0);
  }, 20_000);

  it('picks the nearest red of several', () => {
    const { w, turret } = armedTurret(true);
    // Both planted on whichever side of the turret the lane has room for, so
    // neither is quietly dragged somewhere else by the corridor clamp.
    const dir = turret.x < LANE_W / 2 ? 1 : -1;
    plantRed(w, turret.x + dir * 460, turret.y + 80);   // far
    plantRed(w, turret.x + dir * 120, turret.y + 80);   // near
    turret.fireTimer = 1 / 12;

    const shots = turretShots(w);
    expect(shots.length).toBeGreaterThan(0);

    // Work out the nearest red from where the reds actually ended up, then
    // assert the shot is parallel to it.
    let bx = 0, by = 0, best = Infinity;
    for (let i = 0; i < w.redCount; i++) {
      const dx = w.redX[i] - turret.x;
      const dy = w.redY[i] - turret.y;
      const d = Math.hypot(dx, dy);
      if (d < best) { best = d; bx = dx; by = dy; }
    }
    const cross = (shots[0].vx * by - shots[0].vy * bx) / (1000 * best);
    expect(Math.abs(cross)).toBeLessThan(1e-3);
  }, 20_000);

  it('holds fire with no target, and does not dump the lull as a burst', () => {
    const { w, turret } = armedTurret(true);

    // Two full seconds in range with nothing to shoot at.
    let fired = 0;
    for (let i = 0; i < 120 && w.state === 'running'; i++) fired += turretShots(w).length;
    expect(fired).toBe(0);

    // A red arrives: one shot, not twenty-four banked ones.
    plantRed(w, turret.x + 100, turret.y + 200);
    expect(turretShots(w).length).toBeLessThanOrEqual(1);
  }, 20_000);

  it('shoots through structures rather than breaking them for free', () => {
    const { w, turret } = armedTurret(true);
    // A crate parked on the line between the turret and its only target.
    const crate = w.objectives.find((o) => o.kind !== 'turret' && !o.resolved && o.y > turret.y)!;
    Object.assign(crate, { x: turret.x, y: turret.y + 300 });
    crate.hp = 1e6;
    plantRed(w, turret.x, turret.y + 600);
    // Stepped normally, not through turretShots: that clears bullets in flight,
    // and these need to live long enough to cross the crate.
    let inFlight = 0;
    for (let i = 0; i < 60 && w.state === 'running'; i++) {
      // Squad on the far side of the lane, so none of its own fire reaches the crate.
      w.targetX = LANE_W - turret.x;
      w.step(1 / 60);
      for (let j = 0; j < w.bulletCount; j++) inFlight += w.bulFromTurret[j];
    }
    expect(inFlight).toBeGreaterThan(0);
    expect(crate.hp).toBe(1e6);
    expect(crate.broken).toBe(false);
  }, 20_000);

  it('credits identical turret kills to two worlds built from the same level', () => {
    const level = CAMPAIGN.find((l) => (l.structures.turretFirst ?? 0) > 0)!;
    const run = () => {
      const w = new World(level, VIEW_H);
      for (const o of w.objectives) {
        if (o.kind === 'turret') { o.hp = 0; o.broken = true; }
      }
      for (let i = 0; i < 3600 && w.state === 'running'; i++) {
        w.count = Math.max(w.count, 200);
        w.step(1 / 60);
      }
      return w.turretKills;
    };
    const a = run();
    expect(a).toBeGreaterThan(0);
    expect(run()).toBe(a);
  }, 30_000);
});

describe('weapon pickups', () => {
  /** Runs until the squad passes `o`, holding a fixed lane position. */
  function passAt(seed: number, holdX: (o: { x: number }) => number) {
    const w = new World(endlessLevel(seed), VIEW_H);
    w.count = 500;
    // Not the first crate: it sits ~0.6s into the run, before a single volley
    // has landed, so it would test spawn timing rather than the pickup rule.
    const crate = w.objectives.find((o) => o.kind === 'weapon' && o.y > 2500);
    expect(crate).toBeDefined();
    if (!crate) throw new Error('no weapon crate');
    while (w.anchorY < crate.y && w.state === 'running') {
      w.targetX = holdX(crate);
      w.step(1 / 60);
    }
    return { w, crate };
  }

  it('grants the weapon when the crowd runs over the broken crate', () => {
    const { w, crate } = passAt(11, (o) => o.x);
    expect(crate.broken).toBe(true);
    expect(crate.collected).toBe(true);
    expect(w.weaponTier).toBeGreaterThan(0);
  });

  it('leaves a broken crate behind when the crowd passes wide of it', () => {
    // Shot open from across the lane, then not driven over: breaking it is only
    // half the job, the gun still has to be picked up.
    const { w, crate } = passAt(11, (o) => (o.x < LANE_W / 2 ? LANE_W - 30 : 30));
    expect(crate.resolved).toBe(true);
    expect(crate.collected).toBe(false);
    expect(w.weaponTier).toBe(0);
  });

  it('gives nothing for running over a crate that was never broken', () => {
    const w = new World(endlessLevel(11), VIEW_H);
    // Too few blues to crack it open before it is reached.
    w.count = 3;
    const crate = w.objectives.find((o) => o.kind === 'weapon' && o.y > 2500);
    if (!crate) throw new Error('no weapon crate');
    // Unbreakable for this test: hp is mutable, maxHp is not, so drive hp up
    // rather than reshaping the objective.
    crate.hp = 1e9;
    while (w.anchorY < crate.y && w.state === 'running') {
      w.targetX = crate.x;
      w.step(1 / 60);
    }
    expect(crate.broken).toBe(false);
    expect(crate.collected).toBe(false);
    expect(w.weaponTier).toBe(0);
  });
});

describe('viewport', () => {
  it('plays out identically whatever shape the screen is', () => {
    const level = CAMPAIGN[3]!;
    const play = (viewH: number) => {
      const w = new World(level, viewH);
      for (let i = 0; i < 40 * 60 && w.state === 'running'; i++) {
        seekObjectives(900)(w);
        w.step(1 / 60);
      }
      return [w.state, w.count, w.kills, w.leaked, w.anchorY];
    };
    const tuned = play(VIEW_H);
    expect(play(960)).toEqual(tuned);   // tablet portrait
    expect(play(333)).toEqual(tuned);   // phone landscape
    expect(play(2100)).toEqual(tuned);  // tall phone
  }, 30_000);
});

describe('reward flash', () => {
  it('stays dark passing a structure that was never broken, past the render cap', () => {
    const w = new World(endlessLevel(11), VIEW_H);
    const crate = w.objectives.find((o) => o.kind !== 'turret' && o.y > 2500)!;
    crate.hp = 1e9;
    while (!crate.resolved && w.state === 'running') {
      w.count = MAX_BLUE_RENDER * 3;
      w.step(1 / 60);
    }
    expect(crate.collected).toBe(false);
    // 0.35 is what the flash is set to on the frame a reward lands.
    expect(w.gateFlash).not.toBe(0.35);
  });
});

describe('weapon tiers', () => {
  it('lets fewer reds through at every tier, so a later gun is always an upgrade', () => {
    // Regression: the shotgun's fan once out-killed the minigun.
    //
    // Measured in real play rather than against a synthetic wall, because the
    // wall's own geometry decides the answer: a wide shallow one flatters a fan,
    // a deep one flatters a straight stream. What the player actually feels is
    // how much of the swarm reaches them, so that is what is asserted.
    const breaches = WEAPONS.map((_, tier) => {
      let total = 0;
      // 75s and eight seeds: a shorter window leaves counts in the tens, where
      // the gap between adjacent tiers is inside the noise.
      for (let seed = 0; seed < 8; seed++) {
        const w = new World(endlessLevel(seed * 7919 + 13), VIEW_H);
        for (let i = 0; i < 75 * 60 && w.state === 'running'; i++) {
          w.weaponTier = tier;
          seekObjectives(900)(w);
          w.step(1 / 60);
        }
        total += w.leaked;
        for (let t = 0; t < ENEMY_KINDS; t++) total += w.contactsByType[t];
      }
      return total;
    });
    for (let t = 1; t < breaches.length; t++) {
      expect(breaches[t]).toBeLessThan(breaches[t - 1] as number);
    }
  }, 30_000);
});
