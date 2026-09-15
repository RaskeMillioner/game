/**
 * Headless balance probe. Runs many seeded runs under scripted strategies and
 * prints the survival curve. This is the whole point of keeping sim/ free of
 * canvas: balance gets measured, not guessed.
 *
 *   npx esbuild src/tools/probe.ts --bundle --platform=node --format=esm \
 *     --outfile=.probe.mjs && node .probe.mjs
 */
import { LANE_W } from '../sim/config.js';
import { ENEMIES, ENEMY_KINDS } from '../sim/enemies.js';
import { gateIsGood, GATE_PANEL_W } from '../sim/gates.js';
import { World } from '../sim/world.js';

const VIEW_H = 1560;
const DT = 1 / 60;
const MAX_SECONDS = 150;

type Strategy = (w: World, t: number) => void;

/** Steers into the next gate if it is worth taking, and around it if not. */
function gateSeeker(preferGood: boolean): Strategy {
  return (w) => {
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
  broken: number; passed: number; leak: number;
  leaksByType: number[]; killsByType: number[]; contactsByType: number[];
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
  return {
    seconds: t, kills: w.kills, peak, died: w.state === 'dead',
    broken: seen.filter((o) => o.broken).length,
    passed: seen.length,
    leak: w.kills + w.leaked > 0 ? w.leaked / (w.kills + w.leaked) : 0,
    leaksByType: Array.from(w.leaksByType),
    killsByType: Array.from(w.killsByType),
    contactsByType: Array.from(w.contactsByType),
  };
}

const avg = (rs: Result[], f: (r: Result) => number): number =>
  rs.reduce((a, r) => a + f(r), 0) / rs.length;

const RUNS = 60;
console.log(`strategy     survived(s)  median  died%   peak squad   kills  obj brk/seen  leak%`);
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
    `  ${(avg(results, (r) => r.leak) * 100).toFixed(1)}%`,
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

// Per-type attribution: which archetype is actually ending runs, and how much
// of the squad each one costs. Blues lost is the number that matters — an
// exploder leaks rarely and still empties a quarter of the crowd when it does.
console.log('\ntype       shot   reached   broke through   blues lost   share');
{
  const totals = new Array(ENEMY_KINDS).fill(0).map(() => ({ shot: 0, reached: 0, leaked: 0 }));
  const RUNS_T = 60;
  for (let s = 0; s < RUNS_T; s++) {
    const r = runOne(strategies['obj-light'] as Strategy, s * 7919 + 13);
    for (let t = 0; t < ENEMY_KINDS; t++) {
      totals[t].shot += r.killsByType[t] ?? 0;
      totals[t].reached += r.contactsByType[t] ?? 0;
      totals[t].leaked += r.leaksByType[t] ?? 0;
    }
  }
  const lost = totals.map((t, i) => (t.leaked + t.reached) * ENEMIES[i].cost);
  const lostAll = lost.reduce((a, b) => a + b, 0) || 1;
  for (let t = 0; t < ENEMY_KINDS; t++) {
    console.log(
      `${ENEMIES[t].name.padEnd(10)} ${(totals[t].shot / RUNS_T).toFixed(0).padStart(4)} ` +
      `${(totals[t].reached / RUNS_T).toFixed(1).padStart(9)} ` +
      `${(totals[t].leaked / RUNS_T).toFixed(1).padStart(15)} ` +
      `${(lost[t] / RUNS_T).toFixed(0).padStart(13)} ` +
      `${((lost[t] / lostAll) * 100).toFixed(0).padStart(7)}%`,
    );
  }
}
