import { describe, expect, it } from 'vitest';
import { isUnlocked, Progress, withCleared } from '../app/progress.js';
import { CAMPAIGN, levelById } from './campaign.js';
import { SCROLL_SPEED } from './config.js';
import { isStraight } from './corridor.js';
import { BRUTE, ENEMY_KINDS, EnemyType, EXPLODER, RUNNER } from './enemies.js';
import { buildLevel, endlessLevel, LevelDef } from './levels.js';
import { World } from './world.js';

const VIEW_H = 1560;

/** The probe's reference player: takes structures it passes close to, dodges bad gates. */
function competent(w: World): void {
  const o = w.objectives.find((x) => !x.resolved && x.y > w.anchorY - 50);
  if (o && o.y - w.anchorY < 900) {
    w.targetX = o.x;
    return;
  }
  const g = w.gates.find((x) => !x.taken && x.y > w.anchorY - 200);
  if (!g) return;
  const good = g.op.kind !== 'sub' && g.op.kind !== 'div';
  w.targetX = good ? g.cx : g.cx + (g.cx > 360 ? -225 : 225);
}

/** Plays a level to a conclusion, with a step budget derived from its length. */
function playOut(level: LevelDef, drive = competent, viewH: number = VIEW_H): World {
  const w = new World(level, viewH);
  const budget = Math.ceil(((level.length / SCROLL_SPEED) * 1.35 + 10) * 60);
  for (let i = 0; i < budget && w.state === 'running'; i++) {
    drive(w);
    w.step(1 / 60);
  }
  return w;
}

describe('no-op guarantee', () => {
  it('a level without barricades or turrets produces zero of each', () => {
    for (const level of CAMPAIGN) {
      if ((level.barricades?.length ?? 0) > 0 || level.structures.turretFirst != null) continue;
      const plan = buildLevel(level);
      expect(plan.barricades).toHaveLength(0);
      expect(plan.objectives.filter((o) => o.kind === 'turret')).toHaveLength(0);
    }
  });

  it('isStraight still holds on every level with no corridor spec and no barricades', () => {
    for (const level of CAMPAIGN) {
      if (level.corridor || (level.barricades?.length ?? 0) > 0) continue;
      expect(isStraight(buildLevel(level).corridor)).toBe(true);
    }
  });
});

