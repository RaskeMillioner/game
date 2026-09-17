import { BRUTE, EXPLODER, GRUNT, RUNNER } from './enemies.js';
import { DEFAULT_STRUCTURES, LevelDef } from './levels.js';

/**
 * The campaign. Every level starts at 16 blue with a pistol — there are no
 * persistent upgrades — so a level's difficulty number means the same thing
 * from the first level to the last, and the ramp is visible here as a column
 * rather than hidden in save state.
 *
 * Seeds are written down, not generated. Level 7 has to be level 7 on every
 * device, or the probe measures one game and the player plays another.
 *
 * Lengths are in world units; at SCROLL_SPEED the shortest is about 50 seconds
 * and the longest about 95. Phase 9 extends this to twenty levels and tunes
 * each one against the probe's per-level win rate.
 */
export const CAMPAIGN: readonly LevelDef[] = [
  {
    id: 1,
    name: 'FIRST CONTACT',
    seed: 1013904223,
    template: 'tide',
    difficulty: 0.40,
    length: 12000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.2 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 2,
    name: 'OPEN GROUND',
    seed: 1562898340,
    template: 'tide',
    difficulty: 0.52,
    length: 13500,
    mix: { [GRUNT]: 1, [RUNNER]: 0.3 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 3,
    name: 'SPRINTERS',
    seed: 2071394748,
    template: 'runner-rush',
    difficulty: 0.55,
    length: 14000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.5 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 4,
    name: 'THE PRESS',
    seed: 623564821,
    template: 'choke',
    difficulty: 0.76,
    length: 15000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.35 },
    structures: DEFAULT_STRUCTURES,
    // The level the template is named for: the lane closes to two-thirds
    // through the middle, so the crowd is thinnest exactly where the tide
    // thickens.
    corridor: { shape: 'pinch', tightness: 0.46, at: 0.5, span: 0.26 },
  },
  {
    id: 5,
    name: 'HEAVY',
    seed: 1927844092,
    template: 'brute-wall',
    difficulty: 0.55,
    length: 15500,
    mix: { [GRUNT]: 1, [RUNNER]: 0.3, [BRUTE]: 0.06 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 6,
    name: 'SHORT FUSE',
    seed: 884713290,
    template: 'tide',
    difficulty: 0.80,
    length: 16000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.35, [EXPLODER]: 0.10 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 7,
    name: 'RED MILE',
    seed: 1340298744,
    template: 'tide',
    difficulty: 0.85,
    length: 18000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.35, [EXPLODER]: 0.09, [BRUTE]: 0.05 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 8,
    name: 'STAMPEDE',
    seed: 400910273,
    template: 'runner-rush',
    difficulty: 1.30,
    length: 18000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.6, [EXPLODER]: 0.08 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 9,
    name: 'THE WALL',
    seed: 1770923811,
    template: 'brute-wall',
    difficulty: 0.67,
    length: 19000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.3, [EXPLODER]: 0.07, [BRUTE]: 0.09 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 10,
    name: 'NARROWS',
    seed: 2044938102,
    template: 'choke',
    difficulty: 0.98,
    length: 20000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.4, [EXPLODER]: 0.09, [BRUTE]: 0.06 },
    structures: DEFAULT_STRUCTURES,
    // Longer and tighter than THE PRESS, and it swings while it squeezes:
    // the lane you are threading is also moving under you.
    corridor: { shape: 'bend', tightness: 0.42, sway: 0.42, at: 0.52, span: 0.46 },
  },
  {
    id: 11,
    name: 'GAUNTLET',
    seed: 731209884,
    template: 'gauntlet',
    difficulty: 1.04,
    length: 21000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.4, [EXPLODER]: 0.10, [BRUTE]: 0.08 },
    structures: DEFAULT_STRUCTURES,
  },
  {
    id: 12,
    name: 'RED TIDE',
    seed: 1099087420,
    template: 'gauntlet',
    difficulty: 1.02,
    length: 23000,
    mix: { [GRUNT]: 1, [RUNNER]: 0.45, [EXPLODER]: 0.12, [BRUTE]: 0.09 },
    structures: DEFAULT_STRUCTURES,
  },
];

export function levelById(id: number): LevelDef | undefined {
  return CAMPAIGN.find((l) => l.id === id);
}
