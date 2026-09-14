import {
  BULLET_RADIUS, CORPSE_LIFE, LANE_W, MAX_BLUE_RENDER, MAX_CORPSE, WEAPONS,
} from '../sim/config.js';
import { type Gate, GATE_PANEL_W, gateIsGood, gateLabel } from '../sim/gates.js';
import {
  objectiveCaption, objectiveLabel, type Objective, OBJECTIVE_H, OBJECTIVE_W,
  type ObjectiveKind,
} from '../sim/objectives.js';
import type { World } from '../sim/world.js';
import { CAM_HEIGHT, FAR_DZ, FOCAL, NEAR, Projector } from './projection.js';

const TAU = Math.PI * 2;

interface StructureItem {
  dz: number;
  gate: Gate | null;
  objective: Objective | null;
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
  multiplier: '#b98bff',
};
const OBJ_BROKEN_COLOR = '#3a3a44';

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
    this.drawGround(viewH);
    this.drawStripes();
    this.drawStructures(w);
    this.drawCorpses(w);
    this.drawCrowds(w);
    this.drawBullets(w);
    this.drawHud(w, fps);
    if (w.state === 'dead') this.drawGameOver(w);
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

  /** Ground trapezoid: lane edges converge to the single vanishing point at the horizon. */
  private drawGround(viewH: number): void {
    const ctx = this.ctx;
    const proj = this.projector;
    const horizonY = proj.horizonY;

    // Fill everything below the horizon first so the corners outside the
    // (narrower, converging) lane trapezoid aren't left as gaps.
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, horizonY, LANE_W, Math.max(0, viewH - horizonY));

    const scaleBottom = Math.max((viewH - horizonY) / CAM_HEIGHT, FOCAL / FAR_DZ);
    const dzBottom = Math.max(NEAR, FOCAL / scaleBottom);
    const worldYBottom = proj.camY + dzBottom;
    const left = proj.project(0, worldYBottom);
    const leftX = left.x;
    const leftY = left.y;
    const right = proj.project(LANE_W, worldYBottom);

    ctx.fillStyle = COL_LANE;
    ctx.beginPath();
    ctx.moveTo(leftX, leftY);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(LANE_W / 2, horizonY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = COL_EDGE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(leftX, leftY);
    ctx.lineTo(LANE_W / 2, horizonY);
    ctx.moveTo(right.x, right.y);
    ctx.lineTo(LANE_W / 2, horizonY);
    ctx.stroke();
  }

  /**
   * Scrolling ground stripes, projected from the same worldY grid every
   * frame. Horizontal bands that compress toward the horizon — this is the
   * primary "we are moving forward" cue now that the camera itself is fixed
   * relative to the squad.
   */
  private drawStripes(): void {
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

      const nearL = proj.project(0, y);
      const nearLX = nearL.x;
      const nearLY = nearL.y;
      const nearR = proj.project(LANE_W, y);
      const nearRX = nearR.x;
      const nearRY = nearR.y;
      const farL = proj.project(0, y + STRIPE_THICK);
      const farLX = farL.x;
      const farLY = farL.y;
      const farR = proj.project(LANE_W, y + STRIPE_THICK);

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

  private drawStructures(w: World): void {
    const proj = this.projector;
    const order = this.structureOrder;
    order.length = 0;
    for (const gate of w.gates) {
      if (gate.taken) continue;
      order.push({ dz: proj.dz(gate.y), gate, objective: null });
    }
    for (const o of w.objectives) {
      const dz = proj.dz(o.y);
      if (o.resolved && dz < NEAR) continue;
      order.push({ dz, gate: null, objective: o });
    }
    order.sort((a, b) => b.dz - a.dz);
    for (const item of order) {
      if (item.gate) this.drawGate(item.gate);
      else if (item.objective) this.drawObjective(item.objective, w.weaponTier);
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
      const brokenFlat = o.broken; // weapon/recruit only; multiplier never breaks
      const height = (brokenFlat ? OBJECTIVE_H * 0.22 : OBJECTIVE_H) * scale * (1 + flash * 0.12);
      const baseX = base.x;
      const baseY = base.y;
      const topY = baseY - height;
      const leftX = baseX - halfW;
      const rightX = baseX + halfW;

      ctx.fillStyle = brokenFlat ? OBJ_BROKEN_COLOR : OBJ_COLOR[o.kind as ObjectiveKind];
      this.drawObjectiveSilhouette(o.kind, leftX, rightX, baseY, topY, scale, brokenFlat);

      if (flash > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, flash * 0.85)})`;
        ctx.fillRect(leftX, topY, rightX - leftX, baseY - topY);
      }

      // HP / charge bar, just above the billboard.
      const frac = o.kind === 'multiplier' ? Math.min(1, 1 - o.hp / o.maxHp) : o.hp / o.maxHp;
      if (!brokenFlat) {
        const barW = rightX - leftX;
        const barH = Math.max(2, 5 * scale);
        const barY = topY - barH - Math.max(1, 3 * scale);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(leftX, barY, barW, barH);
        ctx.fillStyle = o.kind === 'multiplier' ? '#b98bff' : '#e8535f';
        ctx.fillRect(leftX, barY, barW * Math.max(0, Math.min(1, frac)), barH);
      }

      // Every structure states what it gives. A silhouette alone does not tell
      // the player whether diverting fire onto it is worth the swarm they let
      // through, which is the entire decision being asked of them.
      const label = brokenFlat ? 'TAKEN' : objectiveLabel(o, weaponTier);
      const panelW = (rightX - leftX) * 0.9;
      const panelH = Math.abs(baseY - topY);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = brokenFlat ? '#7c8394' : '#0d0d12';
      fitText(ctx, label, baseX, baseY - panelH * 0.55, panelW, panelH * 0.42, 34 * scale);

      if (!brokenFlat) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        fitText(
          ctx,
          objectiveCaption(o),
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

    const reds = new Path2D();
    for (let i = 0; i < w.redCount; i++) {
      addStickman(reds, proj, w.redX[i], w.redY[i]);
    }
    ctx.fillStyle = COL_RED;
    ctx.fill(reds);

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
    ctx.fillText(`${w.kills} KILLS`, this.canvas.width - pad, pad);
    ctx.fillStyle = '#454b59';
    ctx.font = `500 ${Math.round(20 * s)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(
      `${fps.toFixed(0)}fps  ${w.redCount}r ${w.bulletCount}b`,
      this.canvas.width - pad,
      pad + 34 * s,
    );
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
  }
}

/**
 * Two subpaths per unit: body slab and head, appended to a shared batch path.
 * Dimensions scale with the projected distance so the crowd shrinks toward
 * the horizon instead of staying a flat top-down size.
 */
function addStickman(path: Path2D, proj: Projector, worldX: number, worldY: number): void {
  const dz = proj.dz(worldY);
  if (dz < NEAR || dz > FAR_DZ) return;
  const p = proj.project(worldX, worldY);
  const scale = p.scale;
  const headR = HEAD_R * scale;
  const hw = BODY_HW * scale;
  if (p.x + headR < 0 || p.x - headR > LANE_W) return;
  const bodyH = BODY_H * scale;
  const headOff = HEAD_OFF * scale;
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
