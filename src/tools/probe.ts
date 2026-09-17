/**
 * Headless balance probe. Runs many seeded runs under scripted strategies and
 * prints the survival curve. This is the whole point of keeping sim/ free of
 * canvas: balance gets measured, not guessed.
 *
 *   npx esbuild src/tools/probe.ts --bundle --platform=node --format=esm \
 *     --outfile=.probe.mjs && node .probe.mjs
 */
import { CAMPAIGN } from '../sim/campaign.js';
import { LANE_W, SCROLL_SPEED } from '../sim/config.js';
import { ENEMIES, ENEMY_KINDS } from '../sim/enemies.js';
import { gateIsGood, GATE_PANEL_W } from '../sim/gates.js';
import { centreAt, halfWidthAt, holeCentreAt, holeHalfWidthAt } from '../sim/corridor.js';
import { endlessLevel, LevelDef } from '../sim/levels.js';
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
    // Stay on it until it is resolved, not merely broken: a cracked crate is a
    // pickup lying in the lane, and the crowd has to run over it to take it.
    const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
    if (o && o.y - w.anchorY < commit) {
      w.targetX = o.x;
      return;
    }
    fallback(w, t);
  };
}

/**
 * Plays like `obj-light` but commits to a side before a hazard opens.
 *
 * Exists to answer whether a hazard is a skill test or a flat tax: every other
 * strategy is blind to them, so a toll they all pay equally could just as
 * easily be unavoidable. If this one pays materially less, the skill is real
 * and the others simply do not have it.
 */
function pitAware(commit: number): Strategy {
  const fallback = objectiveSeeker(commit);
  return (w, t) => {
    // Aim at the side of the hazard where it is *widest*, not where it first
    // appears. Sampling the nearest hole instead means chasing a gap that is
    // still easing open, which lands the squad near the lane's centre at
    // exactly the moment the hole arrives there — a mistake that reads as
    // hazard-awareness while paying the same toll as ignoring them.
    let bestY = -1;
    let bestHw = 0;
    for (let ahead = 200; ahead < 2400; ahead += 100) {
      const y = w.anchorY + ahead;
      const hw = holeHalfWidthAt(w.corridor, y);
      if (hw > bestHw) {
        bestHw = hw;
        bestY = y;
      }
    }
    if (bestY < 0) {
      fallback(w, t);
      return;
    }
    const hc = holeCentreAt(w.corridor, bestY);
    const centre = centreAt(w.corridor, bestY);
    const half = halfWidthAt(w.corridor, bestY);
    const left = (hc - bestHw) - (centre - half);
    const right = (centre + half) - (hc + bestHw);
    w.targetX = left >= right
      ? (centre - half) + left / 2
      : (centre + half) - right / 2;
  };
}

/**
 * Objective play that also routes around a pit instead of ploughing through it.
 *
 * The fair comparison against `obj-light`: same priorities, same commitment
 * distance, differing only in whether it steers around hazards. `pit-aware`
 * above dodges perfectly and starves doing it, which makes its toll per peak
 * body meaningless — it dies before it has a crowd to lose.
 */
function objectivePitSeeker(commit: number): Strategy {
  const fallback = objectiveSeeker(commit);
  return (w, t) => {
    let bestY = -1;
    let bestHw = 0;
    for (let ahead = 0; ahead < 1400; ahead += 100) {
      const y = w.anchorY + ahead;
      const hw = holeHalfWidthAt(w.corridor, y);
      if (hw > bestHw) {
        bestHw = hw;
        bestY = y;
      }
    }
    if (bestY < 0) {
      fallback(w, t);
      return;
    }
    const hc = holeCentreAt(w.corridor, bestY);
    const centre = centreAt(w.corridor, bestY);
    const half = halfWidthAt(w.corridor, bestY);
    // Takes the side the objective it was already heading for is on, so
    // dodging costs it the pickup only when the pit is genuinely in the way.
    const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
    const want = o && o.y - w.anchorY < commit ? o.x : w.anchorX;
    const leftMid = (centre - half) + ((hc - bestHw) - (centre - half)) / 2;
    const rightMid = (centre + half) - ((centre + half) - (hc + bestHw)) / 2;
    w.targetX = Math.abs(want - leftMid) <= Math.abs(want - rightMid) ? leftMid : rightMid;
  };
}

const strategies: Record<string, Strategy> = {
  passive: (w) => { w.targetX = LANE_W / 2; },
  optimal: gateSeeker(true),
  worst: gateSeeker(false),
  sweep: (w, t) => { w.targetX = LANE_W / 2 + Math.sin(t * 0.7) * 300; },
  'obj-greedy': objectiveSeeker(2400),
  'obj-light': objectiveSeeker(900),
  'pit-aware': pitAware(900),
  'obj-pit': objectivePitSeeker(900),
};

interface Result {
  seconds: number; kills: number; peak: number; died: boolean; won: boolean;
  broken: number; passed: number; leak: number; hazard: number;
  leaksByType: number[]; killsByType: number[]; contactsByType: number[];
}

function runOne(strategy: Strategy, seed: number): Result {
  return runLevel(strategy, endlessLevel(seed));
}

