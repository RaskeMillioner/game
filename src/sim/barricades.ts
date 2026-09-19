import {
  BarricadeSpec, barricadeToSampleRange, clearBarricadeHole,
  Corridor, CORRIDOR_STEP,
} from './corridor.js';

export interface Barricade {
  /** World y centre of the obstruction. */
  readonly y: number;
  /** Half-span in world y units. */
  readonly yHalf: number;
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
    // A barricade whose hole the corridor refused to write is a level data bug:
    // the position is too narrow to leave MIN_SPAN_HALF on either side. Fail
    // loudly at level-build time rather than fabricating coordinates that silently
    // put the barricade outside the lane.
    let hasHole = false;
    for (let i = sampleLo; i <= sampleHi && i < corridor.holeHalfWidth.length; i++) {
      if (corridor.holeHalfWidth[i] > 0) { hasHole = true; break; }
    }
    if (!hasHole) {
      throw new Error(
        `Barricade at t=${spec.at} (halfWidth=${spec.halfWidth}) produced no hole. ` +
        `The lane is too narrow there to leave MIN_SPAN_HALF on both sides.`,
      );
    }
    return {
      y: spec.at * length,
      yHalf: (spec.span / 2) * length,
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
