import { Grid } from '../core/grid.js';
import { Rng } from '../core/rng.js';
import {
  AIM_MAX_ANGLE, ANCHOR_FOLLOW, BLUE_FOLLOW, BULLET_LIFE, BULLET_RADIUS, CONTACT_PAD, CORPSE_LIFE,
  LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_CORPSE, MAX_EMITTERS, MAX_RED,
  RED_HOMING, RED_RADIUS, RED_SPEED_MAX, RED_SPEED_MIN, SCROLL_SPEED, SQUAD_SCREEN_FRAC,
  START_BLUE, WEAPONS,
} from './config.js';
import { formationRadius, frontOrder, slotLag, slotX, slotY } from './formation.js';
import { applyGate, buildGates, Gate, GATE_MID } from './gates.js';
import { Director } from './swarm.js';

export type RunState = 'running' | 'dead';

/**
 * Authoritative game state. Deliberately free of any DOM or canvas reference so
 * the whole simulation runs headless in Node — that is what makes balance
 * testable by running a level 500 times instead of guessing.
 */
export class World {
  state: RunState = 'running';
  time = 0;
  cameraY = 0;
  viewH: number;

  /** True squad size. Can exceed what is drawn. */
  count = START_BLUE;
  anchorX = LANE_W / 2;
  anchorY = 0;
  targetX = LANE_W / 2;
  weaponTier = 0;

  kills = 0;
  gates: Gate[];
  /** Set for one frame when a gate fires, so the renderer can punch it up. */
  gateFlash = 0;

  readonly blueX = new Float32Array(MAX_BLUE_RENDER);
  readonly blueY = new Float32Array(MAX_BLUE_RENDER);

  redCount = 0;
  readonly redX = new Float32Array(MAX_RED);
  readonly redY = new Float32Array(MAX_RED);
  readonly redSpeed = new Float32Array(MAX_RED);
  /** Per-red lateral bias, so the swarm envelops the crowd instead of queueing into it. */
  readonly redOff = new Float32Array(MAX_RED);

  bulletCount = 0;
  readonly bulX = new Float32Array(MAX_BULLET);
  readonly bulY = new Float32Array(MAX_BULLET);
  readonly bulVX = new Float32Array(MAX_BULLET);
  readonly bulVY = new Float32Array(MAX_BULLET);
  readonly bulLife = new Float32Array(MAX_BULLET);
  readonly bulPierce = new Float32Array(MAX_BULLET);

  corpseHead = 0;
  readonly corpseX = new Float32Array(MAX_CORPSE);
  readonly corpseY = new Float32Array(MAX_CORPSE);
  readonly corpseAge = new Float32Array(MAX_CORPSE);
  readonly corpseRed = new Uint8Array(MAX_CORPSE);

  private readonly rng: Rng;
  private readonly director = new Director();
  private readonly grid = new Grid(56, MAX_RED);
  private readonly hits = new Int32Array(256);
  private readonly redDead = new Uint8Array(MAX_RED);
  private fireTimer = 0;
  private squadSettled = false;

  constructor(seed: number, viewH: number) {
    this.rng = new Rng(seed);
    this.viewH = viewH;
    this.gates = buildGates(this.rng, 14);
    this.corpseAge.fill(CORPSE_LIFE);
    this.resize(viewH);
  }

  get rendered(): number {
    return Math.min(this.count, MAX_BLUE_RENDER);
  }

  get radius(): number {
    return formationRadius(this.rendered);
  }

  get distance(): number {
    return this.cameraY;
  }

  resize(viewH: number): void {
    this.viewH = viewH;
    this.grid.resize(Math.ceil(LANE_W / 56) + 2, Math.ceil((viewH + 700) / 56) + 2);
  }

  step(dt: number): void {
    if (this.state !== 'running') return;

    this.time += dt;
    this.cameraY += SCROLL_SPEED * dt;
    this.anchorY = this.cameraY + this.viewH * SQUAD_SCREEN_FRAC;
    if (this.gateFlash > 0) this.gateFlash = Math.max(0, this.gateFlash - dt);

    this.stepAnchor(dt);
    this.stepSquad(dt);
    this.stepGates();
    this.spawnReds(dt);
    this.stepReds(dt);
    this.stepFiring(dt);
    this.stepBullets(dt);
    this.grid.rebuild(this.redCount, this.redX, this.redY, -100, this.cameraY - 200);
    this.collideBullets();
    this.collideSquad();
    this.stepCorpses(dt);

    if (this.count <= 0) {
      this.count = 0;
      this.state = 'dead';
    }
  }

  private stepAnchor(dt: number): void {
    const margin = Math.min(this.radius * 0.55, LANE_W * 0.32);
    if (this.targetX < margin) this.targetX = margin;
    else if (this.targetX > LANE_W - margin) this.targetX = LANE_W - margin;
    const k = 1 - Math.exp(-dt * ANCHOR_FOLLOW);
    this.anchorX += (this.targetX - this.anchorX) * k;
  }

