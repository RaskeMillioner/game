/**
 * Campaign progress. The only thing that survives a run, and deliberately the
 * only thing: there are no persistent upgrades, so every level is balanced
 * against one known starting state — 16 blue and a pistol — and a level's
 * difficulty means the same thing on a fresh install as on a finished save.
 */

const KEY = 'redtide.progress.v1';

export interface Progress {
  readonly cleared: ReadonlySet<number>;
}

export const EMPTY_PROGRESS: Progress = { cleared: new Set() };

/**
 * Private browsing and disabled storage both throw on access rather than
 * returning null, so every read and write is guarded. Losing progress is a
 * nuisance; refusing to start the game over it is not acceptable.
 */
export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_PROGRESS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_PROGRESS;
    const ids = (parsed as { cleared?: unknown }).cleared;
    if (!Array.isArray(ids)) return EMPTY_PROGRESS;
    return { cleared: new Set(ids.filter((n): n is number => typeof n === 'number')) };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cleared: [...progress.cleared] }));
  } catch {
    // Storage is a convenience here, never a dependency.
  }
}

export function withCleared(progress: Progress, id: number): Progress {
  const cleared = new Set(progress.cleared);
  cleared.add(id);
  return { cleared };
}

/** A level is playable once the one before it is cleared. The first always is. */
export function isUnlocked(progress: Progress, id: number, firstId: number): boolean {
  return id === firstId || progress.cleared.has(id - 1);
}
