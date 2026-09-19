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

for (let i = 0; i < MAX_BLUE_RENDER; i++) {
  const a = i * GOLDEN;
  const r = BLUE_SPACING * Math.sqrt(i);
  slotX[i] = Math.cos(a) * r;
  slotY[i] = Math.sin(a) * r;
  slotLag[i] = 0.82 + ((i * 2654435761) % 1000) / 1000 * 0.36;
}

export function formationRadius(rendered: number): number {
  return rendered <= 1 ? BLUE_SPACING : BLUE_SPACING * Math.sqrt(rendered - 1);
}

/**
 * How hard the crowd is squeezed laterally to fit a corridor of the given
 * half-width. 1 means it already fits and nothing changes.
 *
 * The crowd compresses rather than spilling over the edge or losing whoever is
 * outside it. Killing the overhang would make squad size a liability in a
 * narrow section, which is the same argument that rules out a ranged enemy: a
 * crowd cannot dodge, so anything that punishes being big for its own sake
 * breaks the fantasy the game is built on.
 *
 * The pressure is indirect instead, and falls out of machinery that already
 * exists — a narrower crowd mans a narrower firing line, so less of the swarm
 * is covered.
 */
export function formationSqueeze(rendered: number, halfWidth: number): number {
  const r = formationRadius(rendered);
  if (r <= 0) return 1;
  // Room for the outermost unit's own body, not just its centre.
  const usable = halfWidth - BLUE_SPACING;
  if (usable >= r) return 1;
  return Math.max(MIN_SQUEEZE, usable / r);
}

/**
 * Floor on the squeeze. Past this the crowd is a line rather than a disc, and
 * the firing model — one emitter per lateral column — stops having columns to
 * work with.
 */
export const MIN_SQUEEZE = 0.38;
