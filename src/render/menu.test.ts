import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../sim/campaign.js';
import { hitRect, layoutMenu, menuButton, tileAt } from './menu.js';

const W = 1170;
const H = 2532;

const layout = (cleared: ReadonlySet<number> = new Set()) =>
  layoutMenu(
    CAMPAIGN,
    W,
    H,
    (l) => l.id === CAMPAIGN[0]!.id || cleared.has(l.id - 1),
    (l) => cleared.has(l.id),
  );

describe('level select layout', () => {
  it('hit-tests each tile at its own centre', () => {
    // The bug this exists to catch is a tile drawn somewhere the tap does not
    // land, which you only ever find on a phone you do not own.
    const l = layout();
    for (const tile of l.tiles) {
      expect(tileAt(l, tile.x + tile.w / 2, tile.y + tile.h / 2)).toBe(tile);
    }
  });

  it('keeps every tile on screen and clear of its neighbours', () => {
    const l = layout();
    expect(l.tiles.length).toBe(CAMPAIGN.length);
    for (const tile of l.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThan(l.titleY);
      expect(tile.x + tile.w).toBeLessThanOrEqual(W);
      expect(tile.y + tile.h).toBeLessThanOrEqual(H);
    }
    for (const a of l.tiles) {
      for (const b of l.tiles) {
        if (a === b) continue;
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w
          && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('misses between tiles rather than guessing at the nearest', () => {
    const l = layout();
    expect(tileAt(l, W / 2, l.titleY)).toBe(null);
  });

  it('opens exactly one level until the first is cleared', () => {
    expect(layout().tiles.filter((t) => t.unlocked).length).toBe(1);
    const after = layout(new Set([1]));
    expect(after.tiles.filter((t) => t.unlocked).length).toBe(2);
    expect(after.tiles.filter((t) => t.cleared).length).toBe(1);
  });

  it('lays out at any aspect ratio the phone can be held at', () => {
    for (const [w, h] of [[1170, 2532], [2532, 1170], [828, 1792], [1536, 2048]]) {
      const l = layoutMenu(CAMPAIGN, w!, h!, () => true, () => false);
      for (const tile of l.tiles) {
        expect(tile.w).toBeGreaterThan(0);
        expect(tile.h).toBeGreaterThan(0);
        expect(tile.y + tile.h).toBeLessThanOrEqual(h!);
      }
    }
  });
});

describe('overlay menu button', () => {
  it('tests against the rect it is drawn from', () => {
    const r = menuButton(W, H);
    expect(hitRect(r, r.x + r.w / 2, r.y + r.h / 2)).toBe(true);
    expect(hitRect(r, r.x - 1, r.y + r.h / 2)).toBe(false);
    // Sits clear of the centre, where the tap means "retry" or "continue".
    expect(r.y).toBeGreaterThan(H / 2);
  });
});