  private stepSquad(dt: number): void {
    const n = this.rendered;
    const ax = this.anchorX;
    const ay = this.anchorY;
    if (!this.squadSettled) {
      for (let i = 0; i < n; i++) {
        this.blueX[i] = ax + slotX[i];
        this.blueY[i] = ay + slotY[i];
      }
      this.squadSettled = true;
      return;
    }
    for (let i = 0; i < n; i++) {
      const k = 1 - Math.exp(-dt * BLUE_FOLLOW * slotLag[i]);
      this.blueX[i] += (ax + slotX[i] - this.blueX[i]) * k;
      this.blueY[i] += (ay + slotY[i] - this.blueY[i]) * k;
    }
  }

  /** Newly recruited units appear at the anchor and flow outward to their slot. */
  private seedNewSlots(previous: number): void {
    const n = this.rendered;
    for (let i = Math.min(previous, MAX_BLUE_RENDER); i < n; i++) {
      this.blueX[i] = this.anchorX + slotX[i] * 0.2;
      this.blueY[i] = this.anchorY + slotY[i] * 0.2;
    }
  }

  private stepGates(): void {
    for (const gate of this.gates) {
      if (gate.taken || this.anchorY < gate.y) continue;
      gate.taken = true;
      const op = this.anchorX < GATE_MID ? gate.left : gate.right;
      const before = this.rendered;
      const result = applyGate(op, this.count);
      this.count = result.count;
      if (result.weaponTier !== null) this.weaponTier = result.weaponTier;
      this.seedNewSlots(before);
      this.gateFlash = 0.35;
    }
  }

  private spawnReds(dt: number): void {
    const n = this.director.step(dt, this.distance, this.rng);
    const spawnY = this.cameraY + this.viewH + 60;
    for (let i = 0; i < n && this.redCount < MAX_RED; i++) {
      const j = this.redCount++;
      this.redX[j] = this.rng.range(30, LANE_W - 30);
      this.redY[j] = spawnY + this.rng.range(0, 220);
      this.redSpeed[j] = this.rng.range(RED_SPEED_MIN, RED_SPEED_MAX);
      this.redOff[j] = this.rng.range(-1, 1);
    }
  }

  /**
   * Reds converge on the squad rather than running straight down the lane. Without
   * this they only threaten whichever column you happen to be standing in, and the
   * swarm reads as weather instead of as something hunting you.
   */
  private stepReds(dt: number): void {
    const cullY = this.cameraY - 120;
    const ax = this.anchorX;
    const spread = this.radius + 45;
    for (let i = 0; i < this.redCount; i++) {
      const speed = this.redSpeed[i];
      const dx = ax + this.redOff[i] * spread - this.redX[i];
      const lateral = speed * RED_HOMING;
      const vx = dx > lateral * dt ? lateral : dx < -lateral * dt ? -lateral : dx / Math.max(dt, 1e-6);
      this.redX[i] += vx * dt;
      this.redY[i] -= speed * dt;
      if (this.redY[i] < cullY) {
        this.removeRed(i);
        i--;
      }
    }
  }

  private removeRed(i: number): void {
    const last = --this.redCount;
    this.redX[i] = this.redX[last];
    this.redY[i] = this.redY[last];
    this.redSpeed[i] = this.redSpeed[last];
    this.redOff[i] = this.redOff[last];
  }

  private stepFiring(dt: number): void {
    const w = WEAPONS[this.weaponTier];
    this.fireTimer += dt;
    const interval = 1 / w.rate;
    let shots = 0;
    while (this.fireTimer >= interval && shots < 4) {
      this.fireTimer -= interval;
      this.fireVolley();
      shots++;
    }
    if (shots === 4) this.fireTimer = 0;
  }

