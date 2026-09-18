import {
  BULLET_RADIUS, CORPSE_LIFE, LANE_W, MAX_BLUE_RENDER, MAX_CORPSE, WEAPONS,
} from '../sim/config.js';
import {
  Corridor, holeCentreAt, holeHalfWidthAt, leftAt, rightAt,
} from '../sim/corridor.js';
import { ENEMIES, ENEMY_KINDS } from '../sim/enemies.js';
import { type Gate, GATE_PANEL_W, gateIsGood, gateLabel } from '../sim/gates.js';
import {
  objectiveCaption, objectiveLabel, type Objective, OBJECTIVE_H, OBJECTIVE_W,
  type ObjectiveKind,
} from '../sim/objectives.js';
import type { Barricade } from '../sim/barricades.js';
import type { LevelDef } from '../sim/levels.js';
import type { World } from '../sim/world.js';
import { hitRect, layoutMenu, menuButton, type MenuLayout, type Rect } from './menu.js';
import { CAM_HEIGHT, FAR_DZ, FOCAL, NEAR, Projector } from './projection.js';

const TAU = Math.PI * 2;

interface StructureItem {
  dz: number;
  gate: Gate | null;
  objective: Objective | null;
  barricade: Barricade | null;
}

const COL_BG = '#0d0d12';
const COL_LANE = '#15151d';
const COL_STRIPE = '#1b1b26';
const COL_EDGE = '#2c2c3a';
const COL_BLUE = '#4da3ff';
const COL_RED = '#ff3b47';
const COL_BULLET = '#ffe066';
const COL_CORPSE = '#2a1a22';
const COL_SKY_TOP = '#0a0a10';
const COL_SKY_HORIZON = '#20212f';

/**
 * How many samples the corridor's edges are drawn with. Spaced quadratically
 * in depth, so the near ground — which is most of the screen — gets most of
 * them.
 */
const GROUND_STEPS = 32;

const STRIPE = 200;
const STRIPE_THICK = 42;
const GATE_HEIGHT = 130;
/**
 * Structures fade out over the last stretch before the camera reaches them.
 * Projected size grows without bound as dz approaches zero, so a gate you are
 * about to pass through otherwise balloons across the whole screen — and by
 * then the choice is already made, so there is nothing left to read.
 */
// The squad plane sits at dz ~603 (CAM_BACK + viewH*SQUAD_SCREEN_FRAC), so a
// gate is fully readable right up to the moment the crowd reaches it and only
// then fades, rather than sailing on toward the lens at screen-filling size.
const FADE_NEAR = 400;
const FADE_FULL = 620;

function nearFade(dz: number): number {
  if (dz >= FADE_FULL) return 1;
  if (dz <= FADE_NEAR) return 0;
  return (dz - FADE_NEAR) / (FADE_FULL - FADE_NEAR);
}

// Unprojected stickman dimensions (world units); scaled per-unit by projected `scale`.
const BODY_HW = 3.2;
const BODY_H = 11;
const HEAD_R = 3.9;
const HEAD_OFF = 14.6;

const OBJ_COLOR: Record<ObjectiveKind, string> = {
  weapon: '#e0a83c',
  recruit: '#43d9a3',
  turret: '#7ec8e3',
};
const COL_BARRICADE = '#6b1c2c';
const COL_BARRICADE_EDGE = '#c23850';
const BARRICADE_HEIGHT = 280;
const OBJ_BROKEN_COLOR = '#3a3a44';
const COL_FINISH = '#f2f4fa';
/** Deep enough that the band still reads as a band from across the lane. */
const FINISH_DEPTH = 210;
const FINISH_POST_H = 260;
const FINISH_POST_W = 16;
const COL_WIN = '#43d9a3';
const COL_LOCKED = '#2a2a36';
/** Hazards read as a hole in the ground rather than an object standing on it. */
const COL_HAZARD = '#120a10';
const COL_HAZARD_EDGE = '#c2384f';

