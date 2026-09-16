import { describe, expect, it } from 'vitest';
import { isUnlocked, Progress, withCleared } from '../app/progress.js';
import { CAMPAIGN, levelById } from './campaign.js';
import { SCROLL_SPEED } from './config.js';
import { BRUTE, ENEMY_KINDS, EnemyType } from './enemies.js';
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
function playOut(level: LevelDef, drive = competent): World {
  const w = new World(level, VIEW_H);
  const budget = Math.ceil(((level.length / SCROLL_SPEED) * 1.35 + 10) * 60);
  for (let i = 0; i < budget && w.state === 'running'; i++) {
    drive(w);
    w.step(1 / 60);
  }
  return w;
}

describe('level generation', () => {
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
