import { Grid } from '../core/grid.js';
import { Rng } from '../core/rng.js';
import {
  ANCHOR_FOLLOW, BLUE_FOLLOW, BREAKTHROUGH_PAD, BULLET_RADIUS, BULLET_RANGE, CONTACT_PAD, CORPSE_LIFE,
  FIRE_COLUMN_FILL, FIRE_FAN_REF, LANE_W, MAX_BLUE_RENDER, MAX_BULLET, MAX_CORPSE, MAX_EMITTERS, MAX_RED,
  RED_ALIGN_MAX, RED_ALIGN_RANGE, RED_LATERAL_WEIGHT, RED_RADIUS, RED_SPAWN_EDGE_PAD, RED_SPAWN_MIN_SPREAD, RED_SPAWN_RADIUS_GAIN, RED_SPAWN_SPREAD, REF_VIEW_H, SCROLL_SPEED, SPAWN_AHEAD, SQUAD_AHEAD,
  HAZARD_RATE, SQUEEZE_LOOKAHEAD, START_BLUE, TURRET_BULLET_DAMAGE, TURRET_BULLET_SPEED, TURRET_FIRE_RATE, TURRET_RANGE, TURRET_TARGET_RANGE, WEAPONS,
} from './config.js';
import { ENEMIES, ENEMY_KINDS } from './enemies.js';
import {
  clampToCorridor, Corridor, centreAt, hazardOverlap, holeCentreAt, holeHalfWidthAt, spanHalfWidthAt,
} from './corridor.js';
import { formationRadius, formationSqueeze, slotLag, slotX, slotY } from './formation.js';
import { applyGate, Gate, gateHit } from './gates.js';
import { buildLevel, LevelDef, SpawnWave } from './levels.js';
import {
  collectObjective, damageObjective, Objective, OBJECTIVE_H, OBJECTIVE_W, PICKUP_PAD,
} from './objectives.js';
import { Barricade, damageBarricade } from './barricades.js';

/**
 * `won` is reached by crossing the level's finish line, `dead` by losing the
 * squad. An endless level has no finish line and can only end the second way.
 */
export type RunState = 'running' | 'dead' | 'won';

/**
 * Authoritative game state. Deliberately free of any DOM or canvas reference so
 * the whole simulation runs headless in Node — that is what makes balance
 * testable by running a level 500 times instead of guessing.
 */
export class World {
  readonly level: LevelDef;
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
  /** Bodies lost inside hazards. Priced separately so the probe can attribute them. */
  hazardLosses = 0;
  /** Fraction of the crowd currently standing in a hazard, for the renderer. */
  hazardOverlap = 0;
  /** Sub-body remainder of the hazard toll, carried between frames. */
  private hazardDebt = 0;
  gates: Gate[];
  objectives: Objective[];
  barricades: Barricade[];
  /** Kills credited to turrets rather than the squad. */
  turretKills = 0;
  /** World position of the finish line. Infinite on an endless level. */
  readonly finishY: number;
  /** The drivable lane. Steering, spawning and the renderer all read it. */
  readonly corridor: Corridor;
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
  /** Non-zero for bullets fired by a turret rather than the squad. */
  readonly bulFromTurret = new Uint8Array(MAX_BULLET);

  corpseHead = 0;
  readonly corpseX = new Float32Array(MAX_CORPSE);
  readonly corpseY = new Float32Array(MAX_CORPSE);
  readonly corpseAge = new Float32Array(MAX_CORPSE);
  readonly corpseRed = new Uint8Array(MAX_CORPSE);

  private readonly rng: Rng;
  /** The level's spawn script, in ascending release order. */
  private readonly waves: readonly SpawnWave[];
  private waveIndex = 0;
  private readonly grid = new Grid(56, MAX_RED);
  private readonly hits = new Int32Array(256);
  private readonly redDead = new Uint8Array(MAX_RED);
  /** Frontmost slot in each lateral column of the formation — the firing line. */
  private readonly lineSlot = new Int32Array(MAX_EMITTERS);
  private readonly lineFront = new Float32Array(MAX_EMITTERS);
  private fireTimer = 0;
  private squadSettled = false;

