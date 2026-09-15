import { Rng } from '../core/rng.js';

/**
 * Spawn director. Owns pacing only — it decides how much red arrives and when,
 * never where the reds go. Difficulty ramps with distance travelled, not time,
 * so a player who survives longer does not get an easier ride.
 */
export class Director {
  private acc = 0;

  /**
   * Reds per second at the current point in the run. The opening is deliberately
   * thin: the first gate is ~6s in, and a 10-strong squad with a pistol has to
   * live long enough to reach it. Power fantasy first, brutality later.
   */
  rate(distance: number): number {
    const d = distance / 1000;
    return 1.15 + d * 2.95 + d * d * 0.55;
  }

  /** Returns how many reds to spawn this step. */
  step(dt: number, distance: number, rng: Rng): number {
    this.acc += this.rate(distance) * dt;
    if (this.acc < 1) return 0;
    // Bias toward clumps: a wall of red reads better than an even drizzle.
    const n = Math.floor(this.acc);
    this.acc -= n;
    return rng.next() < 0.25 ? n * 2 : n;
  }

  reset(): void {
    this.acc = 0;
  }
}
