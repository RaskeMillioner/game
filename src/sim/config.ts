/**
 * Every number that decides how the game feels. Kept in one file on purpose:
 * tuning is the real work, and it should never require hunting through logic.
 */

/** Virtual lane width. All sim coordinates are in these units; the renderer scales to fit. */
export const LANE_W = 720;

export const SCROLL_SPEED = 240;
/** Squad sits this fraction of the view height up from the bottom. */
export const SQUAD_SCREEN_FRAC = 0.22;

export const START_BLUE = 10;
export const MAX_BLUE = 4000;
/** Only this many are ever drawn; past ~400 nobody can tell, and the HUD carries the truth. */
export const MAX_BLUE_RENDER = 400;
export const BLUE_SPACING = 11;
export const BLUE_FOLLOW = 11;
export const ANCHOR_FOLLOW = 14;
export const DRAG_GAIN = 1.15;

export const MAX_RED = 1400;
export const RED_SPEED_MIN = 110;
export const RED_SPEED_MAX = 155;
export const RED_RADIUS = 9;
/** How hard reds steer toward the squad, as a fraction of their run speed. */
export const RED_HOMING = 0.62;
export const CONTACT_PAD = 6;

export const MAX_BULLET = 1400;
export const BULLET_RADIUS = 5;
export const BULLET_LIFE = 1.1;

/**
 * Firing is emitter-capped: at most this many units actually spawn bullets, and
 * each bullet's pierce scales with true squad size. Without this, 400 units at
 * minigun cadence would mean 5600 bullets/second and a slideshow.
 */
export const MAX_EMITTERS = 26;
/**
 * Volleys lead the nearest threat instead of always firing straight up. Without
 * this, any lateral move drops effective DPS to zero and standing still beats
 * playing — which kills the gate choice the whole game rests on.
 */
export const AIM_MAX_ANGLE = 0.95;

export interface Weapon {
  readonly name: string;
  readonly rate: number;
  readonly pellets: number;
  readonly spread: number;
  readonly speed: number;
  /**
   * Multiplier on squad-size-derived damage. Nominal DPS per unit is rate*power,
   * so this is what keeps the tiers strictly increasing across very different
   * cadences: 2.5 -> 3.9 -> 5.4 -> 7.6 per unit.
   */
  readonly power: number;
}

export const WEAPONS: readonly Weapon[] = [
  { name: 'PISTOL', rate: 2.5, pellets: 1, spread: 0.0, speed: 900, power: 1.0 },
  { name: 'RIFLE', rate: 6.0, pellets: 1, spread: 0.02, speed: 1100, power: 0.65 },
  { name: 'SHOTGUN', rate: 2.0, pellets: 5, spread: 0.26, speed: 850, power: 2.7 },
  { name: 'MINIGUN', rate: 14.0, pellets: 1, spread: 0.06, speed: 1200, power: 0.54 },
];

export const GATE_SPACING = 1900;
export const GATE_FIRST = 1500;

export const MAX_CORPSE = 400;
export const CORPSE_LIFE = 4.0;