  constructor(level: LevelDef, viewH: number) {
    this.level = level;
    // The sim's own stream is seeded apart from the level generator's, so
    // spawn jitter and level content never perturb one another.
    this.rng = new Rng((level.seed * 2 + 1) >>> 0);
    this.viewH = viewH;
    const plan = buildLevel(level);
    this.waves = plan.waves;
    this.gates = plan.gates;
    this.objectives = plan.objectives;
    this.barricades = plan.barricades;
    this.finishY = plan.finishY;
    this.corridor = plan.corridor;
    this.anchorX = centreAt(this.corridor, this.anchorY);
    this.targetX = this.anchorX;
    this.corpseAge.fill(CORPSE_LIFE);
    this.grid.resize(Math.ceil(LANE_W / 56) + 2, Math.ceil((REF_VIEW_H + 700) / 56) + 2);
  }

  get rendered(): number {
    return Math.min(this.count, MAX_BLUE_RENDER);
  }

  /**
   * How hard the crowd is currently squeezed by the corridor. 1 in open lane,
   * so everything derived from it is unchanged on a straight level.
   */
  get squeeze(): number {
    // The tightest span within sight ahead, not just the one underfoot.
    //
    // Reading only the current position made a hazard an unavoidable toll
    // rather than something to steer around: the crowd stayed full width right
    // up to the lip, so the hole opened underneath a 440-wide formation and
    // took its cut before there was any chance to be narrow. Every strategy the
    // probe measures paid the same 15-19% of peak, however carefully it drove.
    //
    // Looking ahead lets a crowd funnel down before it arrives, which is both
    // what a crowd would really do and what makes committing to a side early
    // worth anything.
    const corridor = this.corridor;
    let half = spanHalfWidthAt(corridor, this.anchorY, this.anchorX);
    for (let ahead = SQUEEZE_LOOKAHEAD / 4; ahead <= SQUEEZE_LOOKAHEAD; ahead += SQUEEZE_LOOKAHEAD / 4) {
      const h = spanHalfWidthAt(corridor, this.anchorY + ahead, this.anchorX);
      if (h < half) half = h;
    }
    return formationSqueeze(this.rendered, half);
  }

  /**
   * The crowd is a disc in open lane and an ellipse in a narrow one, so its
   * half-width and half-depth are separate quantities. Lateral things — the
   * firing line, the swarm's frontage, pickup overlap — read `radiusX`; depth
   * things — how far a red must get to have broken through — read `radiusY`.
   */
  get radiusX(): number {
    return formationRadius(this.rendered) * this.squeeze;
  }

  get radiusY(): number {
    return formationRadius(this.rendered) / this.squeeze;
  }

  get distance(): number {
    return this.cameraY;
  }

  /** How far through the level the squad is, 0..1. Always 0 with no finish line. */
  get progress(): number {
    if (!Number.isFinite(this.finishY) || this.finishY <= 0) return 0;
    return Math.min(1, this.anchorY / this.finishY);
  }

  /**
   * Records the viewport for the renderer. Nothing in the sim reads it: the
   * grid, like every other distance, is sized from REF_VIEW_H so it covers
   * the same stretch of lane on every screen.
   */
  resize(viewH: number): void {
    this.viewH = viewH;
  }

  step(dt: number): void {
    if (this.state !== 'running') return;

    this.time += dt;
    this.cameraY += SCROLL_SPEED * dt;
    this.anchorY = this.cameraY + SQUAD_AHEAD;
    if (this.gateFlash > 0) this.gateFlash = Math.max(0, this.gateFlash - dt);

    this.stepAnchor(dt);
    this.stepSquad(dt);
    this.stepGates();
    this.spawnReds();
    this.stepReds(dt);
    this.stepFiring(dt);
    this.stepTurrets(dt);
    this.stepBullets(dt);
    this.grid.rebuild(this.redCount, this.redX, this.redY, -100, this.cameraY - 200);
    this.collideBullets();
    this.collideObjectives();
    this.collideBarricades();
    this.collideSquad();
    this.resolveObjectives();
    this.stepHazard(dt);
    this.stepBarricades(dt);
    this.stepCorpses(dt);

    if (this.count <= 0) {
      this.count = 0;
      this.state = 'dead';
      return;
    }
    // Checked after attrition: a squad wiped out on the line did not make it.
    if (this.anchorY >= this.finishY) this.state = 'won';
  }

