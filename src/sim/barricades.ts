import {
  BarricadeSpec, barricadeToSampleRange, clearBarricadeHole,
  Corridor, CORRIDOR_STEP,
} from './corridor.js';

export interface Barricade {
  /** World y centre of the obstruction. */
  readonly y: number;
  /** Half-span in world y units. */
  readonly yHalf: number;
  /** x centre of the wall at its widest point, for display and hit testing. */
  readonly holeCentre: number;
  /** x half-width at the widest point. */
  readonly holeHalfWidth: number;
  /** First corridor sample index this barricade covers. */
  readonly sampleLo: number;
  /** Last corridor sample index this barricade covers. */
  readonly sampleHi: number;
  readonly maxHp: number;
  hp: number;
  broken: boolean;
  /** Decays from 1 on the frame it breaks, for the renderer's flash. */
  flash: number;
}

export function buildBarricades(
  specs: readonly BarricadeSpec[],
  corridor: Corridor,
  length: number,
): Barricade[] {
  return specs.map((spec) => {
    const [sampleLo, sampleHi] = barricadeToSampleRange(spec, length, CORRIDOR_STEP);
    // Find the sample with the largest hole — that is the peak of the barricade.
    let peakHw = 0;
    let peakHc = 0;
    for (let i = sampleLo; i <= sampleHi && i < corridor.holeHalfWidth.length; i++) {
      if (corridor.holeHalfWidth[i] > peakHw) {
        peakHw = corridor.holeHalfWidth[i];
        peakHc = corridor.holeCentre[i];
      }
    }
    if (peakHw === 0) {
      // Spec produced no hole (too narrow for MIN_SPAN_HALF constraints); fall
      // back to the spec's own values so the barricade at least exists visually.
      peakHw = spec.halfWidth;
      peakHc = spec.at * length;
    }
    return {
      y: spec.at * length,
      yHalf: (spec.span / 2) * length,
      holeCentre: peakHc,
      holeHalfWidth: peakHw,
      sampleLo,
      sampleHi,
      maxHp: spec.hp,
      hp: spec.hp,
      broken: false,
      flash: 0,
    };
  });
}

export function damageBarricade(b: Barricade, corridor: Corridor, amount: number): void {
  if (b.broken) return;
  b.hp -= amount;
  if (b.hp <= 0) {
    b.hp = 0;
    b.broken = true;
    b.flash = 1;
    clearBarricadeHole(corridor, b.sampleLo, b.sampleHi);
  }
}
