import { createLoop } from './core/loop.js';
import { Renderer } from './render/renderer.js';
import { DRAG_GAIN, LANE_W } from './sim/config.js';
import { World } from './sim/world.js';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#game canvas missing');

const renderer = new Renderer(canvas);
let viewH = renderer.resize();
let world = new World((Math.random() * 0xffffffff) >>> 0, viewH);

function restart(): void {
  world = new World((Math.random() * 0xffffffff) >>> 0, viewH);
}

window.addEventListener('resize', () => {
  viewH = renderer.resize();
  world.resize(viewH);
});
window.addEventListener('orientationchange', () => {
  viewH = renderer.resize();
  world.resize(viewH);
});

// Relative drag: the finger nudges the formation rather than teleporting it to
// the touch point, so your thumb never has to sit on top of what you're watching.
let dragging = false;
let dragStartX = 0;
let dragStartTarget = 0;

const virtualPerCss = (): number => LANE_W / renderer.cssW;

canvas.addEventListener('pointerdown', (e) => {
  if (world.state === 'dead') {
    restart();
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
  if (e.key === 'r') restart();
  keys.add(e.key);
});
window.addEventListener('keyup', (e) => keys.delete(e.key));

let fps = 60;
let lastFrame = performance.now();

createLoop(
  (dt) => {
    if (keys.has('ArrowLeft')) world.targetX -= 520 * dt;
    if (keys.has('ArrowRight')) world.targetX += 520 * dt;
    world.step(dt);
  },
  () => {
    const now = performance.now();
    const delta = now - lastFrame;
    lastFrame = now;
    if (delta > 0) fps += (1000 / delta - fps) * 0.08;
    renderer.draw(world, fps);
  },
);
