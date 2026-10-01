import type {
  BCConvection,
  BoundaryCondition,
  BoundaryHistory,
  BCSegment,
  Side,
} from './types.js';
import { AppError, fail } from './errors.js';
import { isFiniteNumber } from './grid.js';

export function validateBC(bc: BoundaryCondition, where: string): void {
  if (!bc || typeof bc.kind !== 'string') {
    throw new AppError('BAD_BOUNDARY', `${where}: boundary condition must have a kind`);
  }
  switch (bc.kind) {
    case 'temperature':
      if (!isFiniteNumber(bc.T)) {
        throw new AppError('BAD_BOUNDARY', `${where}: prescribed T must be finite`);
      }
      break;
    case 'insulated':
      break;
    case 'convection':
      if (!isFiniteNumber(bc.h) || bc.h <= 0) {
        throw new AppError(
          'NON_POSITIVE_PROPERTY',
          `${where}: convection coefficient h must be > 0`,
        );
      }
      if (!isFiniteNumber(bc.Tinf)) {
        throw new AppError('BAD_BOUNDARY', `${where}: fluid Tinf must be finite`);
      }
      break;
    default:
      throw new AppError('BAD_BOUNDARY', `${where}: unknown boundary kind ${(bc as { kind: string }).kind}`);
  }
}

/**
 * Canonicalize a user supplied list of change events into a contiguous,
 * half-open segment schedule covering [0, Infinity).
 *
 * events: [{ t, bc }, ...] with the first entry at t = 0.
 */
export function buildHistory(side: Side, events: { t: number; bc: BoundaryCondition }[]): BoundaryHistory {
  if (!Array.isArray(events) || events.length === 0) {
    throw new AppError('BAD_BOUNDARY', `side ${side}: at least one boundary event at t=0 is required`);
  }
  const sorted = [...events].sort((a, b) => a.t - b.t);
  if (!isFiniteNumber(sorted[0].t) || sorted[0].t !== 0) {
    throw new AppError('BAD_BOUNDARY', `side ${side}: first boundary event must be at t=0`);
  }
  for (const e of sorted) {
    if (!isFiniteNumber(e.t) || e.t < 0) {
      throw new AppError('ILLEGAL_TIME', `side ${side}: event time must be finite and >= 0`);
    }
    validateBC(e.bc, `side ${side} t=${e.t}`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t === sorted[i - 1].t) {
      throw new AppError('BAD_BOUNDARY', `side ${side}: duplicate boundary event at t=${sorted[i].t}`);
    }
  }

  const segments: BCSegment[] = sorted.map((e, i) => ({
    t0: e.t,
    t1: i + 1 < sorted.length ? sorted[i + 1].t : Infinity,
    bc: e.bc,
  }));
  return { side, segments };
}

/** Half-open lookup: segment active at time t (a change at t uses the new BC). */
export function bcAt(h: BoundaryHistory, t: number): BCSegment {
  for (const s of h.segments) {
    if (t >= s.t0 && t < s.t1) return s;
  }
  return h.segments[h.segments.length - 1] ?? fail('BAD_BOUNDARY', 'empty boundary history');
}

/** Finite change times (step-split points); t=0 is not an event mid-run. */
export function eventTimes(h: BoundaryHistory): number[] {
  return h.segments.map((s) => s.t0).filter((t) => t > 0 && Number.isFinite(t));
}

/**
 * Linear boundary contribution at end-of-step.
 * Flux INTO the wall at the face:
 *   temperature : qIn = (2k/dx)(T_b - T0)            (half-cell resistance)
 *   insulated   : qIn = 0
 *   convection  : qIn = h (Tinf - T_face), T_face approximated as the
 *                linear-extrapolated face value from the end-of-step T,
 *                i.e. T_face = T0 + (dT/dx)_cell * dx/2, giving the
 *                standard half-control-volume implicit Robin term.
 *
 * Returns { gb, qb } with qIn = qb - gb * T_boundaryCell.
 */
export function boundaryTerm(
  bc: BoundaryCondition,
  k: number,
  dx: number,
): { gb: number; qb: number } {
  switch (bc.kind) {
    case 'temperature': {
      const gb = (2 * k) / dx;
      return { gb, qb: gb * bc.T };
    }
    case 'insulated':
      return { gb: 0, qb: 0 };
    case 'convection': {
      // Face at distance dx/2 from the cell center.
      // T_face = Tc + grad*(dx/2); using the standard half-cell resistance
      // r = dx/(2k), the Robin condition h (Tinf - Tf) = (Tc - Tf)/r gives
      // Tf = (kf*Tc + h*Tinf)/(kf + h) with kf = 2k/dx, hence:
      const kf = (2 * k) / dx;
      const gb = (h(bc) * kf) / (h(bc) + kf);
      const qb = gb * bc.Tinf;
      return { gb, qb };
    }
  }
}

function h(bc: BCConvection): number {
  return bc.h;
}

/** Face flux INTO the wall from an already-solved boundary cell temperature. */
export function boundaryFlux(bc: BoundaryCondition, Tcell: number, k: number, dx: number): number {
  const { gb, qb } = boundaryTerm(bc, k, dx);
  return qb - gb * Tcell;
}
