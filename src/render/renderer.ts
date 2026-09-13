import {
  BULLET_RADIUS, CORPSE_LIFE, LANE_W, MAX_BLUE_RENDER, MAX_CORPSE, WEAPONS,
} from '../sim/config.js';
import { gateIsGood, gateLabel, GATE_MID } from '../sim/gates.js';
import type { World } from '../sim/world.js';

const TAU = Math.PI * 2;

const COL_BG = '#0d0d12';
const COL_LANE = '#15151d';
const COL_STRIPE = '#1b1b26';
const COL_EDGE = '#23233010';
const COL_BLUE = '#4da3ff';
const COL_RED = '#ff3b47';
const COL_BULLET = '#ffe066';
const COL_CORPSE = '#2a1a22';

const STRIPE = 200;
const GATE_H = 90;

/**
 * Draws the whole world with a fixed, tiny number of fill calls: one path per
 * team, one for bullets, one for corpses. Per-unit draw calls would put a
 * thousand state changes in the hot path and never hold 60fps on Safari.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
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

    const sy = (worldY: number): number => viewH - (worldY - w.cameraY);

    this.drawLane(w, viewH, sy);
    this.drawCorpses(w, sy);
    this.drawGates(w, viewH, sy);
    this.drawCrowds(w, sy);
    this.drawBullets(w, sy);
    this.drawHud(w, fps);
    if (w.state === 'dead') this.drawGameOver(w);
  }

  private drawLane(w: World, viewH: number, sy: (y: number) => number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COL_LANE;
    ctx.fillRect(0, 0, LANE_W, viewH);

    // Scrolling stripes: without them the forward motion is invisible.
    ctx.fillStyle = COL_STRIPE;
    const first = Math.floor(w.cameraY / STRIPE) * STRIPE;
    for (let y = first; y < w.cameraY + viewH + STRIPE; y += STRIPE) {
      ctx.fillRect(0, sy(y) - 26, LANE_W, 26);
    }
    ctx.fillStyle = COL_EDGE;
    ctx.fillRect(0, 0, 6, viewH);
    ctx.fillRect(LANE_W - 6, 0, 6, viewH);
  }

  private drawCorpses(w: World, sy: (y: number) => number): void {
    const ctx = this.ctx;
    const path = new Path2D();
    let any = false;
    for (let i = 0; i < MAX_CORPSE; i++) {
      if (w.corpseAge[i] >= CORPSE_LIFE) continue;
      const y = sy(w.corpseY[i]);
      if (y < -20 || y > w.viewH + 20) continue;
      path.rect(w.corpseX[i] - 7, y - 3, 14, 6);
      any = true;
    }
    if (!any) return;
    ctx.fillStyle = COL_CORPSE;
    ctx.fill(path);
  }

  private drawGates(w: World, viewH: number, sy: (y: number) => number): void {
    const ctx = this.ctx;
    for (const gate of w.gates) {
      if (gate.taken) continue;
      const y = sy(gate.y);
      if (y < -GATE_H || y > viewH + GATE_H) continue;

      const halves = [
        { op: gate.left, x: 0 },
        { op: gate.right, x: GATE_MID },
      ];
      for (const half of halves) {
        const good = gateIsGood(half.op);
        ctx.fillStyle = good ? 'rgba(60,200,120,0.16)' : 'rgba(220,60,70,0.16)';
        ctx.fillRect(half.x + 4, y - GATE_H, GATE_MID - 8, GATE_H);
        ctx.fillStyle = good ? '#3ecb7a' : '#e8535f';
        ctx.fillRect(half.x + 4, y - 5, GATE_MID - 8, 5);

        ctx.font = 'bold 44px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(gateLabel(half.op), half.x + GATE_MID / 2, y - GATE_H / 2);
      }
    }
  }

  private drawCrowds(w: World, sy: (y: number) => number): void {
    const ctx = this.ctx;
    const viewH = w.viewH;

    const reds = new Path2D();
    for (let i = 0; i < w.redCount; i++) {
      const y = sy(w.redY[i]);
      if (y < -30 || y > viewH + 30) continue;
      stickman(reds, w.redX[i], y);
    }
    ctx.fillStyle = COL_RED;
    ctx.fill(reds);

    const blues = new Path2D();
    const n = Math.min(w.rendered, MAX_BLUE_RENDER);
    for (let i = 0; i < n; i++) {
      stickman(blues, w.blueX[i], sy(w.blueY[i]));
    }
    ctx.fillStyle = COL_BLUE;
    ctx.fill(blues);
  }

  private drawBullets(w: World, sy: (y: number) => number): void {
    const ctx = this.ctx;
    if (w.bulletCount === 0) return;
    const path = new Path2D();
    for (let i = 0; i < w.bulletCount; i++) {
      const y = sy(w.bulY[i]);
      if (y < -20 || y > w.viewH + 20) continue;
      path.rect(w.bulX[i] - BULLET_RADIUS * 0.45, y - 9, BULLET_RADIUS * 0.9, 12);
    }
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

/** Two subpaths per unit: body slab and head. Appended to a shared batch path. */
function stickman(path: Path2D, x: number, y: number): void {
  path.rect(x - 3.2, y - 11, 6.4, 11);
  path.moveTo(x + 3.9, y - 14.6);
  path.arc(x, y - 14.6, 3.9, 0, TAU);
}
