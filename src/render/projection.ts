/**
 * Ground-plane pinhole projection for the fake-3D third-person camera.
 *
 * Pure and allocation-free in the hot path: `Projector.project` writes into a
 * single reusable record and returns it, so projecting hundreds of units per
 * frame costs zero garbage.
 *
 * Derivation of the constants below (targets from the spec, at the reference
 * viewport 390x844 CSS px, where `world.viewH` works out to ~1558 virtual
 * units — see renderer.ts's resize() for how viewH relates to the CSS size):
 *
 *   - horizon at ~20-24% down the screen  -> HORIZON_FRAC = 0.22
 *   - squad (worldY = cameraY + viewH*0.22) lands at ~75% down the screen
 *   - a squad unit (≈18.8 world units tall, unscaled) renders ~22-28 CSS px
 *   - useful visible depth ahead of the squad is ~2000-2600 world units
 *     (by ~2600 units past the squad, projected unit height has fallen to a
 *     few CSS px — still a visible mote, not yet culled)
 *
 * Solving those simultaneously gives FOCAL ≈ 1465, CAM_HEIGHT ≈ 340,
 * CAM_BACK ≈ 260. Verified against screenshots at that viewport; see the
 * renderer's usage for how camX partially tracks the squad.
 */
import { LANE_W } from '../sim/config.js';

/** Camera focal length (world units). Larger = more telephoto / less fisheye. */
export const FOCAL = 1465;
/** Camera height above the ground plane (world units). */
export const CAM_HEIGHT = 340;
/** Camera trails this far behind the scroll position `world.cameraY`. */
export const CAM_BACK = 260;
/** Forward distance is clamped to at least this, so scale never blows up near the lens. */
export const NEAR = 60;
/** Anything farther than this (in dz) is not worth drawing; cull it. */
export const FAR_DZ = 5000;
/** Horizon sits this fraction of the way down the screen. */
export const HORIZON_FRAC = 0.22;
/**
 * The camera only partially follows the squad's lateral position — full rigid
 * tracking makes the world feel like it's sliding under a fixed viewer, while
 * a camera that drifts less than the subject feels grounded.
 */
export const CAM_DRIFT = 0.35;

export interface Projected {
  x: number;
  y: number;
  scale: number;
}

/**
 * Holds the current frame's camera placement and projects ground points
 * (and points raised above the ground, for billboards) into screen space —
 * the same virtual coordinate system the renderer already draws in
 * ([0, LANE_W] x [0, viewH]), so no further transform is needed downstream.
 */
export class Projector {
  camX = 0;
  camY = 0;
  horizonY = 0;
  viewH = 0;

  private readonly out: Projected = { x: 0, y: 0, scale: 0 };

  /** Call once per frame before projecting. */
  update(cameraY: number, anchorX: number, viewH: number): void {
    this.viewH = viewH;
    this.horizonY = viewH * HORIZON_FRAC;
    this.camY = cameraY - CAM_BACK;
    this.camX = LANE_W / 2 + (anchorX - LANE_W / 2) * CAM_DRIFT;
  }

  /** Raw forward distance, unclamped — negative/small means behind or at the lens. */
  dz(worldY: number): number {
    return worldY - this.camY;
  }

  /**
   * Projects a ground point (worldX, worldY). `dz` is clamped to >= NEAR so
   * the scale never diverges; callers that need to cull near/far/behind
   * geometry should check `dz()` themselves before calling this.
   */
  project(worldX: number, worldY: number): Projected {
    let d = worldY - this.camY;
    if (d < NEAR) d = NEAR;
    const scale = FOCAL / d;
    this.out.x = LANE_W / 2 + (worldX - this.camX) * scale;
    this.out.y = this.horizonY + CAM_HEIGHT * scale;
    this.out.scale = scale;
    return this.out;
  }

  /**
   * Screen y for a point raised `height` world units above the ground at the
   * given projected `scale` (same dz as the base point this scale came from).
   * Used to draw the top edge of upright billboards (gates, objectives).
   */
  raise(baseY: number, height: number, scale: number): number {
    return baseY - height * scale;
  }
}