  private stepAnchor(dt: number): void {
    // Keep almost the whole crowd inside the corridor. At 0.55 the formation's
    // outer ranks hung off the edge of the screen, which in perspective reads as
    // units vanishing into nothing.
    //
    // On a full-width lane the margin cap works out to LANE_W * 0.36 exactly as
    // it did before the corridor existed, which is what makes a straight level
    // bit-identical to the pre-corridor sim.
    // Measured against the span being steered into rather than the lane as a
    // whole, so the gap beside a hazard gets a margin in proportion to itself.
    // With no hazard open this returns the lane's own half-width, and the cap
    // works out to LANE_W * 0.36 exactly as it did before corridors existed.
    const half = spanHalfWidthAt(this.corridor, this.anchorY, this.targetX);
    const margin = Math.min(this.radiusX * 0.9, half * 0.72);
    this.targetX = clampToCorridor(this.corridor, this.anchorY, this.targetX, margin);
    const k = 1 - Math.exp(-dt * ANCHOR_FOLLOW);
    this.anchorX += (this.targetX - this.anchorX) * k;
  }

  private stepSquad(dt: number): void {
    const n = this.rendered;
    const ax = this.anchorX;
    const ay = this.anchorY;
    // Squeezed laterally and stretched lengthwise, so the crowd keeps its area
    // and every one of its bodies while fitting through a narrower gap.
    const sx = this.squeeze;
    const sy = 1 / sx;
    if (!this.squadSettled) {
      for (let i = 0; i < n; i++) {
        this.blueX[i] = ax + slotX[i] * sx;
        this.blueY[i] = ay + slotY[i] * sy;
      }
      this.squadSettled = true;
      return;
    }
    for (let i = 0; i < n; i++) {
      const k = 1 - Math.exp(-dt * BLUE_FOLLOW * slotLag[i]);
      this.blueX[i] += (ax + slotX[i] * sx - this.blueX[i]) * k;
      this.blueY[i] += (ay + slotY[i] * sy - this.blueY[i]) * k;
    }
  }

