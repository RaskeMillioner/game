/**
 * Fixed-timestep simulation decoupled from render rate. Capped catch-up so a
 * GC pause or a backgrounded tab never spirals into a death loop.
 */
export const STEP = 1 / 60;
const MAX_STEPS = 3;

export function createLoop(step: (dt: number) => void, draw: (alpha: number) => void): () => void {
  let last = performance.now() / 1000;
  let acc = 0;
  let raf = 0;

  const frame = (nowMs: number): void => {
    raf = requestAnimationFrame(frame);
    const now = nowMs / 1000;
    let elapsed = now - last;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25;
    acc += elapsed;

    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      step(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0;

    draw(acc / STEP);
  };

  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