  /**
   * Angle (from straight ahead) toward the nearest red in front of the squad.
   * Clamped so volleys still read as forward fire rather than the crowd
   * spinning to shoot sideways.
   */
  private aimAngle(): number {
    let bestD2 = Infinity;
    let bestX = 0;
    let bestY = 0;
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (let i = 0; i < this.redCount; i++) {
      const dy = this.redY[i] - ay;
      if (dy < 0) continue;
      const dx = this.redX[i] - ax;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestX = dx;
        bestY = dy;
      }
    }
    if (bestD2 === Infinity) return 0;
    const a = Math.atan2(bestX, Math.max(bestY, 1));
    return a > AIM_MAX_ANGLE ? AIM_MAX_ANGLE : a < -AIM_MAX_ANGLE ? -AIM_MAX_ANGLE : a;
  }

  private fireVolley(): void {
    const w = WEAPONS[this.weaponTier];
    const n = this.rendered;
    if (n === 0) return;
    const aim = this.aimAngle();
    const emitters = Math.min(n, MAX_EMITTERS);
    // Damage scales with the TRUE count, not the drawn count, so growing past
    // the render cap still makes you stronger.
    const perBullet = Math.max(1, (this.count * w.power) / (emitters * w.pellets));

    let placed = 0;
    for (let k = 0; k < MAX_BLUE_RENDER && placed < emitters; k++) {
      const slot = frontOrder[k];
      if (slot >= n) continue;
      placed++;
      const ox = this.blueX[slot];
      const oy = this.blueY[slot];
      const emitterAim = aim + this.rng.range(-0.07, 0.07);
      for (let p = 0; p < w.pellets; p++) {
        if (this.bulletCount >= MAX_BULLET) return;
        const spread = emitterAim + (w.pellets > 1
          ? (p / (w.pellets - 1) - 0.5) * 2 * w.spread
          : this.rng.range(-w.spread, w.spread));
        const j = this.bulletCount++;
        this.bulX[j] = ox;
        this.bulY[j] = oy;
        this.bulVX[j] = Math.sin(spread) * w.speed;
        this.bulVY[j] = Math.cos(spread) * w.speed;
        this.bulLife[j] = BULLET_LIFE;
        this.bulPierce[j] = perBullet;
      }
    }
  }

  private stepBullets(dt: number): void {
    for (let i = 0; i < this.bulletCount; i++) {
      this.bulX[i] += this.bulVX[i] * dt;
      this.bulY[i] += this.bulVY[i] * dt;
      this.bulLife[i] -= dt;
      if (this.bulLife[i] <= 0) {
        this.removeBullet(i);
        i--;
      }
    }
  }

  private removeBullet(i: number): void {
    const last = --this.bulletCount;
    this.bulX[i] = this.bulX[last];
    this.bulY[i] = this.bulY[last];
    this.bulVX[i] = this.bulVX[last];
    this.bulVY[i] = this.bulVY[last];
    this.bulLife[i] = this.bulLife[last];
    this.bulPierce[i] = this.bulPierce[last];
  }

  private collideBullets(): void {
    const hitR = RED_RADIUS + BULLET_RADIUS;
    const hitR2 = hitR * hitR;
    const dead = this.redDead;
    let anyDead = false;

    for (let i = 0; i < this.bulletCount; i++) {
      const bx = this.bulX[i];
      const by = this.bulY[i];
      let pierce = this.bulPierce[i];
      const n = this.grid.query(bx, by, hitR, this.hits);
      for (let h = 0; h < n && pierce >= 1; h++) {
        const r = this.hits[h];
        if (dead[r] === 1) continue;
        const dx = this.redX[r] - bx;
        const dy = this.redY[r] - by;
        if (dx * dx + dy * dy > hitR2) continue;
        // Flag rather than swap-remove: the grid holds indices into these arrays,
        // so compaction has to wait until every bullet has been resolved.
        dead[r] = 1;
        anyDead = true;
        this.addCorpse(this.redX[r], this.redY[r], true);
        this.kills++;
        pierce -= 1;
      }
      if (pierce !== this.bulPierce[i]) {
        this.bulPierce[i] = pierce;
        if (pierce < 1) {
          this.removeBullet(i);
          i--;
        }
      }
    }

    if (!anyDead) return;
    let w = 0;
    for (let r = 0; r < this.redCount; r++) {
      if (dead[r] === 1) {
        dead[r] = 0;
        continue;
      }
      if (w !== r) {
        this.redX[w] = this.redX[r];
        this.redY[w] = this.redY[r];
        this.redSpeed[w] = this.redSpeed[r];
        this.redOff[w] = this.redOff[r];
      }
      w++;
    }
    this.redCount = w;
  }

  /** 1:1 attrition. A red that reaches the crowd takes exactly one blue with it. */
  private collideSquad(): void {
    const reach = this.radius + RED_RADIUS + CONTACT_PAD;
    const reach2 = reach * reach;
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (let i = 0; i < this.redCount; i++) {
      const dx = this.redX[i] - ax;
      const dy = this.redY[i] - ay;
      if (dx * dx + dy * dy > reach2) continue;
      this.addCorpse(this.redX[i], this.redY[i], true);
      this.addCorpse(this.redX[i], this.redY[i], false);
      this.removeRed(i);
      i--;
      this.count--;
      if (this.count <= 0) {
        this.count = 0;
        return;
      }
    }
  }

  private addCorpse(x: number, y: number, red: boolean): void {
    const i = this.corpseHead;
    this.corpseHead = (i + 1) % MAX_CORPSE;
    this.corpseX[i] = x;
    this.corpseY[i] = y;
    this.corpseAge[i] = 0;
    this.corpseRed[i] = red ? 1 : 0;
  }

  private stepCorpses(dt: number): void {
    for (let i = 0; i < MAX_CORPSE; i++) {
      if (this.corpseAge[i] < CORPSE_LIFE) this.corpseAge[i] += dt;
    }
  }
}
