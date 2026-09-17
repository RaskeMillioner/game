/**
 * Effective weapon power, measured against a saturated target field.
 *
 * Measuring kills in a normal run tells you the spawn rate, not the gun: the
 * swarm supplies fewer reds per second than any weapon can chew through, so
 * every tier scores the same. This holds a replenished wall of high-hp targets
 * across the squad's frontage instead, and reports damage actually landed —
 * which is what separates a wide cone from a tight stream.
 *
 *   npx esbuild src/tools/weapons.ts --bundle --platform=node --format=esm \
 *     --outfile=.weapons.mjs && node .weapons.mjs
 */
import { LANE_W, WEAPONS } from '../sim/config.js';
import { GRUNT } from '../sim/enemies.js';
import { endlessLevel } from '../sim/levels.js';
import { World } from '../sim/world.js';

const VIEW_H = 1560;
const DT = 1 / 60;
const SECONDS = 8;
const WALL_COLS = 13;
const WALL_ROWS = 6;
const WALL = WALL_COLS * WALL_ROWS;
const FULL_HP = 1e7;

interface Result { dps: number; spread: number; kills: number }

/**
 * Damage per second landed, plus how many distinct columns of the wall were
 * touched — coverage is the half of weapon power that nominal dps hides.
 */
function measure(tier: number, count: number, seeds: number, hp = FULL_HP): Result {
  let damage = 0;
  let touched = 0;
  let kills = 0;
  for (let s = 0; s < seeds; s++) {
    const w = new World(endlessLevel(s * 5449 + 7), VIEW_H);
    w.count = count;
    w.step(DT);
    const hitCols = new Set<number>();
    for (let i = 0; i < SECONDS * 60; i++) {
      w.count = count;
      w.weaponTier = tier;
      w.targetX = LANE_W / 2;
      // Rebuild the wall every frame: fixed, saturated, and never dying, so the
      // only variable left is what the volley reaches.
      const frontage = w.radius * 2 + 260;
      w.redCount = WALL;
      for (let c = 0; c < WALL_COLS; c++) {
        for (let r = 0; r < WALL_ROWS; r++) {
          const j = c * WALL_ROWS + r;
          w.redX[j] = w.anchorX + ((c / (WALL_COLS - 1)) - 0.5) * frontage;
          w.redY[j] = w.anchorY + 420 + r * 210;
          w.redType[j] = GRUNT;
          w.redHp[j] = hp;
          w.redSpeed[j] = 0;
          w.redOff[j] = 0;
        }
      }
      w.step(DT);
      for (let j = 0; j < WALL && j < w.redCount; j++) {
        const dealt = hp - w.redHp[j];
        if (dealt > 0) {
          damage += dealt;
          hitCols.add(Math.floor(j / WALL_ROWS));
        }
      }
    }
    touched += hitCols.size;
    kills += w.kills;
  }
  return { dps: damage / seeds / SECONDS, spread: touched / seeds, kills: kills / seeds / SECONDS };
}

const SIZES = [60, 300, 900];
console.log('weapon     nominal/unit  ' + SIZES.map((n) => `dmg/s @${n}`.padStart(12)).join('') + '  cols  kills/s @900');
for (let t = 0; t < WEAPONS.length; t++) {
  const w = WEAPONS[t];
  const rows = SIZES.map((n) => measure(t, n, 3));
  // Against 1-hp targets, damage poured into an already-dead column is wasted,
  // so this is the number the player actually feels: coverage, not throughput.
  const lethal = measure(t, 900, 3, 1);
  console.log(
    `${w.name.padEnd(10)} ${(w.rate * w.power).toFixed(2).padStart(10)}  ` +
    rows.map((r) => r.dps.toFixed(0).padStart(12)).join('') +
    `  ${rows[2].spread.toFixed(0)}/${WALL_COLS}  ${lethal.kills.toFixed(1).padStart(12)}`,
  );
}
