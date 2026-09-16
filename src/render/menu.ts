import type { LevelDef } from '../sim/levels.js';

/**
 * Level-select geometry. Layout and hit-testing come from this one function so
 * a tile can never be drawn somewhere the tap does not land — the bug you only
 * find on a phone you do not own.
 *
 * All values are in device pixels, matching the canvas backing store.
 */

export interface Tile {
  readonly level: LevelDef;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly unlocked: boolean;
  readonly cleared: boolean;
}

export interface MenuLayout {
  readonly tiles: readonly Tile[];
  /** Header baseline, so the title and the grid cannot drift apart. */
  readonly titleY: number;
}

const COLS = 3;

export function layoutMenu(
  levels: readonly LevelDef[],
  width: number,
  height: number,
  isUnlocked: (level: LevelDef) => boolean,
  isCleared: (level: LevelDef) => boolean,
): MenuLayout {
  const pad = width * 0.06;
  const gap = width * 0.035;
  const titleY = height * 0.10;
  const headerBottom = height * 0.20;
  const tileW = (width - pad * 2 - gap * (COLS - 1)) / COLS;
  const rows = Math.ceil(levels.length / COLS);
  // The grid shrinks to fit rather than scrolling: a campaign is a page, and a
  // scroll surface on top of a drag-to-steer canvas fights the same gesture.
  const available = height * 0.94 - headerBottom;
  const tileH = Math.min(tileW * 0.82, (available - gap * (rows - 1)) / rows);
  // Centred in what is left rather than pinned under the header: on a tall
  // phone the tiles cap out at their square-ish aspect, and pinning them to the
  // top leaves a third of the screen empty below the last row.
  const gridH = rows * tileH + gap * (rows - 1);
  const top = headerBottom + Math.max(0, (available - gridH) / 2);

  const tiles: Tile[] = [];
  levels.forEach((level, i) => {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    tiles.push({
      level,
      x: pad + col * (tileW + gap),
      y: top + row * (tileH + gap),
      w: tileW,
      h: tileH,
      unlocked: isUnlocked(level),
      cleared: isCleared(level),
    });
  });
  return { tiles, titleY };
}

export function tileAt(layout: MenuLayout, x: number, y: number): Tile | null {
  for (const t of layout.tiles) {
    if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
  }
  return null;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** "MENU" pill on the end-of-run overlays. Sized for a thumb, not a cursor. */
export function menuButton(width: number, height: number): Rect {
  const w = width * 0.30;
  const h = height * 0.075;
  return { x: (width - w) / 2, y: height * 0.80, w, h };
}

export function hitRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
