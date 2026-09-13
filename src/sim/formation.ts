import { BLUE_SPACING, MAX_BLUE_RENDER } from './config.js';

/**
 * Phyllotaxis packing: slot i sits at angle i*golden, radius spacing*sqrt(i).
 * Gives an evenly dense round crowd at any count, with no gaps or rings.
 */
const GOLDEN = 2.399963229728653;

export const slotX = new Float32Array(MAX_BLUE_RENDER);
export const slotY = new Float32Array(MAX_BLUE_RENDER);
/** Per-slot follow jitter so the crowd flows instead of moving as one rigid body. */
export const slotLag = new Float32Array(MAX_BLUE_RENDER);
/** Slot indices ordered front-to-back — the front ranks are the ones that fire. */
export const frontOrder = new Int32Array(MAX_BLUE_RENDER);

for (let i = 0; i < MAX_BLUE_RENDER; i++) {
  const a = i * GOLDEN;
  const r = BLUE_SPACING * Math.sqrt(i);
  slotX[i] = Math.cos(a) * r;
  slotY[i] = Math.sin(a) * r;
  slotLag[i] = 0.82 + ((i * 2654435761) % 1000) / 1000 * 0.36;
}

{
  const order = Array.from({ length: MAX_BLUE_RENDER }, (_, i) => i);
  order.sort((a, b) => slotY[b] - slotY[a]);
  frontOrder.set(order);
}

export function formationRadius(rendered: number): number {
  return rendered <= 1 ? BLUE_SPACING : BLUE_SPACING * Math.sqrt(rendered - 1);
}
