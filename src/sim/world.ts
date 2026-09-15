import { Grid } from '../core/grid.js';
import { Rng } from '../core/rng.js';
import {
  ANCHOR_FOLLOW, BLUE_FOLLOW, BREAKTHROUGH_PAD, BULLET_LIFE, BULLET_RADIUS, CONTACT_PAD, CORPSE_LIFE,
  LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_CORPSE, MAX_EMITTERS, MAX_RED,
  RED_ALIGN_MAX, RED_ALIGN_RANGE, RED_LATERAL_WEIGHT, RED_RADIUS, RED_SPAWN_MIN_SPREAD, RED_SPAWN_RADIUS_GAIN, RED_SPAWN_SPREAD, SCROLL_SPEED, SQUAD_SCREEN_FRAC,
  START_BLUE, WEAPONS,
} from './config.js';
import {
  ENEMIES, ENEMY_KINDS, enemyHp, mixAt, pickType,
} from './enemies.js';
import { formationRadius, frontOrder, slotLag, slotX, slotY } from './formation.js';
import { applyGate, buildGates, Gate, gateHit } from './gates.js';
import {
  buildObjectives, collectObjective, damageObjective, Objective, OBJECTIVE_H, OBJECTIVE_W,
} from './objectives.js';
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
  /**
   * Per-type attribution for balance work. Only contacts and breakthroughs cost
   * blues; a kill at range costs nothing, so the three are counted separately
   * rather than lumped together.
   */
  readonly killsByType = new Int32Array(ENEMY_KINDS);
  readonly contactsByType = new Int32Array(ENEMY_KINDS);
  readonly leaksByType = new Int32Array(ENEMY_KINDS);
  /**
   * Reds that broke through the crowd. Each one costs a blue, so this is a
   * pressure gauge rather than a bug counter: it is the price of leaving part
   * of the swarm unshot.
   */
  leaked = 0;
  gates: Gate[];
  objectives: Objective[];
  /** Set for one frame when a gate fires, so the renderer can punch it up. */
  gateFlash = 0;

  readonly blueX = new Float32Array(MAX_BLUE_RENDER);
  readonly blueY = new Float32Array(MAX_BLUE_RENDER);

  redCount = 0;
  readonly redX = new Float32Array(MAX_RED);
  readonly redY = new Float32Array(MAX_RED);
  readonly redSpeed = new Float32Array(MAX_RED);
  readonly redType = new Uint8Array(MAX_RED);
  readonly redHp = new Float32Array(MAX_RED);
  /** Per-red lateral bias, so the swarm envelops the crowd instead of queueing into it. */
  readonly redOff = new Float32Array(MAX_RED);

  bulletCount = 0;
  readonly bulX = new Float32Array(MAX_BULLET);
  readonly bulY = new Float32Array(MAX_BULLET);
  readonly bulVX = new Float32Array(MAX_BULLET);
  readonly bulVY = new Float32Array(MAX_BULLET);
  readonly bulLife = new Float32Array(MAX_BULLET);
  /** Damage pool. A bullet spends it across the reds it passes through. */
  readonly bulDmg = new Float32Array(MAX_BULLET);

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
  private readonly mix = new Float32Array(ENEMY_KINDS);
  private fireTimer = 0;
  private squadSettled = false;

  constructor(seed: number, viewH: number) {
    this.rng = new Rng(seed);
    this.viewH = viewH;
    this.gates = buildGates(this.rng, 14);
    this.objectives = buildObjectives(this.rng, 20, this.gates.map((g) => g.y));
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
    this.collideObjectives();
    this.collideSquad();
    this.resolveObjectives();
    this.stepCorpses(dt);

    if (this.count <= 0) {
      this.count = 0;
      this.state = 'dead';
    }
  }

  private stepAnchor(dt: number): void {
    // Keep almost the whole crowd inside the lane. At 0.55 the formation's outer
    // ranks hung off the edge of the screen, which in perspective reads as units
    // vanishing into nothing.
    const margin = Math.min(this.radius * 0.9, LANE_W * 0.36);
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
      if (!gateHit(gate, this.anchorX)) continue;
      const op = gate.op;
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
      const km = this.distance / 1000;
      mixAt(km, this.mix);
      const type = pickType(this.mix, this.rng.next());
      const stats = ENEMIES[type];
      this.redType[j] = type;
      this.redHp[j] = enemyHp(type, km);
      const frontage = Math.min(
        RED_SPAWN_SPREAD,
        Math.max(RED_SPAWN_MIN_SPREAD, this.radius * RED_SPAWN_RADIUS_GAIN + 70),
      );
      const bias = this.anchorX + this.rng.range(-frontage, frontage);
      this.redX[j] = bias < 25 ? 25 : bias > LANE_W - 25 ? LANE_W - 25 : bias;
      this.redY[j] = spawnY + this.rng.range(0, 220);
      this.redSpeed[j] = this.rng.range(stats.speedMin, stats.speedMax);
      this.redOff[j] = this.rng.range(-1, 1);
    }
  }

  /**
   * Reds run at the squad, not down the screen. Pursuit is full 2D: the target
   * is the crowd itself, so a red that drifts wide turns back in rather than
   * sailing past. Each red keeps a lateral bias across the crowd's front so the
   * swarm arrives as a wave instead of a single file.
   */
  private stepReds(dt: number): void {
    const cullY = this.cameraY - 160;
    const ax = this.anchorX;
    const ay = this.anchorY;
    const spread = this.radius * 0.7 + 26;
    // Anything that gets behind the crowd has broken through the firing line.
    const breachY = ay - this.radius - BREAKTHROUGH_PAD;
    for (let i = 0; i < this.redCount; i++) {
      const tx = ax + this.redOff[i] * spread;
      const dy = ay - this.redY[i];
      // Interception, not naive pursuit: while there is still room ahead a red
      // spends it lining up on the squad's column, and only charges once level.
      // Closing the gap first just lands it alongside, where it can never catch
      // up to a squad that advances faster than it runs.
      const ahead = dy < 0 ? -dy : 0;
      const gain = RED_LATERAL_WEIGHT + Math.min(RED_ALIGN_MAX, ahead / RED_ALIGN_RANGE);
      const dx = (tx - this.redX[i]) * gain;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const step = this.redSpeed[i] * dt;
      this.redX[i] += (dx / d) * step;
      this.redY[i] += (dy / d) * step;
      // A breakthrough is never free: it takes one blue down with it and dies
      // there, so every red you fail to shoot in front of you is a body lost.
      if (this.redY[i] < breachY || this.redY[i] < cullY) {
        const type = this.redType[i];
        const cost = ENEMIES[type].cost;
        this.addCorpse(this.redX[i], this.redY[i], true);
        this.addCorpse(this.redX[i], this.redY[i], false);
        this.leaked++;
        this.leaksByType[type]++;
        this.removeRed(i);
        i--;
        this.count -= cost;
        if (this.count <= 0) {
          this.count = 0;
          return;
        }
      }
    }
  }

  private removeRed(i: number): void {
    const last = --this.redCount;
    this.redX[i] = this.redX[last];
    this.redY[i] = this.redY[last];
    this.redSpeed[i] = this.redSpeed[last];
    this.redOff[i] = this.redOff[last];
    this.redType[i] = this.redType[last];
    this.redHp[i] = this.redHp[last];
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

  private fireVolley(): void {
    const w = WEAPONS[this.weaponTier];
    const n = this.rendered;
    if (n === 0) return;
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
      // Fire is fixed forward: what you hit is decided by where you stand, which
      // is what makes shooting an objective cost you swarm control.
      const emitterAim = this.rng.range(-0.03, 0.03);
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
        this.bulDmg[j] = perBullet;
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
    this.bulDmg[i] = this.bulDmg[last];
  }

  private collideBullets(): void {
    const hitR = RED_RADIUS + BULLET_RADIUS;
    const dead = this.redDead;
    let anyDead = false;

    for (let i = 0; i < this.bulletCount; i++) {
      const bx = this.bulX[i];
      const by = this.bulY[i];
      let dmg = this.bulDmg[i];
      const n = this.grid.query(bx, by, hitR, this.hits);
      for (let h = 0; h < n && dmg > 0; h++) {
        const r = this.hits[h];
        if (dead[r] === 1) continue;
        const rr = hitR + ENEMIES[this.redType[r]].radius - RED_RADIUS;
        const dx = this.redX[r] - bx;
        const dy = this.redY[r] - by;
        if (dx * dx + dy * dy > rr * rr) continue;

        const hp = this.redHp[r];
        if (hp > dmg) {
          // A tough enemy absorbs the rest of the bullet. That is the point of
          // a brute: it eats fire that would otherwise be shredding the tide.
          this.redHp[r] = hp - dmg;
          dmg = 0;
          break;
        }
        dmg -= hp;
        // Flag rather than swap-remove: the grid holds indices into these
        // arrays, so compaction has to wait until every bullet is resolved.
        dead[r] = 1;
        anyDead = true;
        this.addCorpse(this.redX[r], this.redY[r], true);
        this.kills++;
        this.killsByType[this.redType[r]]++;
      }
      if (dmg !== this.bulDmg[i]) {
        this.bulDmg[i] = dmg;
        if (dmg <= 0) {
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
        this.redType[w] = this.redType[r];
        this.redHp[w] = this.redHp[r];
      }
      w++;
    }
    this.redCount = w;
  }

  /** Bullets damage structures too, so aiming at one is aiming away from the swarm. */
  private collideObjectives(): void {
    const halfW = OBJECTIVE_W / 2;
    for (const o of this.objectives) {
      if (o.resolved || o.broken) continue;
      const dy = o.y - this.anchorY;
      if (dy < -OBJECTIVE_H || dy > 1400) continue;
      for (let i = 0; i < this.bulletCount; i++) {
        if (Math.abs(this.bulX[i] - o.x) > halfW) continue;
        if (Math.abs(this.bulY[i] - o.y) > OBJECTIVE_H / 2) continue;
        damageObjective(o, this.bulDmg[i]);
        this.removeBullet(i);
        i--;
        if (o.broken) break;
      }
    }
  }

  /** Settles each objective's reward as the squad draws level with it. */
  private resolveObjectives(): void {
    for (const o of this.objectives) {
      if (o.resolved || this.anchorY < o.y) continue;
      const before = this.rendered;
      const result = collectObjective(o, this.count, this.weaponTier);
      this.count = result.count;
      this.weaponTier = result.weaponTier;
      this.seedNewSlots(before);
      if (this.count > before) this.gateFlash = 0.35;
    }
    for (const o of this.objectives) {
      if (o.flash > 0) o.flash = Math.max(0, o.flash - 1 / 30);
    }
  }

  /** 1:1 attrition. A red that reaches the crowd takes exactly one blue with it. */
  private collideSquad(): void {
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (let i = 0; i < this.redCount; i++) {
      const type = this.redType[i];
      const reach = this.radius + ENEMIES[type].radius + CONTACT_PAD;
      const dx = this.redX[i] - ax;
      const dy = this.redY[i] - ay;
      if (dx * dx + dy * dy > reach * reach) continue;
      this.addCorpse(this.redX[i], this.redY[i], true);
      this.addCorpse(this.redX[i], this.redY[i], false);
      this.kills++;
      this.contactsByType[type]++;
      this.removeRed(i);
      i--;
      this.count -= ENEMIES[type].cost;
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