function runLevel(strategy: Strategy, level: LevelDef): Result {
  const w = new World(level, VIEW_H);
  let peak = w.count;
  let t = 0;
  // A finite level can take longer than the endless cap, so the budget follows
  // the level's own length rather than a constant that quietly fails long ones.
  const budget = Number.isFinite(level.length)
    ? (level.length / SCROLL_SPEED) * 1.35 + 10
    : MAX_SECONDS;
  const steps = Math.ceil(budget * 60);
  for (let i = 0; i < steps; i++) {
    strategy(w, t);
    w.step(DT);
    t += DT;
    if (w.count > peak) peak = w.count;
    if (w.state === 'dead') break;
  }
  const seen = w.objectives.filter((o) => o.resolved);
  return {
    seconds: t, kills: w.kills, peak,
    died: w.state === 'dead', won: w.state === 'won',
    broken: seen.filter((o) => o.broken).length,
    passed: seen.length,
    leak: w.kills + w.leaked > 0 ? w.leaked / (w.kills + w.leaked) : 0,
    hazard: w.hazardLosses,
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
  const w = new World(endlessLevel(s * 104729 + 3), VIEW_H);
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

/**
 * Campaign tuning. The endless columns above answer "how long does a good run
 * last"; a campaign needs a different question answered — *is level 12 tuned?*
 *
 * Win rate is measured over seed variants of each level rather than over its
 * one stored seed: the shipped level is deterministic, so a single run of it
 * returns 0% or 100% and tells you nothing. What is being measured is whether
 * the template and difficulty put the level in band; the stored seed is one
 * draw from that band.
 */
/**
 * The target is a ramp, not a constant. A first level that kills half the
 * players who reach it is a broken first level however well it sits inside a
 * 45-70% band; the band is where the campaign is meant to *end up*, and the
 * opening is meant to be winnable while you are still learning the controls.
 */
const WIN_FIRST = 0.95;
const WIN_LAST = 0.50;
const WIN_TOLERANCE = 0.12;
const LEVEL_SEEDS = 40;

function targetWin(index: number, total: number): number {
  return total < 2 ? WIN_LAST : WIN_FIRST + (WIN_LAST - WIN_FIRST) * (index / (total - 1));
}

console.log('\nlevel                  template     diff   len   win%  target   mean(s)  peak   leak%   pit   flag');
const curve: number[] = [];
for (const [index, level] of CAMPAIGN.entries()) {
  const results: Result[] = [];
  for (let i = 0; i < LEVEL_SEEDS; i++) {
    results.push(runLevel(strategies['obj-light'] as Strategy, { ...level, seed: (level.seed + i * 2654435761) >>> 0 }));
  }
  const win = results.filter((r) => r.won).length / results.length;
  curve.push(win);
  const target = targetWin(index, CAMPAIGN.length);
  const flag = win < target - WIN_TOLERANCE ? 'HARD' : win > target + WIN_TOLERANCE ? 'EASY' : '';
  console.log(
    `${String(level.id).padStart(2)} ${level.name.padEnd(16)} ${level.template.padEnd(12)}` +
    ` ${level.difficulty.toFixed(2)} ${String(level.length / 1000).padStart(5)}` +
    ` ${(win * 100).toFixed(0).padStart(5)}% ${(target * 100).toFixed(0).padStart(6)}%` +
    ` ${avg(results, (r) => r.seconds).toFixed(1).padStart(8)}` +
    ` ${avg(results, (r) => r.peak).toFixed(0).padStart(6)} ${(avg(results, (r) => r.leak) * 100).toFixed(1).padStart(6)}%` +
    ` ${avg(results, (r) => r.hazard).toFixed(0).padStart(6)}` +
    `   ${flag}`,
  );
}

// The ramp as a shape rather than a list of assertions: a campaign that dips in
// the middle is a tuning bug you cannot see one level at a time.
console.log(`\ndifficulty curve (win rate; | marks this level's target window)`);
for (let i = 0; i < curve.length; i++) {
  const win = curve[i] as number;
  const target = targetWin(i, curve.length);
  const cells = Math.round(win * 40);
  const low = Math.round((target - WIN_TOLERANCE) * 40);
  const high = Math.round((target + WIN_TOLERANCE) * 40);
  let bar = '';
  for (let c = 0; c < 40; c++) {
    if (c < cells) bar += '#';
    else if (c === low || c === high) bar += '|';
    else bar += ' ';
  }
  console.log(`${String(CAMPAIGN[i]?.id).padStart(2)} |${bar}| ${(win * 100).toFixed(0).padStart(3)}%`);
}

/**
 * Do hazards separate careful play from careless? That is the only question
 * that decides whether they earn their place: a hazard everyone walks into, or
 * one nobody ever touches, is not a skill test either way.
 *
 * Measured on the two levels that have them, across strategies that differ
 * precisely in how much attention they pay to where they are going.
 */
console.log('\nhazard toll by strategy (levels 4 and 10)');
// Priced against peak squad, not in raw bodies: the toll is proportional, so a
// three-thousand-strong crowd pays more in absolute terms for the very same
// mistake, and the raw column flatters whoever died before the pit.
console.log('strategy        bodies   as % of peak   win%');
for (const name of ['passive', 'obj-light', 'obj-pit', 'pit-aware'] as const) {
  let lost = 0;
  let peak = 0;
  let won = 0;
  let runs = 0;
  for (const level of CAMPAIGN.filter((l) => (l.hazards?.length ?? 0) > 0)) {
    for (let i = 0; i < 12; i++) {
      const r = runLevel(strategies[name] as Strategy, { ...level, seed: (level.seed + i * 2654435761) >>> 0 });
      lost += r.hazard;
      peak += r.peak;
      if (r.won) won++;
      runs++;
    }
  }
  console.log(
    `${name.padEnd(14)} ${(lost / runs).toFixed(0).padStart(7)} ` +
    `${((lost / peak) * 100).toFixed(1).padStart(13)}% ${((won / runs) * 100).toFixed(0).padStart(6)}%`,
  );
}
