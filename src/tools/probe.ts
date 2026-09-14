/**
 * Headless balance probe. Runs many seeded runs under scripted strategies and
 * prints the survival curve. This is the whole point of keeping sim/ free of
 * canvas: balance gets measured, not guessed.
 *
 *   npx esbuild src/tools/probe.ts --bundle --platform=node --format=esm \
 *     --outfile=.probe.mjs && node .probe.mjs
 */
import { LANE_W } from '../sim/config.js';
import { gateIsGood, GATE_PANEL_W } from '../sim/gates.js';
import { multiplierOf } from '../sim/objectives.js';
import { World } from '../sim/world.js';

const VIEW_H = 1560;
const DT = 1 / 60;
const MAX_SECONDS = 150;

type Strategy = (w: World, t: number) => void;

/** Steers to whichever side of the next gate is better (or worse, if inverted). */
function gateSeeker(preferGood: boolean): Strategy {
  return (w) => {
    const next = w.gates.find((g) => !g.taken && g.y > w.anchorY - 200);
    if (!next) {
      w.targetX = LANE_W / 2;
      return;
    }
    const leftGood = gateIsGood(next.left);
    const rightGood = gateIsGood(next.right);
    let goLeft: boolean;
    if (leftGood !== rightGood) goLeft = leftGood === preferGood;
    else goLeft = (scoreOp(next.left, w.count) >= scoreOp(next.right, w.count)) === preferGood;
    w.targetX = next.cx + (goLeft ? -GATE_PANEL_W : GATE_PANEL_W) * 0.5;
  };
}

/** Value of an op in bodies-equivalent, which requires knowing the current count. */
function scoreOp(op: { kind: string; value: number }, count: number): number {
  if (op.kind === 'mul') return count * (op.value - 1);
  if (op.kind === 'add') return op.value;
  if (op.kind === 'weapon') return count * 0.6;
  return -1e9;
}

/**
 * Diverts onto the next objective to shoot it, falling back to gate seeking.
 * `commit` is how far ahead (world units) it is willing to break off for one.
 */
function objectiveSeeker(commit: number): Strategy {
  const fallback = gateSeeker(true);
  return (w, t) => {
    const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
    if (o && !o.broken && o.y - w.anchorY < commit) {
      w.targetX = o.x;
      return;
    }
    fallback(w, t);
  };
}

const strategies: Record<string, Strategy> = {
  passive: (w) => { w.targetX = LANE_W / 2; },
  optimal: gateSeeker(true),
  worst: gateSeeker(false),
  sweep: (w, t) => { w.targetX = LANE_W / 2 + Math.sin(t * 0.7) * 300; },
  'obj-greedy': objectiveSeeker(2400),
  'obj-light': objectiveSeeker(900),
};

interface Result {
  seconds: number; kills: number; peak: number; died: boolean;
  broken: number; passed: number; mult: number; leak: number;
}

function runOne(strategy: Strategy, seed: number): Result {
  const w = new World(seed, VIEW_H);
  let peak = w.count;
  let t = 0;
  const steps = MAX_SECONDS * 60;
  for (let i = 0; i < steps; i++) {
    strategy(w, t);
    w.step(DT);
    t += DT;
    if (w.count > peak) peak = w.count;
    if (w.state === 'dead') break;
  }
  const seen = w.objectives.filter((o) => o.resolved);
  const boards = seen.filter((o) => o.kind === 'multiplier');
  const mult = boards.length
    ? boards.reduce((a, o) => a + multiplierOf(o), 0) / boards.length
    : 1;
  return {
    seconds: t, kills: w.kills, peak, died: w.state === 'dead',
    broken: seen.filter((o) => o.broken).length,
    passed: seen.length,
    mult,
    leak: w.kills + w.leaked > 0 ? w.leaked / (w.kills + w.leaked) : 0,
  };
}

const avg = (rs: Result[], f: (r: Result) => number): number =>
  rs.reduce((a, r) => a + f(r), 0) / rs.length;

const RUNS = 60;
console.log(`strategy     survived(s)  median  died%   peak squad   kills  obj brk/seen  avg board  leak%`);
for (const [name, strategy] of Object.entries(strategies)) {
  const results: Result[] = [];
  for (let s = 0; s < RUNS; s++) results.push(runOne(strategy, s * 7919 + 13));
  const times = results.map((r) => r.seconds).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const diedPct = (results.filter((r) => r.died).length / results.length) * 100;
  const peak = Math.round(results.reduce((a, r) => a + r.peak, 0) / results.length);
  const kills = Math.round(results.reduce((a, r) => a + r.kills, 0) / results.length);
  console.log(
    `${name.padEnd(12)} ${mean.toFixed(1).padStart(10)} ${median.toFixed(1).padStart(7)} ` +
    `${diedPct.toFixed(0).padStart(5)}% ${String(peak).padStart(11)} ${String(kills).padStart(7)}` +
    `  ${avg(results, (r) => r.broken).toFixed(1)}/${avg(results, (r) => r.passed).toFixed(1)}` +
    `        x${avg(results, (r) => r.mult).toFixed(2)}  ${(avg(results, (r) => r.leak) * 100).toFixed(1)}%`,
  );
}

// Early-death check: the opening must not be a coin flip.
let earlyDeaths = 0;
const EARLY_RUNS = 300;
for (let s = 0; s < EARLY_RUNS; s++) {
  const w = new World(s * 104729 + 3, VIEW_H);
  for (let i = 0; i < 15 * 60 && w.state === 'running'; i++) {
    w.targetX = LANE_W / 2;
    w.step(DT);
  }
  if (w.state === 'dead') earlyDeaths++;
}
console.log(`\nblind player dead within 15s: ${((earlyDeaths / EARLY_RUNS) * 100).toFixed(1)}% of ${EARLY_RUNS} runs`);
