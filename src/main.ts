import { createLoop } from './core/loop.js';
import {
  isUnlocked, loadProgress, Progress, saveProgress, withCleared,
} from './app/progress.js';
import { tileAt, type MenuLayout } from './render/menu.js';
import { Renderer } from './render/renderer.js';
import { CAMPAIGN } from './sim/campaign.js';
import { DRAG_GAIN, LANE_W } from './sim/config.js';
import type { LevelDef } from './sim/levels.js';
import { World } from './sim/world.js';

const element = document.getElementById('game');
if (!(element instanceof HTMLCanvasElement)) throw new Error('#game canvas missing');
// Bound to its own typed const: narrowing does not survive into the hoisted
// helpers below, and the pointer maths needs the backing-store dimensions.
const canvas: HTMLCanvasElement = element;

const FIRST_LEVEL = CAMPAIGN[0] as LevelDef;

const renderer = new Renderer(canvas);
let viewH = renderer.resize();

/**
 * Two screens: the level select and a level in progress. Win and loss are
 * states of the running world rather than screens of their own, so the overlay
 * always sits on top of the moment it is describing.
 */
let screen: 'menu' | 'playing' = 'menu';
let progress: Progress = loadProgress();
let level: LevelDef = FIRST_LEVEL;
let world = new World(level, viewH);
let menu: MenuLayout = buildMenu();
/** Set when a level fails to build, so the menu can say so instead of the screen just going blank. */
let buildError: string | null = null;

function buildMenu(): MenuLayout {
  return renderer.menuLayout(
    CAMPAIGN,
    (l) => isUnlocked(progress, l.id, FIRST_LEVEL.id),
    (l) => progress.cleared.has(l.id),
  );
}

/**
 * A malformed level definition (a barricade whose hole the corridor refused
 * to write, say) throws at construction. That is the right call for a data
 * bug, but the whole app running from this one module-level `new World` call
 * means an uncaught throw here would otherwise take the game down to a blank
 * canvas with nothing but a console error to explain it.
 */
function play(next: LevelDef): void {
  let w: World;
  try {
    w = new World(next, viewH);
  } catch (err) {
    console.error(`Failed to build level ${next.id} (${next.name})`, err);
    buildError = `Couldn't load ${next.name} — pick another level.`;
    toMenu();
    return;
  }
  buildError = null;
  level = next;
  world = w;
  screen = 'playing';
}

function toMenu(): void {
  menu = buildMenu();
  screen = 'menu';
}

/** The level after this one, or nothing if the campaign is finished. */
function nextLevel(): LevelDef | undefined {
  return CAMPAIGN[CAMPAIGN.findIndex((l) => l.id === level.id) + 1];
}

// Dev-only inspection hook. Reaching the distance where brutes and exploders
// appear takes a minute of competent play, which makes verifying how they draw
// impractical otherwise. Stripped from production builds by dead-code removal.
if (import.meta.env.DEV) {
  const hooks = window as unknown as { __world: () => World; __menu: () => MenuLayout };
  hooks.__world = () => world;
  // The level select is canvas-drawn, so there is no element to click in a
  // browser test. Exposing the layout lets one tap a tile by its real rect
  // rather than by a copy of the layout maths that can drift out of step.
  hooks.__menu = () => menu;
}

function onResize(): void {
  viewH = renderer.resize();
  world.resize(viewH);
  menu = buildMenu();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// Relative drag: the finger nudges the formation rather than teleporting it to
// the touch point, so your thumb never has to sit on top of what you're watching.
let dragging = false;
let dragStartX = 0;
let dragStartTarget = 0;

const virtualPerCss = (): number => LANE_W / renderer.cssW;

/** CSS pointer coordinates into the canvas backing store the layouts are in. */
function devicePoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = devicePoint(e);

  if (screen === 'menu') {
    const tile = tileAt(menu, p.x, p.y);
    if (tile && tile.unlocked) play(tile.level);
    return;
  }

  if (world.state === 'won') {
    if (renderer.menuButtonHit(p.x, p.y)) {
      toMenu();
      return;
    }
    const next = nextLevel();
    // Clearing the last level has nowhere to advance to, so it lands back on
    // the select screen rather than silently replaying the same level.
    if (next) play(next);
    else toMenu();
    return;
  }

  if (world.state === 'dead') {
    if (renderer.menuButtonHit(p.x, p.y)) toMenu();
    else play(level);
    return;
  }

  dragging = true;
  dragStartX = e.clientX;
  dragStartTarget = world.targetX;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  world.targetX = dragStartTarget + (e.clientX - dragStartX) * virtualPerCss() * DRAG_GAIN;
});

const endDrag = (): void => {
  dragging = false;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Desktop testing only.
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' && screen === 'playing') play(level);
  if (e.key === 'Escape') toMenu();
  keys.add(e.key);
});
window.addEventListener('keyup', (e) => keys.delete(e.key));

let fps = 60;
let lastFrame = performance.now();

createLoop(
  (dt) => {
    if (screen !== 'playing') return;
    const before = world.state;
    if (keys.has('ArrowLeft')) world.targetX -= 520 * dt;
    if (keys.has('ArrowRight')) world.targetX += 520 * dt;
    world.step(dt);
    if (before === 'running' && world.state === 'won') {
      progress = withCleared(progress, level.id);
      saveProgress(progress);
    }
  },
  () => {
    const now = performance.now();
    const delta = now - lastFrame;
    lastFrame = now;
    if (delta > 0) fps += (1000 / delta - fps) * 0.08;
    if (screen === 'menu') renderer.drawMenu(menu, buildError);
    else renderer.draw(world, fps);
  },
);