/**
 * Draws the whole world with a fixed, tiny number of fill calls: one path per
 * team, one for bullets, one for corpses. Per-unit draw calls would put a
 * thousand state changes in the hot path and never hold 60fps on Safari.
 *
 * The view is a fake-3D ground-plane projection (see projection.ts): the
 * camera sits behind and above the squad, looking forward up the lane.
 * Everything below the horizon is projected per-frame; the HUD stays in flat
 * screen space on top.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly projector = new Projector();
  scale = 1;
  cssW = 0;
  cssH = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  /** Returns the view height in virtual units, which the sim needs. */
  resize(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.scale = (this.cssW * dpr) / LANE_W;
    return (this.cssH * dpr) / this.scale;
  }

  draw(w: World, fps: number): void {
    const ctx = this.ctx;
    const viewH = w.viewH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    const proj = this.projector;
    proj.update(w.cameraY, w.anchorX, viewH);

    this.drawSky();
    this.drawGround(w.corridor, viewH);
    this.drawStripes(w.corridor);
    this.drawStructures(w);
    this.drawCorpses(w);
    this.drawCrowds(w);
    this.drawBullets(w);
    this.drawFinish(w);
    this.drawHud(w, fps);
    if (w.state === 'dead') this.drawGameOver(w);
    else if (w.state === 'won') this.drawVictory(w);
  }

  /**
   * The finish line: a chequered band across the lane, with an upright post at
   * each edge. The band alone is only a few pixels deep at the distance it
   * first comes into view — the posts are what makes the line readable early
   * enough to be worth pacing yourself against.
   *
   * Drawn after the crowds on purpose: it is the one piece of the world the
   * player has to be able to see through a wall of red.
   */
  private drawFinish(w: World): void {
    if (!Number.isFinite(w.finishY)) return;
    const proj = this.projector;
    const dz = proj.dz(w.finishY);
    if (dz < NEAR || dz > FAR_DZ) return;
    const ctx = this.ctx;
    // `project` returns a single reused object, so every corner is read out
    // into scalars before the next call overwrites it.
    const near = proj.project(leftAt(w.corridor, w.finishY), w.finishY);
    const nearLX = near.x;
    const nearLY = near.y;
    const nearScale = near.scale;
    const nearRight = proj.project(rightAt(w.corridor, w.finishY), w.finishY);
    const nearRX = nearRight.x;
    const nearRY = nearRight.y;
    const farY = w.finishY + FINISH_DEPTH;
    const far = proj.project(leftAt(w.corridor, farY), farY);
    const farLX = far.x;
    const farLY = far.y;
    const farRight = proj.project(rightAt(w.corridor, farY), farY);
    const farRX = farRight.x;
    const farRY = farRight.y;

    ctx.save();
    ctx.globalAlpha = 0.9;
    const squares = 10;
    for (let i = 0; i < squares; i++) {
      const t0 = i / squares;
      const t1 = (i + 1) / squares;
      ctx.fillStyle = i % 2 === 0 ? COL_FINISH : '#1b1b26';
      ctx.beginPath();
      ctx.moveTo(nearLX + (nearRX - nearLX) * t0, nearLY + (nearRY - nearLY) * t0);
      ctx.lineTo(nearLX + (nearRX - nearLX) * t1, nearLY + (nearRY - nearLY) * t1);
      ctx.lineTo(farLX + (farRX - farLX) * t1, farLY + (farRY - farLY) * t1);
      ctx.lineTo(farLX + (farRX - farLX) * t0, farLY + (farRY - farLY) * t0);
      ctx.closePath();
      ctx.fill();
    }

    // Posts at the lane edges rather than a banner across it: the squad steers
    // by what it can see ahead, and a gantry over the middle of the lane would
    // hide the last stretch of swarm at exactly the wrong moment.
    ctx.fillStyle = COL_WIN;
    const postW = Math.max(1, FINISH_POST_W * nearScale);
    const postTop = proj.raise(nearLY, FINISH_POST_H, nearScale);
    ctx.fillRect(nearLX - postW / 2, postTop, postW, nearLY - postTop);
    ctx.fillRect(nearRX - postW / 2, postTop, postW, nearRY - postTop);
    ctx.restore();
  }

  /** Backdrop above the horizon: a quiet gradient plus a faint glow at the vanishing line. */
  private drawSky(): void {
    const ctx = this.ctx;
    const horizonY = this.projector.horizonY;
    const g = ctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0, COL_SKY_TOP);
    g.addColorStop(1, COL_SKY_HORIZON);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LANE_W, horizonY);

    const glowH = Math.min(90, horizonY);
    const glow = ctx.createLinearGradient(0, horizonY - glowH, 0, horizonY);
    glow.addColorStop(0, 'rgba(130,155,215,0)');
    glow.addColorStop(1, 'rgba(130,155,215,0.30)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, horizonY - glowH, LANE_W, glowH);
  }

  /**
   * The ground the squad can actually drive on, sampled along the corridor.
   *
   * This used to be one trapezoid between the lane's two fixed edges. A lane
   * that narrows and bends has no such shape, so the edges are walked instead:
   * samples are spaced quadratically in depth, which puts them where the
   * projection is changing fastest — near the camera, where a handful of world
   * units is most of the screen.
   */
  // One extra slot per edge for the vanishing point they both end at.
  private readonly groundLX = new Float32Array(GROUND_STEPS + 2);
  private readonly groundLY = new Float32Array(GROUND_STEPS + 2);
  private readonly groundRX = new Float32Array(GROUND_STEPS + 2);
  private readonly groundRY = new Float32Array(GROUND_STEPS + 2);

  private drawGround(corridor: Corridor, viewH: number): void {
    const ctx = this.ctx;
    const proj = this.projector;
    const horizonY = proj.horizonY;

    // Fill everything below the horizon first so the ground outside the
    // (narrower, converging) corridor isn't left as a gap.
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, horizonY, LANE_W, Math.max(0, viewH - horizonY));

    const scaleBottom = Math.max((viewH - horizonY) / CAM_HEIGHT, FOCAL / FAR_DZ);
    const dzBottom = Math.max(NEAR, FOCAL / scaleBottom);

    const lx = this.groundLX;
    const ly = this.groundLY;
    const rx = this.groundRX;
    const ry = this.groundRY;
    for (let i = 0; i <= GROUND_STEPS; i++) {
      const f = i / GROUND_STEPS;
      const dz = dzBottom + (FAR_DZ - dzBottom) * f * f;
      const worldY = proj.camY + dz;
      // Each projection is read out immediately: `project` hands back one
      // reused record, so holding two of them means holding the same point.
      const l = proj.project(leftAt(corridor, worldY), worldY);
      lx[i] = l.x;
      ly[i] = l.y;
      const r = proj.project(rightAt(corridor, worldY), worldY);
      rx[i] = r.x;
      ry[i] = r.y;
    }
    // Both edges end at the vanishing point. Stopping at the last sample instead
    // leaves the lane cut off by a flat far edge partway up the screen, where
    // the trapezoid this replaced used to taper away to nothing.
    const end = GROUND_STEPS + 1;
    lx[end] = LANE_W / 2;
    ly[end] = horizonY;
    rx[end] = LANE_W / 2;
    ry[end] = horizonY;

    ctx.fillStyle = COL_LANE;
    ctx.beginPath();
    ctx.moveTo(lx[0], ly[0]);
    for (let i = 1; i <= end; i++) ctx.lineTo(lx[i], ly[i]);
    for (let i = end; i >= 0; i--) ctx.lineTo(rx[i], ry[i]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = COL_EDGE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lx[0], ly[0]);
    for (let i = 1; i <= end; i++) ctx.lineTo(lx[i], ly[i]);
    ctx.moveTo(rx[0], ry[0]);
    for (let i = 1; i <= end; i++) ctx.lineTo(rx[i], ry[i]);
    ctx.stroke();

    this.drawHazard(corridor, dzBottom);
  }

  private readonly hazLX = new Float32Array(GROUND_STEPS + 1);
  private readonly hazLY = new Float32Array(GROUND_STEPS + 1);
  private readonly hazRX = new Float32Array(GROUND_STEPS + 1);
  private readonly hazRY = new Float32Array(GROUND_STEPS + 1);

  /**
   * The hazard, punched out of the ground that was just drawn. Cut from the
   * lane rather than stood on top of it, so it reads as somewhere you cannot
   * go instead of as another billboard to shoot.
   */
  private drawHazard(corridor: Corridor, dzBottom: number): void {
    const proj = this.projector;
    const lx = this.hazLX;
    const ly = this.hazLY;
    const rx = this.hazRX;
    const ry = this.hazRY;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i <= GROUND_STEPS; i++) {
      const f = i / GROUND_STEPS;
      const dz = dzBottom + (FAR_DZ - dzBottom) * f * f;
      const worldY = proj.camY + dz;
      const hw = holeHalfWidthAt(corridor, worldY);
      if (hw <= 0) continue;
      const hc = holeCentreAt(corridor, worldY);
      // Each projection read straight out into scalars: `project` hands back a
      // single reused record, which is what broke the finish line in phase 5.
      const l = proj.project(hc - hw, worldY);
      lx[i] = l.x;
      ly[i] = l.y;
      const r = proj.project(hc + hw, worldY);
      rx[i] = r.x;
      ry[i] = r.y;
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo < 0 || hi <= lo) return;

    const ctx = this.ctx;
    ctx.fillStyle = COL_HAZARD;
    ctx.beginPath();
    ctx.moveTo(lx[lo], ly[lo]);
    for (let i = lo + 1; i <= hi; i++) ctx.lineTo(lx[i], ly[i]);
    for (let i = hi; i >= lo; i--) ctx.lineTo(rx[i], ry[i]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = COL_HAZARD_EDGE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lx[lo], ly[lo]);
    for (let i = lo + 1; i <= hi; i++) ctx.lineTo(lx[i], ly[i]);
    ctx.lineTo(rx[hi], ry[hi]);
    for (let i = hi - 1; i >= lo; i--) ctx.lineTo(rx[i], ry[i]);
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Scrolling ground stripes, projected from the same worldY grid every
   * frame. Horizontal bands that compress toward the horizon — this is the
   * primary "we are moving forward" cue now that the camera itself is fixed
   * relative to the squad.
   */
  private drawStripes(corridor: Corridor): void {
    const ctx = this.ctx;
    const proj = this.projector;
    const path = new Path2D();
    const first = Math.floor(proj.camY / STRIPE) * STRIPE;
    let any = false;
    for (let y = first; ; y += STRIPE) {
      const dzNear = proj.dz(y);
      if (dzNear > FAR_DZ) break;
      const dzFar = proj.dz(y + STRIPE_THICK);
      if (dzFar < NEAR && dzNear < NEAR) continue;

      const far = y + STRIPE_THICK;
      const nearL = proj.project(leftAt(corridor, y), y);
      const nearLX = nearL.x;
      const nearLY = nearL.y;
      const nearR = proj.project(rightAt(corridor, y), y);
      const nearRX = nearR.x;
      const nearRY = nearR.y;
      const farL = proj.project(leftAt(corridor, far), far);
      const farLX = farL.x;
      const farLY = farL.y;
      const farR = proj.project(rightAt(corridor, far), far);

      path.moveTo(nearLX, nearLY);
      path.lineTo(nearRX, nearRY);
      path.lineTo(farR.x, farR.y);
      path.lineTo(farLX, farLY);
      path.closePath();
      any = true;
    }
    if (!any) return;
    ctx.fillStyle = COL_STRIPE;
    ctx.fill(path);
  }

  /** Gates as upright billboards standing on the ground, split into left/right halves. */
  /**
   * Gates and objectives share the lane, so they have to be painted as one
   * depth-sorted pass. Drawing them in two separate passes lets a distant
   * billboard paint over a nearer gate's label, which reads as a rendering
   * glitch and, worse, hides the choice the player is about to make.
   */
  private readonly structureOrder: StructureItem[] = [];
  private readonly redPaths: (Path2D | null)[] = new Array(ENEMY_KINDS).fill(null);

  private drawStructures(w: World): void {
    const proj = this.projector;
    const order = this.structureOrder;
    order.length = 0;
    for (const gate of w.gates) {
      if (gate.taken) continue;
      order.push({ dz: proj.dz(gate.y), gate, objective: null, barricade: null });
    }
    for (const o of w.objectives) {
      const dz = proj.dz(o.y);
      if (o.resolved && dz < NEAR) continue;
      order.push({ dz, gate: null, objective: o, barricade: null });
    }
    for (const b of w.barricades) {
      if (b.broken) continue;
      const dz = proj.dz(b.y);
      if (dz < NEAR || dz > FAR_DZ) continue;
      order.push({ dz, gate: null, objective: null, barricade: b });
    }
    order.sort((a, b) => b.dz - a.dz);
    for (const item of order) {
      if (item.gate) this.drawGate(item.gate);
      else if (item.objective) this.drawObjective(item.objective, w.weaponTier);
      else if (item.barricade) this.drawBarricade(item.barricade);
    }
  }

  private drawGate(gate: Gate): void {
    const ctx = this.ctx;
    const proj = this.projector;
    {
      const dz = proj.dz(gate.y);
      if (dz < -50 || dz > FAR_DZ) return;
      const fade = nearFade(dz);
      if (fade <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = fade;

      const halves = [
        { op: gate.op, x0: gate.cx - GATE_PANEL_W, x1: gate.cx + GATE_PANEL_W },
      ];
      for (const half of halves) {
        const baseL = proj.project(half.x0, gate.y);
        const baseLX = baseL.x;
        const baseLY = baseL.y;
        const scale = baseL.scale;
        const baseR = proj.project(half.x1, gate.y);
        if (Math.max(baseLX, baseR.x) < 0 || Math.min(baseLX, baseR.x) > LANE_W) continue;
        const topY = proj.raise(baseLY, GATE_HEIGHT, scale);
        const topRY = proj.raise(baseR.y, GATE_HEIGHT, scale);

        const good = gateIsGood(half.op);
        ctx.fillStyle = good ? 'rgba(60,200,120,0.20)' : 'rgba(220,60,70,0.20)';
        ctx.beginPath();
        ctx.moveTo(baseLX, baseLY);
        ctx.lineTo(baseR.x, baseR.y);
        ctx.lineTo(baseR.x, topRY);
        ctx.lineTo(baseLX, topY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = good ? '#3ecb7a' : '#e8535f';
        const barH = Math.max(1, 6 * scale);
        ctx.fillRect(Math.min(baseLX, baseR.x), Math.min(baseLY, baseR.y) - barH, Math.abs(baseR.x - baseLX), barH);

        const cx = (baseLX + baseR.x) / 2;
        const cy = (Math.min(baseLY, baseR.y) + Math.min(topY, topRY)) / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2f4fa';
        fitText(
          ctx,
          gateLabel(half.op),
          cx,
          cy,
          Math.abs(baseR.x - baseLX) * 0.86,
          Math.abs(Math.min(baseLY, baseR.y) - Math.min(topY, topRY)) * 0.62,
          44 * scale,
        );
      }
      ctx.restore();
    }
  }

  /**
   * Objectives as upright billboards to one side of the lane: a distinct
   * silhouette per kind, an HP/charge bar, and a clear broken state.
   */
  private drawObjective(o: Objective, weaponTier: number): void {
    const ctx = this.ctx;
    const proj = this.projector;
    {
      const dz = proj.dz(o.y);
      if (dz < -50 || dz > FAR_DZ) return;
      const fade = nearFade(dz);
      if (fade <= 0.01) return;

      const base = proj.project(o.x, o.y);
      const scale = base.scale;
      const halfW = (OBJECTIVE_W / 2) * scale;
      // Every cull happens before save(): an early return past it leaks canvas
      // state, and a leaked globalAlpha silently dims everything drawn after.
      if (base.x + halfW < 0 || base.x - halfW > LANE_W) return;

      ctx.save();
      ctx.globalAlpha = fade;

      const flash = o.flash;
      // Cracked open but not yet taken is a live pickup lying in the lane, not
      // a spent husk: it keeps its colour and its label so the player can see
      // there is still something there to run over.
      // Active turrets stay upright — they are not rubble, they are firing.
      const brokenFlat = o.broken && o.kind !== 'turret';
      const taken = o.collected;
      const height = (brokenFlat ? OBJECTIVE_H * 0.22 : OBJECTIVE_H) * scale * (1 + flash * 0.12);
      const baseX = base.x;
      const baseY = base.y;
      const topY = baseY - height;
      const leftX = baseX - halfW;
      const rightX = baseX + halfW;

      const activeColor = (o.kind === 'turret' && o.broken) ? '#43d9a3' : OBJ_COLOR[o.kind as ObjectiveKind];
      ctx.fillStyle = taken ? OBJ_BROKEN_COLOR : activeColor;
      this.drawObjectiveSilhouette(o.kind, leftX, rightX, baseY, topY, scale, brokenFlat);

      if (flash > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, flash * 0.85)})`;
        ctx.fillRect(leftX, topY, rightX - leftX, baseY - topY);
      }

      // HP / charge bar, just above the billboard.
      const frac = o.hp / o.maxHp;
      if (!brokenFlat) {
        const barW = rightX - leftX;
        const barH = Math.max(2, 5 * scale);
        const barY = topY - barH - Math.max(1, 3 * scale);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(leftX, barY, barW, barH);
        ctx.fillStyle = '#e8535f';
        ctx.fillRect(leftX, barY, barW * Math.max(0, Math.min(1, frac)), barH);
      }

      // Every structure states what it gives. A silhouette alone does not tell
      // the player whether diverting fire onto it is worth the swarm they let
      // through, which is the entire decision being asked of them.
      const label = taken ? 'TAKEN' : objectiveLabel(o, weaponTier);
      const panelW = (rightX - leftX) * 0.9;
      const panelH = Math.abs(baseY - topY);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = taken ? '#7c8394' : '#0d0d12';
      fitText(ctx, label, baseX, baseY - panelH * 0.55, panelW, panelH * 0.42, 34 * scale);

      if (!taken) {
        const caption = brokenFlat ? 'RUN OVER IT'
          : (o.kind === 'turret' && o.broken) ? 'FIRING'
          : objectiveCaption(o);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        fitText(
          ctx,
          caption,
          baseX,
          topY - Math.max(6, 20 * scale),
          panelW * 1.1,
          Math.max(5, 15 * scale),
          15 * scale,
        );
      }
      ctx.restore();
    }
  }

  private drawBarricade(b: Barricade): void {
    const ctx = this.ctx;
    const proj = this.projector;
    const dz = proj.dz(b.y);
    if (dz < -50 || dz > FAR_DZ) return;
    const fade = nearFade(dz);
    if (fade <= 0.01) return;

    const base = proj.project(b.holeCentre, b.y);
    const scale = base.scale;
    const halfW = b.holeHalfWidth * scale;
    if (base.x + halfW < 0 || base.x - halfW > LANE_W) return;

    ctx.save();
    ctx.globalAlpha = fade * (1 - b.flash * 0.5);

    const height = BARRICADE_HEIGHT * scale;
    const leftX = base.x - halfW;
    const rightX = base.x + halfW;
    const topY = base.y - height;

    // HP bar
    const frac = b.hp / b.maxHp;
    const barH = Math.max(2, 5 * scale);
    const barY = topY - barH - Math.max(1, 3 * scale);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(leftX, barY, rightX - leftX, barH);
    ctx.fillStyle = COL_BARRICADE_EDGE;
    ctx.fillRect(leftX, barY, (rightX - leftX) * Math.max(0, Math.min(1, frac)), barH);

    ctx.fillStyle = COL_BARRICADE;
    ctx.fillRect(leftX, topY, rightX - leftX, height);

    ctx.strokeStyle = COL_BARRICADE_EDGE;
    ctx.lineWidth = Math.max(1, 3 * scale);
    ctx.strokeRect(leftX, topY, rightX - leftX, height);

    if (b.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.75, b.flash * 0.75)})`;
      ctx.fillRect(leftX, topY, rightX - leftX, height);
    }

    ctx.restore();
  }

  private drawObjectiveSilhouette(
    kind: ObjectiveKind,
    leftX: number,
    rightX: number,
    baseY: number,
    topY: number,
    scale: number,
    broken: boolean,
  ): void {
    const ctx = this.ctx;
    const w = rightX - leftX;
    const h = baseY - topY;
    if (broken || kind === 'weapon') {
      // Crate: a plain box; broken kinds collapse to flat rubble using the same shape.
      ctx.fillRect(leftX, topY, w, h);
      if (!broken) {
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.beginPath();
        ctx.moveTo(leftX, topY + h / 2);
        ctx.lineTo(rightX, topY + h / 2);
        ctx.moveTo((leftX + rightX) / 2, topY);
        ctx.lineTo((leftX + rightX) / 2, baseY);
        ctx.stroke();
      }
      return;
    }
    if (kind === 'recruit') {
      // Pod: a capsule — rect body with a rounded cap on top.
      const capR = w / 2;
      const bodyTop = topY + capR;
      ctx.fillRect(leftX, bodyTop, w, h - capR);
      ctx.beginPath();
      ctx.arc((leftX + rightX) / 2, bodyTop, capR, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (kind === 'turret') {
      // Platform base + vertical barrel.
      const platformH = h * 0.28;
      const barrelW = Math.max(1, w * 0.18);
      const barrelH = h * 0.72;
      ctx.fillRect(leftX, baseY - platformH, w, platformH);
      ctx.fillRect((leftX + rightX) / 2 - barrelW / 2, topY, barrelW, barrelH);
      return;
    }
    // Multiplier: a flat sign board on a thin post.
    const postW = Math.max(1, w * 0.12);
    const boardH = h * 0.62;
    ctx.fillRect((leftX + rightX) / 2 - postW / 2, topY + boardH, postW, h - boardH);
    ctx.fillRect(leftX, topY, w, boardH);
  }

  private drawCorpses(w: World): void {
    const ctx = this.ctx;
    const proj = this.projector;
    const path = new Path2D();
    let any = false;
    for (let i = 0; i < MAX_CORPSE; i++) {
      if (w.corpseAge[i] >= CORPSE_LIFE) continue;
      const dz = proj.dz(w.corpseY[i]);
      if (dz < NEAR || dz > FAR_DZ) continue;
      const p = proj.project(w.corpseX[i], w.corpseY[i]);
      const hw = 7 * p.scale;
      const hh = 3 * p.scale;
      if (p.x + hw < 0 || p.x - hw > LANE_W) continue;
      path.rect(p.x - hw, p.y - hh, hw * 2, hh * 2);
      any = true;
    }
    if (!any) return;
    ctx.fillStyle = COL_CORPSE;
    ctx.fill(path);
  }

  /**
   * Each team is one Path2D, one fill — the whole performance budget rests on
   * this. Units within a team are the same colour, so overlap is invisible
   * and there is no need (and no time budget) to depth-sort 1400 of them.
   */
  private drawCrowds(w: World): void {
    const ctx = this.ctx;
    const proj = this.projector;

    // One path per enemy type rather than per unit: four fills instead of one,
    // still not four thousand. Overlap within a type is invisible because the
    // type shares a colour, so there is still no depth sort.
    const byType = this.redPaths;
    for (let t = 0; t < ENEMY_KINDS; t++) byType[t] = new Path2D();
    for (let i = 0; i < w.redCount; i++) {
      const stats = ENEMIES[w.redType[i]];
      addStickman(
        byType[w.redType[i]] as Path2D,
        proj,
        w.redX[i],
        w.redY[i],
        stats.bodyScale,
        stats.headScale,
      );
    }
    for (let t = 0; t < ENEMY_KINDS; t++) {
      ctx.fillStyle = ENEMIES[t].color;
      ctx.fill(byType[t] as Path2D);
    }

    const blues = new Path2D();
    const n = Math.min(w.rendered, MAX_BLUE_RENDER);
    for (let i = 0; i < n; i++) {
      addStickman(blues, proj, w.blueX[i], w.blueY[i]);
    }
    ctx.fillStyle = COL_BLUE;
    ctx.fill(blues);
  }

  private drawBullets(w: World): void {
    const ctx = this.ctx;
    if (w.bulletCount === 0) return;
    const proj = this.projector;
    const path = new Path2D();
    let any = false;
    for (let i = 0; i < w.bulletCount; i++) {
      const dz = proj.dz(w.bulY[i]);
      if (dz < NEAR || dz > FAR_DZ) continue;
      const p = proj.project(w.bulX[i], w.bulY[i]);
      const hw = BULLET_RADIUS * 0.45 * p.scale;
      const len = 12 * p.scale;
      if (p.x + hw < 0 || p.x - hw > LANE_W) continue;
      path.rect(p.x - hw, p.y - len * 0.75, hw * 2, len);
      any = true;
    }
    if (!any) return;
    ctx.fillStyle = COL_BULLET;
    ctx.fill(path);
  }

  private drawHud(w: World, fps: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.canvas.width / LANE_W;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const pad = 22 * s;
    ctx.fillStyle = w.gateFlash > 0 ? '#ffffff' : COL_BLUE;
    ctx.font = `bold ${Math.round(64 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(String(w.count), pad, pad);

    ctx.fillStyle = '#7c8394';
    ctx.font = `600 ${Math.round(26 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(WEAPONS[w.weaponTier].name, pad, pad + 72 * s);

    ctx.textAlign = 'right';
    ctx.fillText(w.level.name, this.canvas.width - pad, pad);
    ctx.fillStyle = '#454b59';
    ctx.font = `500 ${Math.round(20 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(
      `${w.kills} KILLS  ·  ${fps.toFixed(0)}fps`,
      this.canvas.width - pad,
      pad + 34 * s,
    );
    this.drawProgress(w, pad, s);

    // Standing in a hazard costs bodies every frame, and the crowd is drawn
    // over the top of it, so the count alone is easy to miss in the moment.
    if (w.hazardOverlap > 0.02) {
      ctx.textAlign = 'center';
      ctx.fillStyle = COL_HAZARD_EDGE;
      ctx.font = `bold ${Math.round(34 * s)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText('CLEAR THE PIT', this.canvas.width / 2, pad + 190 * s);
    }
  }

  /**
   * Distance to the finish line, as a bar. A level is a fixed length, so the
   * player needs to know whether to spend the squad now or hold it — without
   * that the last thirty seconds feel identical to the first.
   */
  private drawProgress(w: World, pad: number, s: number): void {
    if (!Number.isFinite(w.finishY)) return;
    const ctx = this.ctx;
    const barW = this.canvas.width - pad * 2;
    const barH = 8 * s;
    const y = pad + 150 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(pad, y, barW, barH);
    ctx.fillStyle = COL_WIN;
    ctx.fillRect(pad, y, barW * w.progress, barH);
  }

  private drawGameOver(w: World): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.canvas.width / LANE_W;
    ctx.fillStyle = 'rgba(8,8,12,0.82)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    ctx.fillStyle = COL_RED;
    ctx.font = `bold ${Math.round(80 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('OVERRUN', cx, cy - 70 * s);
    ctx.fillStyle = '#c9cedb';
    ctx.font = `600 ${Math.round(34 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(`${w.kills} killed  ·  ${Math.round(w.distance / 100)}m`, cx, cy + 20 * s);
    ctx.fillStyle = '#7c8394';
    ctx.font = `500 ${Math.round(28 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('TAP TO RETRY', cx, cy + 90 * s);
    this.drawMenuButton();
  }

  private drawVictory(w: World): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.canvas.width / LANE_W;
    ctx.fillStyle = 'rgba(8,8,12,0.82)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    ctx.fillStyle = COL_WIN;
    ctx.font = `bold ${Math.round(80 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('CLEARED', cx, cy - 70 * s);
    ctx.fillStyle = '#c9cedb';
    ctx.font = `600 ${Math.round(34 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(`${w.level.name}  ·  ${w.count} survived`, cx, cy + 20 * s);
    ctx.fillStyle = '#7c8394';
    ctx.font = `500 ${Math.round(28 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('TAP TO CONTINUE', cx, cy + 90 * s);
    this.drawMenuButton();
  }

  /** Shared by both end-of-run overlays, from the same rect the tap tests against. */
  private drawMenuButton(): void {
    const ctx = this.ctx;
    const r = menuButton(this.canvas.width, this.canvas.height);
    const s = this.canvas.width / LANE_W;
    // Opaque enough to read against a crowd of four hundred stickmen.
    ctx.fillStyle = 'rgba(20,20,28,0.88)';
    roundRect(ctx, r, r.h * 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, s * 2);
    ctx.stroke();
    ctx.fillStyle = '#9aa1b3';
    ctx.font = `600 ${Math.round(26 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('LEVELS', r.x + r.w / 2, r.y + r.h / 2);
  }

  /** True if a tap at these device-pixel coordinates hit the overlay's MENU pill. */
  menuButtonHit(x: number, y: number): boolean {
    return hitRect(menuButton(this.canvas.width, this.canvas.height), x, y);
  }

  /**
   * Builds the level-select layout against the live backing-store size. The
   * renderer owns it because it owns the canvas: a caller that guessed at the
   * dimensions would draw tiles where taps do not land.
   */
  menuLayout(
    levels: readonly LevelDef[],
    isUnlocked: (level: LevelDef) => boolean,
    isCleared: (level: LevelDef) => boolean,
  ): MenuLayout {
    return layoutMenu(levels, this.canvas.width, this.canvas.height, isUnlocked, isCleared);
  }

  /**
   * The level select. Drawn in flat screen space with no world behind it, so it
   * shares nothing with `draw` beyond the canvas itself.
   */
  drawMenu(layout: MenuLayout): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.canvas.width / LANE_W;
    const g = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    g.addColorStop(0, COL_SKY_TOP);
    g.addColorStop(1, '#141420');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL_RED;
    ctx.font = `bold ${Math.round(72 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('RED TIDE', this.canvas.width / 2, layout.titleY);
    ctx.fillStyle = '#7c8394';
    ctx.font = `600 ${Math.round(24 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('SELECT A LEVEL', this.canvas.width / 2, layout.titleY + 52 * s);

    for (const tile of layout.tiles) {
      const cx = tile.x + tile.w / 2;
      ctx.fillStyle = tile.unlocked
        ? (tile.cleared ? 'rgba(67,217,163,0.14)' : 'rgba(77,163,255,0.14)')
        : COL_LOCKED;
      roundRect(ctx, tile, tile.h * 0.16);
      ctx.fill();
      ctx.strokeStyle = tile.cleared ? COL_WIN : tile.unlocked ? COL_BLUE : '#33333f';
      ctx.lineWidth = 2 * s;
      roundRect(ctx, tile, tile.h * 0.16);
      ctx.stroke();

      if (!tile.unlocked) {
        // Still shows its number: a locked tile the player can identify is a
        // signpost, where a blank one is just an absence.
        ctx.fillStyle = '#41414f';
        ctx.font = `bold ${Math.round(48 * s)}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(String(tile.level.id), cx, tile.y + tile.h / 2);
        continue;
      }
      ctx.fillStyle = tile.cleared ? COL_WIN : COL_BLUE;
      ctx.font = `bold ${Math.round(48 * s)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(String(tile.level.id), cx, tile.y + tile.h * 0.40);
      ctx.fillStyle = '#7c8394';
      fitText(
        ctx,
        tile.level.name,
        cx,
        tile.y + tile.h * 0.74,
        tile.w * 0.88,
        tile.h * 0.22,
        Math.round(19 * s),
      );
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(r.x + radius, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, radius);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, radius);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, radius);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, radius);
  ctx.closePath();
}

/**
 * Two subpaths per unit: body slab and head, appended to a shared batch path.
 * Dimensions scale with the projected distance so the crowd shrinks toward
 * the horizon instead of staying a flat top-down size.
 */
function addStickman(
  path: Path2D,
  proj: Projector,
  worldX: number,
  worldY: number,
  bodyScale = 1,
  headScale = 1,
): void {
  const dz = proj.dz(worldY);
  if (dz < NEAR || dz > FAR_DZ) return;
  const p = proj.project(worldX, worldY);
  const scale = p.scale;
  const headR = HEAD_R * scale * headScale;
  const hw = BODY_HW * scale * bodyScale;
  if (p.x + headR < 0 || p.x - headR > LANE_W) return;
  const bodyH = BODY_H * scale * bodyScale;
  const headOff = (HEAD_OFF + (BODY_H * (bodyScale - 1))) * scale;
  path.rect(p.x - hw, p.y - bodyH, hw * 2, bodyH);
  path.moveTo(p.x + headR, p.y - headOff);
  path.arc(p.x, p.y - headOff, headR, 0, TAU);
}

/**
 * Draws text sized to the billboard it sits on. A projected label grows without
 * bound as the camera closes on it, so clamping to a fixed pixel ceiling still
 * lets it overflow its own panel and run off the screen edge; the constraint
 * that matters is the panel, not the viewport.
 */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxW: number,
  maxH: number,
  desired: number,
): void {
  let px = Math.max(7, Math.min(desired, maxH));
  ctx.font = `bold ${px}px system-ui, -apple-system, sans-serif`;
  const measured = ctx.measureText(text).width;
  if (measured > maxW && measured > 0) {
    px = Math.max(6, px * (maxW / measured));
    ctx.font = `bold ${px}px system-ui, -apple-system, sans-serif`;
  }
  ctx.fillText(text, cx, cy);
}