describe('level generation', () => {
  it('never throws building any shipped campaign level', () => {
    // buildBarricades throws on a barricade whose hole the corridor refused
    // to write — the right call for a data bug, but only if something catches
    // it before it reaches a bad LevelDef added to the campaign. This is that
    // net: every level the game actually ships must build cleanly.
    for (const level of CAMPAIGN) {
      expect(() => buildLevel(level)).not.toThrow();
    }
  });

  it('is reproducible: the same definition generates the same level', () => {
    // The whole campaign rests on this. If level 7 is not level 7 every time,
    // a tuned win rate describes a game nobody plays.
    for (const level of CAMPAIGN) {
      const a = buildLevel(level);
      const b = buildLevel(level);
      expect(a.waves).toEqual(b.waves);
      expect(a.gates.map((g) => [g.y, g.cx, g.op.kind, g.op.value]))
        .toEqual(b.gates.map((g) => [g.y, g.cx, g.op.kind, g.op.value]));
      expect(a.objectives.map((o) => [o.y, o.x, o.kind, o.value]))
        .toEqual(b.objectives.map((o) => [o.y, o.x, o.kind, o.value]));
    }
  });

  it('differs between levels', () => {
    const a = buildLevel(CAMPAIGN[0] as LevelDef);
    const b = buildLevel(CAMPAIGN[1] as LevelDef);
    expect(a.waves).not.toEqual(b.waves);
  });

  it('releases waves in ascending order, which is what the sim assumes', () => {
    // The sim walks the list with a single index and never looks back, so an
    // out-of-order wave is silently never spawned.
    for (const level of CAMPAIGN) {
      const { waves } = buildLevel(level);
      expect(waves.length).toBeGreaterThan(20);
      for (let i = 1; i < waves.length; i++) {
        expect(waves[i].y).toBeGreaterThanOrEqual(waves[i - 1].y);
      }
    }
  });

  it('spawns only the archetypes a level asked for', () => {
    for (const level of CAMPAIGN) {
      for (const wave of buildLevel(level).waves) {
        expect(level.mix[wave.type] ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('never lets a saturated tide starve a template of its scripted bursts', () => {
    // emitTide and emitBursts used to share one MAX_WAVES cap on the same
    // array; emitTide ran first, so a level whose tide alone reached that cap
    // silently dropped every burst — the thing that makes runner-rush,
    // brute-wall and gauntlet distinct from a plain tide. A pathologically
    // long level pushes the tide well past what used to be the *shared*
    // budget; each burst template must still produce at least one wave of
    // each of its archetypes.
    const burstTypes: Partial<Record<string, EnemyType[]>> = {
      'runner-rush': [RUNNER],
      'brute-wall': [BRUTE],
      gauntlet: [RUNNER, BRUTE, EXPLODER],
    };
    for (const level of CAMPAIGN) {
      const types = burstTypes[level.template];
      if (!types) continue;
      const saturated: LevelDef = { ...level, length: 5_000_000 };
      const { waves } = buildLevel(saturated);
      for (const type of types) {
        expect(waves.some((w) => w.type === type)).toBe(true);
      }
    }
  });

  it('keeps gates and structures clear of the finish line', () => {
    // A gate taken two seconds before the level ends is a reward with nothing
    // left to spend it on.
    for (const level of CAMPAIGN) {
      const plan = buildLevel(level);
      for (const g of plan.gates) expect(g.y).toBeLessThan(level.length - 1000);
      for (const o of plan.objectives) expect(o.y).toBeLessThan(level.length - 1000);
      expect(plan.gates.length).toBeGreaterThan(1);
      expect(plan.objectives.length).toBeGreaterThan(2);
    }
  });

  it('scales enemy hp with the level difficulty', () => {
    // A level of grunts and runners has nothing to scale — both are 1 hp at
    // every difficulty — so this has to be asked of a level with brutes on it.
    const base = CAMPAIGN.find((l) => (l.mix[BRUTE] ?? 0) > 0) as LevelDef;
    const harder = { ...base, difficulty: base.difficulty * 2 };
    const peak = (l: LevelDef): number =>
      buildLevel(l).waves.reduce((m, w) => Math.max(m, w.hp), 0);
    expect(peak(harder)).toBeGreaterThan(peak(base));
  });
});

describe('finish line', () => {
  it('ends the level in a win when the squad crosses it', () => {
    const w = playOut(CAMPAIGN[0] as LevelDef);
    expect(w.state).toBe('won');
    expect(w.anchorY).toBeGreaterThanOrEqual(w.finishY);
    expect(w.count).toBeGreaterThan(0);
  });

  it('stops the world once the level is over', () => {
    const w = playOut(CAMPAIGN[0] as LevelDef);
    const at = w.cameraY;
    for (let i = 0; i < 60; i++) w.step(1 / 60);
    expect(w.cameraY).toBe(at);
  });

  it('reports progress as a fraction, and nothing at all without a finish line', () => {
    const w = new World(CAMPAIGN[0] as LevelDef, VIEW_H);
    expect(w.progress).toBeLessThan(0.2);
    playOut(CAMPAIGN[0] as LevelDef);
    expect(new World(endlessLevel(3), VIEW_H).progress).toBe(0);
  });

  it('never wins an endless level', () => {
    const w = new World(endlessLevel(7), VIEW_H);
    for (let i = 0; i < 60 * 200 && w.state === 'running'; i++) {
      competent(w);
      w.step(1 / 60);
    }
    expect(w.state).toBe('dead');
  });

  it('counts a squad wiped out on the line as a loss', () => {
    // Reaching the line with nothing left is not clearing the level. The order
    // of the two end conditions inside step() is the only thing deciding it,
    // so the squad is emptied on the very frame the line is crossed.
    const level = CAMPAIGN[0] as LevelDef;
    const w = new World(level, VIEW_H);
    // Stops one step short of the line, so the next step is guaranteed to cross
    // it — the step is exactly SCROLL_SPEED/60 world units.
    const step = SCROLL_SPEED / 60;
    while (w.state === 'running' && w.anchorY < w.finishY - step) w.step(1 / 60);
    expect(w.state).toBe('running');
    w.count = 0;
    w.step(1 / 60);
    expect(w.anchorY).toBeGreaterThan(w.finishY);
    expect(w.state).toBe('dead');
  });
});

describe('the campaign', () => {
  it('is a connected, uniquely seeded ladder', () => {
    const ids = CAMPAIGN.map((l) => l.id);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect(new Set(CAMPAIGN.map((l) => l.seed)).size).toBe(CAMPAIGN.length);
    for (const l of CAMPAIGN) expect(levelById(l.id)).toBe(l);
  });

  it('gets longer as it goes, so the last level is never the shortest', () => {
    for (let i = 1; i < CAMPAIGN.length; i++) {
      expect(CAMPAIGN[i].length).toBeGreaterThanOrEqual(CAMPAIGN[i - 1].length);
    }
  });

  it('uses every archetype and every template across the campaign', () => {
    const types = new Set<number>();
    const templates = new Set<string>();
    for (const l of CAMPAIGN) {
      templates.add(l.template);
      for (let t = 0; t < ENEMY_KINDS; t++) if ((l.mix[t as EnemyType] ?? 0) > 0) types.add(t);
    }
    expect(types.size).toBe(ENEMY_KINDS);
    expect(templates.size).toBeGreaterThanOrEqual(4);
    expect(templates.has('endless')).toBe(false);
  });

  it('gets harder: the opener is far more winnable than the finale', () => {
    // The probe measures every level against a target band; this is the one
    // assertion of that shape cheap enough to run on every commit.
    const winRate = (level: LevelDef, seeds: number): number => {
      let won = 0;
      for (let i = 0; i < seeds; i++) {
        const seeded = { ...level, seed: (level.seed + i * 2654435761) >>> 0 };
        if (playOut(seeded).state === 'won') won++;
      }
      return won / seeds;
    };
    const first = winRate(CAMPAIGN[0] as LevelDef, 10);
    const last = winRate(CAMPAIGN[CAMPAIGN.length - 1] as LevelDef, 10);
    expect(first).toBeGreaterThan(0.8);
    expect(last).toBeLessThan(first);
    // Not near-zero either: the finale is meant to be beatable, not a wall.
    expect(last).toBeGreaterThan(0.2);
  }, 60_000);

  it('is independent of the viewport: win rate is stable across viewH', () => {
    // `viewH` is the viewport's own aspect ratio in disguise (`LANE_W *
    // cssH / cssW`), so a level tuned against one device's viewH must play
    // the same on a tablet or in landscape — 960 and 2100 bracket the
    // practical range either side of the reference 1560.
    const level = CAMPAIGN[8] as LevelDef;
    const winRate = (viewH: number, seeds: number): number => {
      let won = 0;
      for (let i = 0; i < seeds; i++) {
        const seeded = { ...level, seed: (level.seed + i * 2654435761) >>> 0 };
        if (playOut(seeded, competent, viewH).state === 'won') won++;
      }
      return won / seeds;
    };
    const reference = winRate(1560, 15);
    const tablet = winRate(960, 15);
    const landscape = winRate(2100, 15);
    expect(Math.abs(tablet - reference)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(landscape - reference)).toBeLessThanOrEqual(0.15);
  }, 60_000);

  it('never saturates MAX_RED under the reference strategy', () => {
    // Spawning silently stops at MAX_RED, so a swarm that saturates it would
    // quietly flatten late-run difficulty with nothing to say so. This is the
    // regression guard for that failure mode staying invisible.
    for (const level of CAMPAIGN) {
      expect(playOut(level).droppedSpawns).toBe(0);
    }
  }, 60_000);
});

describe('progress', () => {
  it('unlocks the next level only once this one is cleared', () => {
    let p: Progress = { cleared: new Set<number>() };
    expect(isUnlocked(p, 1, 1)).toBe(true);
    expect(isUnlocked(p, 2, 1)).toBe(false);
    p = withCleared(p, 1);
    expect(isUnlocked(p, 2, 1)).toBe(true);
    expect(isUnlocked(p, 3, 1)).toBe(false);
  });

  it('never locks the player out of the first level', () => {
    const p: Progress = { cleared: new Set<number>() };
    expect(isUnlocked(p, CAMPAIGN[0]!.id, CAMPAIGN[0]!.id)).toBe(true);
  });
});
