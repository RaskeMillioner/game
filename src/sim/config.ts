/**
 * Every number that decides how the game feels. Kept in one file on purpose:
 * tuning is the real work, and it should never require hunting through logic.
 */

/** Virtual lane width. All sim coordinates are in these units; the renderer scales to fit. */
export const LANE_W = 720;

export const SCROLL_SPEED = 240;
/** Squad sits this fraction of the view height up from the bottom. */
export const SQUAD_SCREEN_FRAC = 0.22;

export const START_BLUE = 16;
export const MAX_BLUE = 4000;
/** Only this many are ever drawn; past ~400 nobody can tell, and the HUD carries the truth. */
export const MAX_BLUE_RENDER = 400;
export const BLUE_SPACING = 11;
export const BLUE_FOLLOW = 11;
export const ANCHOR_FOLLOW = 14;
export const DRAG_GAIN = 1.15;

/**
 * Red capacity. Spawning silently stops at the cap, so a swarm that saturates it
 * quietly flattens late-run difficulty — headroom here is a correctness concern,
 * not just a memory one.
 */
export const MAX_RED = 3200;
/** Baseline contact radius; per-type radii live in enemies.ts. */
export const RED_RADIUS = 9;
/**
 * Weight on the lateral component of red pursuit. Below 1 they close the
 * distance ahead of you before swinging in, so the swarm arrives through your
 * guns instead of materialising on your flank where fixed-forward fire can
 * never reach it.
 */
export const RED_LATERAL_WEIGHT = 0.6;
/** Extra lateral gain per unit of distance ahead, capped by RED_ALIGN_MAX. */
export const RED_ALIGN_RANGE = 350;
export const RED_ALIGN_MAX = 1.1;
/** How far behind the crowd's rear edge a red counts as having broken through. */
export const BREAKTHROUGH_PAD = 12;
/**
 * Reds spawn in a band around the squad's current column rather than uniformly
 * across the lane. The squad advances faster than reds run, so anything
 * spawning on the far side can never intercept and simply falls behind — the
 * swarm has to be in your path to be a swarm at all.
 */
export const RED_SPAWN_SPREAD = 340;
/**
 * The swarm's frontage tracks the crowd's own frontage. A 14-strong squad
 * covers about 80 units of lane, so spawning reds across the full width would
 * hand them free breakthroughs before the player has any width to defend with.
 */
export const RED_SPAWN_MIN_SPREAD = 95;
export const RED_SPAWN_RADIUS_GAIN = 1.6;
export const CONTACT_PAD = 6;

export const MAX_BULLET = 1400;
export const BULLET_RADIUS = 5;
/**
 * How far a shot reaches, in world units, the same for every weapon. Lifetime is
 * derived from it so that a faster bullet arrives sooner rather than travelling
 * further — range used to fall out of speed x lifetime, which quietly handed the
 * minigun a third more reach than the pistol on top of its rate.
 *
 * Reds spawn about 1275 units ahead of the squad, so anything below that leaves
 * the front of the swarm untouchable.
 */
export const BULLET_RANGE = 1900;

/**
 * Firing is emitter-capped: at most this many units actually spawn bullets, and
 * each bullet's pierce scales with true squad size. Without this, 400 units at
 * minigun cadence would mean 5600 bullets/second and a slideshow.
 */
export const MAX_EMITTERS = 26;

export interface Weapon {
  readonly name: string;
  readonly rate: number;
  readonly pellets: number;
  /**
   * Fan width for multi-pellet weapons, in multiples of the gap between firing
   * columns. Zero fires straight. A fan redistributes the emitter's share of the
   * width rather than extending it, so the shotgun reads as a blast without
   * getting the free coverage that once buried the tier order.
   */
  readonly fan: number;
  readonly speed: number;
  /**
   * Multiplier on squad-size-derived damage. Nominal DPS per unit is rate*power,
   * so this is what keeps the tiers strictly increasing across very different
   * cadences: 2.5 -> 3.9 -> 5.4 -> 7.6 per unit.
   */
  readonly power: number;
}

export const WEAPONS: readonly Weapon[] = [
  { name: 'PISTOL', rate: 2.5, pellets: 1, fan: 0, speed: 900, power: 1.0 },
  { name: 'RIFLE', rate: 6.0, pellets: 1, fan: 0, speed: 1100, power: 0.65 },
  { name: 'SHOTGUN', rate: 2.0, pellets: 5, fan: 1.6, speed: 850, power: 2.7 },
  { name: 'MINIGUN', rate: 14.0, pellets: 1, fan: 0, speed: 1200, power: 0.54 },
];

/**
 * How far each emitter scatters its shots sideways, as a multiple of half the
 * gap to its neighbour. Shots still fly dead straight; this only decides where
 * they start, so the columns tile the formation's width without holes and
 * without trading away accuracy.
 *
 * Coverage, not damage, was what buried the tier order: the shotgun's fan swept
 * the whole lane while the minigun's stream reached about half of it, so the
 * minigun landed more raw damage yet killed less. With every weapon sampling
 * the same width, rate and power decide.
 */
export const FIRE_COLUMN_FILL = 1.1;

/**
 * Distance at which a fanned pellet reaches its intended lateral offset. Nearer
 * than this the blast is tighter, further out it opens up — which is what a
 * shotgun should look like, and why it trades reach for width.
 */
export const FIRE_FAN_REF = 520;

export const GATE_SPACING = 3400;
export const GATE_FIRST = 1250;

export const MAX_CORPSE = 400;
export const CORPSE_LIFE = 4.0;
