import type { BoundaryCondition, BoundaryHistory, BoundaryType } from './types.ts';
import { fail } from './errors.ts';

export function validateCondition(raw: unknown): BoundaryCondition {
  if (typeof raw !== 'object' || raw === null) {
    fail('VALIDATION', 'boundary condition must be an object');
  }
  const bc = raw as Partial<BoundaryCondition>;
  const type = bc.type as BoundaryType;
  if (type === 'temperature') {
    if (typeof bc.value !== 'number' || !Number.isFinite(bc.value)) {
      fail('VALIDATION', 'temperature boundary requires finite value', bc);
    }
    return { type, value: bc.value };
  }
  if (type === 'adiabatic') return { type };
  if (type === 'convection') {
    if (typeof bc.fluidTemperature !== 'number' || !Number.isFinite(bc.fluidTemperature)) {
      fail('VALIDATION', 'convection requires finite fluidTemperature', bc);
    }
    if (typeof bc.htc !== 'number' || !(bc.htc > 0) || !Number.isFinite(bc.htc)) {
      fail('NON_POSITIVE_PROPERTY', 'convection htc must be positive finite', bc);
    }
    return { type, fluidTemperature: bc.fluidTemperature, htc: bc.htc };
  }
  fail('VALIDATION', `unknown boundary type: ${String(type)}`);
}

/** Build a single-segment constant history valid from t=0. */
export function constantHistory(condition: BoundaryCondition): BoundaryHistory {
  return { segments: [{ start: 0, end: Infinity, condition }] };
}

/**
 * Validate a piecewise-constant boundary history. Segments must be ordered,
 * contiguous, non-overlapping and cover [0, Infinity). Step times are the
 * finite segment boundaries.
 */
export function validateHistory(raw: unknown): BoundaryHistory {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as BoundaryHistory).segments)) {
    fail('VALIDATION', 'boundary history must contain a segments array');
  }
  const segments = (raw as BoundaryHistory).segments;
  if (segments.length === 0) fail('VALIDATION', 'boundary history must have at least one segment');
  let expectedStart = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s.start !== 'number' || !Number.isFinite(s.start) || s.start < 0) {
      fail('ILLEGAL_TIME', 'segment start must be finite and >= 0', s);
    }
    if (!(s.end > s.start) || (s.end !== Infinity && !Number.isFinite(s.end))) {
      fail('ILLEGAL_TIME', 'segment end must be > start and finite or Infinity', s);
    }
    if (Math.abs(s.start - expectedStart) > 1e-12) {
      fail('ILLEGAL_TIME', 'segments must be contiguous and ordered with no gaps', {
        index: i,
        expectedStart,
        got: s.start,
      });
    }
    s.condition = validateCondition(s.condition);
    expectedStart = s.end;
  }
  if (segments[segments.length - 1].end !== Infinity) {
    fail('ILLEGAL_TIME', 'final boundary segment must extend to Infinity');
  }
  return { segments };
}

export function conditionAt(history: BoundaryHistory, t: number): BoundaryCondition {
  for (const s of history.segments) {
    if (t >= s.start && t < s.end) return s.condition;
  }
  return history.segments[history.segments.length - 1].condition;
}

/** Finite step times strictly inside (time, targetTime]. */
export function breakpointsBetween(history: BoundaryHistory, time: number, target: number): number[] {
  const out: number[] = [];
  for (const s of history.segments) {
    if (Number.isFinite(s.start) && s.start > time + 1e-12 && s.start <= target + 1e-12) {
      out.push(s.start);
    }
  }
  return out.sort((a, b) => a - b);
}

export function sameCondition(a: BoundaryCondition, b: BoundaryCondition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