  /** Newly recruited units appear at the anchor and flow outward to their slot. */
  private seedNewSlots(previous: number): void {
    const n = this.rendered;
    const sx = this.squeeze;
    for (let i = Math.min(previous, MAX_BLUE_RENDER); i < n; i++) {
      this.blueX[i] = this.anchorX + slotX[i] * sx * 0.2;
      this.blueY[i] = this.anchorY + slotY[i] * (1 / sx) * 0.2;
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

  /**
   * Releases every wave the squad has now reached. Pacing is authored in the
   * level's event list rather than computed here: the sim decides where reds
   * go, never how many arrive or when.
   */
  private spawnReds(): void {
    const waves = this.waves;
    while (this.waveIndex < waves.length && waves[this.waveIndex].y <= this.cameraY) {
      this.spawnWave(waves[this.waveIndex++]);
    }
  }

  private spawnWave(wave: SpawnWave): void {
    const spawnY = this.cameraY + SPAWN_AHEAD;
    const stats = ENEMIES[wave.type];
    const frontage = Math.min(
      RED_SPAWN_SPREAD,
      Math.max(RED_SPAWN_MIN_SPREAD, this.radiusX * RED_SPAWN_RADIUS_GAIN + 70),
    ) * wave.spread;
    for (let i = 0; i < wave.count && this.redCount < MAX_RED; i++) {
      const j = this.redCount++;
      this.redType[j] = wave.type;
      this.redHp[j] = wave.hp;
      const bias = this.anchorX + this.rng.range(-frontage, frontage);
      const y = spawnY + this.rng.range(0, 220);
      // Into the corridor as it is where they appear, not as it is under the
      // squad: a wave released before a bend must arrive inside the bend.
      this.redX[j] = clampToCorridor(this.corridor, y, bias, RED_SPAWN_EDGE_PAD);
      this.redY[j] = y;
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
    const spread = this.radiusX * 0.7 + 26;
    // Anything that gets behind the crowd has broken through the firing line.
    // Depth, not width: a crowd squeezed into a narrow lane is correspondingly
    // deeper, and correspondingly harder to get past.
    const breachY = ay - this.radiusY - BREAKTHROUGH_PAD;
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
      // Reds keep to the drivable lane too, so a bend never has the swarm
      // running through ground the renderer does not draw.
      this.redX[i] = clampToCorridor(this.corridor, this.redY[i], this.redX[i], RED_SPAWN_EDGE_PAD);
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

  /**
   * Picks the firing line: the frontmost unit in each lateral column across the
   * formation. Returns how many columns are manned.
   *
   * Taking the front-most units by forward position instead — which is what this
   * used to do — clusters every emitter near the middle of the disc, because the
   * front of a circle is its narrowest part. The line was then a fraction of the
   * crowd's width no matter which weapon was firing, and only the shotgun's
   * angular fan papered over it.
   */
  private buildFiringLine(n: number): number {
    const cols = Math.min(n, MAX_EMITTERS);
    const r = this.radiusX;
    const span = r * 2 || 1;
    for (let c = 0; c < cols; c++) {
      this.lineSlot[c] = -1;
      this.lineFront[c] = -Infinity;
    }
    for (let i = 0; i < n; i++) {
      let c = (((slotX[i] * this.squeeze + r) / span) * cols) | 0;
      if (c < 0) c = 0;
      else if (c >= cols) c = cols - 1;
      if (slotY[i] > this.lineFront[c]) {
        this.lineFront[c] = slotY[i];
        this.lineSlot[c] = i;
      }
    }
    let manned = 0;
    for (let c = 0; c < cols; c++) {
      if (this.lineSlot[c] >= 0) this.lineSlot[manned++] = this.lineSlot[c];
    }
    return manned;
  }

  private fireVolley(): void {
    const w = WEAPONS[this.weaponTier];
    const n = this.rendered;
    if (n === 0) return;
    const manned = this.buildFiringLine(n);
    if (manned === 0) return;

    /*
     * Every shot flies dead straight. Width comes from where bullets start, not
     * from which way they point, so each emitter only scatters its shots across
     * the gap to its neighbour and the columns tile the formation without holes.
     * Spreading by angle buys the same coverage at the cost of accuracy: the
     * further a bullet travels, the further it has wandered from where it aimed.
     */
    const jitter = ((this.radiusX * 2) / manned) * FIRE_COLUMN_FILL * 0.5;
    // Damage scales with the TRUE count, not the drawn count, so growing past
    // the render cap still makes you stronger.
    const perBullet = Math.max(1, (this.count * w.power) / (manned * w.pellets));

    for (let c = 0; c < manned; c++) {
      const slot = this.lineSlot[c];
      const ox = this.blueX[slot];
      const oy = this.blueY[slot];
      for (let p = 0; p < w.pellets; p++) {
        if (this.bulletCount >= MAX_BULLET) return;
        const j = this.bulletCount++;
        this.bulY[j] = oy;
        if (w.fan > 0 && w.pellets > 1) {
          // A fanned pellet is aimed at an offset it reaches at FIRE_FAN_REF:
          // tight up close, open further out. The angle is small enough that a
          // pellet still lands near where it was pointed.
          const target = (p / (w.pellets - 1) - 0.5) * 2 * jitter * w.fan;
          const angle = Math.atan(target / FIRE_FAN_REF);
          this.bulX[j] = ox;
          this.bulVX[j] = Math.sin(angle) * w.speed;
          this.bulVY[j] = Math.cos(angle) * w.speed;
        } else {
          // Everything else flies dead straight and takes a random column
          // within the gap to its neighbour, so the columns tile without holes.
          this.bulX[j] = ox + this.rng.range(-jitter, jitter);
          this.bulVX[j] = 0;
          this.bulVY[j] = w.speed;
        }
        this.bulLife[j] = BULLET_RANGE / w.speed;
        this.bulDmg[j] = perBullet;
        this.bulFromTurret[j] = 0;
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
    this.bulFromTurret[i] = this.bulFromTurret[last];
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
        if (this.bulFromTurret[i]) this.turretKills++;
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
      if (dy < -OBJECTIVE_H || dy > BULLET_RANGE) continue;
      for (let i = 0; i < this.bulletCount; i++) {
        // A turret's fire is free, so letting it crack the next structure would
        // hand out rewards the squad never diverted a shot to earn.
        if (this.bulFromTurret[i]) continue;
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
      const beforeCount = this.count;
      const overlapped = Math.abs(this.anchorX - o.x) <= this.radiusX + PICKUP_PAD;
      const result = collectObjective(o, this.count, this.weaponTier, overlapped);
      this.count = result.count;
      this.weaponTier = result.weaponTier;
      this.seedNewSlots(before);
      if (this.count > beforeCount) this.gateFlash = 0.35;
    }
    for (const o of this.objectives) {
      if (o.flash > 0) o.flash = Math.max(0, o.flash - 1 / 30);
    }
  }

  /** 1:1 attrition. A red that reaches the crowd takes exactly one blue with it. */
  private collideSquad(): void {
    const ax = this.anchorX;
    const ay = this.anchorY;
    // Elliptical, because the crowd is: a squeezed formation is narrower to
    // reach from the side and deeper to reach from the front.
    const rx = this.radiusX;
    const ry = this.radiusY;
    for (let i = 0; i < this.redCount; i++) {
      const type = this.redType[i];
      const pad = ENEMIES[type].radius + CONTACT_PAD;
      const ex = rx + pad;
      const ey = ry + pad;
      const dx = this.redX[i] - ax;
      const dy = this.redY[i] - ay;
      if ((dx * dx) / (ex * ex) + (dy * dy) / (ey * ey) > 1) continue;
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

  /**
   * Fires turrets that are active: broken and in range, including after the
   * squad has passed them. A turret tracks the nearest red and shoots at it:
   * unlike the squad, which
   * fires dead forward because position *is* targeting, a turret has no
   * position to steer, so aiming is the only thing that makes it a gun rather
   * than a column of fire. Turret bullets are flat-damage and do not spend
   * from the squad's emitter budget.
   *
   * Aiming also gives the range gate a meaning it lacked: a turret the squad
   * has already passed now shoots the reds chasing it, rather than throwing
   * bullets up an empty lane.
   */
  private stepTurrets(dt: number): void {
    const interval = 1 / TURRET_FIRE_RATE;
    for (const o of this.objectives) {
      if (o.kind !== 'turret' || !o.broken) continue;
      if (Math.abs(this.anchorY - o.y) > TURRET_RANGE) continue;

      // Acquired once per frame, not once per shot: at this rate of fire the
      // scan would otherwise run a dozen times a frame for a target that has
      // moved a few units between them.
      const target = this.nearestRed(o.x, o.y);
      o.fireTimer += dt;
      if (target < 0) {
        // Nothing to shoot at. Hold the accumulator just below one interval so
        // the turret fires promptly when a red arrives without dumping a whole
        // lull's worth of banked shots in a single frame.
        if (o.fireTimer > interval) o.fireTimer = interval;
        continue;
      }

      const dx = this.redX[target] - o.x;
      const dy = this.redY[target] - o.y;
      const dist = Math.hypot(dx, dy);
      // A red standing exactly on the turret has no direction; keep the last
      // one rather than dividing by zero.
      if (dist > 1e-3) o.aimAngle = Math.atan2(dx, dy);
      const vx = Math.sin(o.aimAngle) * TURRET_BULLET_SPEED;
      const vy = Math.cos(o.aimAngle) * TURRET_BULLET_SPEED;

      while (o.fireTimer >= interval) {
        o.fireTimer -= interval;
        if (this.bulletCount >= MAX_BULLET) break;
        const j = this.bulletCount++;
        this.bulX[j] = o.x;
        this.bulY[j] = o.y;
        this.bulVX[j] = vx;
        this.bulVY[j] = vy;
        this.bulLife[j] = BULLET_RANGE / TURRET_BULLET_SPEED;
        this.bulDmg[j] = TURRET_BULLET_DAMAGE;
        this.bulFromTurret[j] = 1;
      }
    }
  }

  /**
   * Index of the live red nearest (x, y) within TURRET_TARGET_RANGE, or -1.
   *
   * A linear scan rather than a grid query: `stepTurrets` runs before the grid
   * is rebuilt, so the grid holds last frame's positions, and `query` caps its
   * output at the size of `hits`, which is the wrong shape for a search that
   * has to see every candidate. At most a couple of turrets are ever in range
   * at once, so the scan is cheap and, unlike a capped query, exact.
   */
  private nearestRed(x: number, y: number): number {
    let best = -1;
    let bestD2 = TURRET_TARGET_RANGE * TURRET_TARGET_RANGE;
    for (let i = 0; i < this.redCount; i++) {
      const dx = this.redX[i] - x;
      const dy = this.redY[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  /** Bullets (non-turret) that enter a live barricade's span damage it. */
  private collideBarricades(): void {
    for (const b of this.barricades) {
      if (b.broken) continue;
      for (let i = 0; i < this.bulletCount; i++) {
        if (this.bulFromTurret[i]) continue;
        if (Math.abs(this.bulY[i] - b.y) > b.yHalf) continue;
        // Read the hole at the bullet's own y — the hole is a bump that tapers
        // over its span, so a single peak rectangle over-covers at the edges.
        const hc = holeCentreAt(this.corridor, this.bulY[i]);
        const hw = holeHalfWidthAt(this.corridor, this.bulY[i]);
        if (hw <= 0 || Math.abs(this.bulX[i] - hc) > hw) continue;
        const dmg = this.bulDmg[i];
        this.removeBullet(i);
        i--;
        damageBarricade(b, this.corridor, dmg);
        if (b.broken) break;
      }
    }
  }

  private stepBarricades(dt: number): void {
    for (const b of this.barricades) {
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / 0.4);
    }
  }

  /**
   * Bodies lost to whatever part of the crowd is standing in a hazard.
   *
   * Proportional to the crowd rather than a flat toll, so a hazard still means
   * something to a squad of three thousand. That does not make size a
   * liability the way an undodgeable proportional source would: a hazard can be
   * steered around, so it never caps growth, and a bigger crowd still comes out
   * the far side with more bodies than a smaller one would have.
   */
  private stepHazard(dt: number): void {
    const overlap = hazardOverlap(this.corridor, this.anchorY, this.anchorX, this.radiusX);
    if (overlap <= 0) {
      this.hazardOverlap = 0;
      return;
    }
    this.hazardOverlap = overlap;
    this.hazardDebt += this.count * overlap * HAZARD_RATE * dt;
    // Accumulated in fractions and spent in whole bodies, so a graze that costs
    // less than one blue per frame still costs something over time.
    const toll = Math.floor(this.hazardDebt);
    if (toll <= 0) return;
    this.hazardDebt -= toll;
    const paid = Math.min(toll, this.count);
    this.count -= paid;
    this.hazardLosses += paid;
    for (let i = 0; i < paid && i < 6; i++) {
      this.addCorpse(
        this.anchorX + this.rng.range(-this.radiusX, this.radiusX),
        this.anchorY + this.rng.range(-this.radiusY, this.radiusY),
        false,
      );
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
