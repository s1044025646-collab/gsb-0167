import { bcAt, boundaryFlux, boundaryTerm, eventTimes } from './boundary.js';
import { capacitance } from './grid.js';
import { tdmaSolve } from './tdma.js';
import type {
  BoundaryHistory,
  EnergyLedger,
  Grid,
  SolveResult,
  SolverOptions,
  StepRecord,
} from './types.js';
import { AppError } from './errors.js';

const EVENT_TOL = 1e-10;

export interface StepOutcome {
  T: number[];
  qL: number;
  qR: number;
}

/**
 * One backward-Euler step. Flux q is positive INTO the wall at each face.
 * Internal conductances are series-combined half-cell resistances; boundary
 * faces use the explicit half-cell distance dx/2 (see boundary.ts).
 */
export function implicitStep(
  grid: Grid,
  Told: number[],
  dt: number,
  bcL: BoundaryHistory['segments'][number]['bc'],
  bcR: BoundaryHistory['segments'][number]['bc'],
): StepOutcome {
  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new AppError('ILLEGAL_TIME', `step dt must be finite and > 0, got ${dt}`);
  }
  for (let i = 0; i < Told.length; i++) {
    if (!Number.isFinite(Told[i])) {
      throw new AppError('SOLVER_NON_FINITE', `non-finite starting temperature at cell ${i}`);
    }
  }
  const n = grid.n;
  const a = new Array<number>(n).fill(0);
  const b = new Array<number>(n).fill(0);
  const c = new Array<number>(n).fill(0);
  const d = new Array<number>(n).fill(0);

  const gFace = new Array<number>(n - 1);
  for (const f of grid.faces) gFace[f.index - 1] = f.g;

  for (let i = 0; i < n; i++) {
    const cell = grid.cells[i];
    const Cdt = capacitance(cell) / dt;
    b[i] = Cdt;
    d[i] = Cdt * Told[i];
  }

  for (let i = 0; i < n - 1; i++) {
    const g = gFace[i];
    // flux from neighbor into cell: g*(T_neighbor - T_i)
    b[i] += g;
    c[i] -= g;
    b[i + 1] += g;
    a[i + 1] -= g;
  }

  const left = grid.cells[0];
  const right = grid.cells[n - 1];
  const termL = boundaryTerm(bcL, left.k, left.dx);
  const termR = boundaryTerm(bcR, right.k, right.dx);
  // q_in = qb - gb * T_cell added to the RHS-equation: ... + qb - gb*T0 = 0
  b[0] += termL.gb;
  d[0] += termL.qb;
  b[n - 1] += termR.gb;
  d[n - 1] += termR.qb;

  let T: number[];
  try {
    T = tdmaSolve(a, b, c, d);
  } catch (e) {
    throw new AppError(
      'SOLVER_NON_FINITE',
      `linear solve produced an invalid result: ${(e as Error).message}`,
    );
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(T[i])) {
      throw new AppError('SOLVER_NON_FINITE', `non-finite temperature at cell ${i}`);
    }
  }

  const qL = boundaryFlux(bcL, T[0], left.k, left.dx);
  const qR = boundaryFlux(bcR, T[n - 1], right.k, right.dx);
  if (![qL, qR].every(Number.isFinite)) {
    throw new AppError('SOLVER_NON_FINITE', 'non-finite boundary flux');
  }
  return { T, qL, qR };
}

/** Internal energy per unit area, U = sum rho cp dx T (relative scale). */
export function internalEnergy(grid: Grid, T: number[]): number {
  let u = 0;
  for (let i = 0; i < grid.n; i++) u += capacitance(grid.cells[i]) * T[i];
  return u;
}

export interface RunState {
  t: number;
  step: number;
  T: number[];
  ledger: EnergyLedger;
  qLprev: number;
  qRprev: number;
  U0: number;
}

export function initRun(grid: Grid, T0: number[]): RunState {
  const segL = { bc: undefined as never };
  void segL;
  return {
    t: 0,
    step: 0,
    T: T0.slice(),
    ledger: { QL: 0, QR: 0, dU: 0, residual: 0 },
    qLprev: 0,
    qRprev: 0,
    U0: internalEnergy(grid, T0),
  };
}

export interface AdvanceParams {
  grid: Grid;
  histL: BoundaryHistory;
  histR: BoundaryHistory;
  dt: number;
  tEnd: number;
  maxSteps?: number;
  snapshotEvery: number;
  state: RunState;
  /** Seed flag: first step has no previous flux for trapezoidal energy. */
  firstFluxL?: number;
  firstFluxR?: number;
}

/**
 * Advance a run with automatic step splitting at boundary change times.
 * Energy entering each face during a step uses the trapezoidal rule on the
 * end-of-step fluxes (fixed quadrature definition documented in README).
 */
export function advance(params: AdvanceParams): SolveResult {
  const { grid, histL, histR, dt, tEnd, state } = params;
  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new AppError('ILLEGAL_TIME', 'dt must be finite and > 0');
  }
  if (!(tEnd > state.t) || !Number.isFinite(tEnd)) {
    throw new AppError('ILLEGAL_TIME', `tEnd (${tEnd}) must be > current t (${state.t})`);
  }
  const snapshotEvery = Math.max(1, Math.floor(params.snapshotEvery || 1));
  const events = [...new Set([...eventTimes(histL), ...eventTimes(histR)])]
    .filter((e) => e > state.t + EVENT_TOL && e < tEnd - EVENT_TOL)
    .sort((x, y) => x - y);

  const records: StepRecord[] = [];
  let steps = 0;
  let T = state.T;
  let qLprev = state.qLprev;
  let qRprev = state.qRprev;
  let needInitialFlux = state.step === 0;
  const consumed = new Set<number>();

  while (state.t < tEnd - EVENT_TOL) {
    if (params.maxSteps !== undefined && steps >= params.maxSteps) break;

    let remaining = tEnd - state.t;
    let stepDt = Math.min(dt, remaining);
    // Split exactly at the next boundary event inside (t, t + stepDt].
    const nextEvent = events.find((e) => e > state.t + EVENT_TOL && !consumed.has(e));
    let splitEvent = false;
    if (nextEvent !== undefined && nextEvent < state.t + stepDt - EVENT_TOL) {
      stepDt = nextEvent - state.t;
      splitEvent = true;
    }
    if (stepDt <= 0) throw new AppError('ILLEGAL_TIME', 'non-positive effective step');

    // A step that lands exactly on an event uses the OLD condition (the new
    // condition applies strictly after that instant); the FOLLOWING step uses
    // the new one. This keeps a pre-event pause state unchanged.
    const tNew = state.t + stepDt;
    const landsOnEvent = events.some((e) => Math.abs(e - tNew) < EVENT_TOL);
    const bcEvalT = landsOnEvent ? tNew - EVENT_TOL * 10 : tNew;
    const bcL = bcAt(histL, bcEvalT).bc;
    const bcR = bcAt(histR, bcEvalT).bc;
    if (landsOnEvent) events.forEach((e) => { if (Math.abs(e - tNew) < EVENT_TOL) consumed.add(e); });

    if (needInitialFlux) {
      const bcL0 = bcAt(histL, state.t).bc;
      const bcR0 = bcAt(histR, state.t).bc;
      const c0 = grid.cells[0];
      const cn = grid.cells[grid.n - 1];
      qLprev = boundaryFlux(bcL0, T[0], c0.k, c0.dx);
      qRprev = boundaryFlux(bcR0, T[grid.n - 1], cn.k, cn.dx);
      needInitialFlux = false;
    }

    const out = implicitStep(grid, T, stepDt, bcL, bcR);
    // Fixed quadrature: backward-Euler (right-endpoint) face energy.
    // This is the unique rule that balances EXACTLY against the cell energy
    // update of the implicit FVM equations: summing rows gives
    // dU = dt * (qL_into + qR_into) at the new time.
    const eL = out.qL * stepDt;
    const eR = out.qR * stepDt;
    const dU = internalEnergy(grid, out.T) - internalEnergy(grid, T);

    state.t = tNew;
    state.step += 1;
    steps += 1;
    T = out.T;
    qLprev = out.qL;
    qRprev = out.qR;
    state.T = T;
    state.ledger = {
      QL: state.ledger.QL + eL,
      QR: state.ledger.QR + eR,
      dU: state.ledger.dU + dU,
      residual: state.ledger.QL + eL + state.ledger.QR + eR - (state.ledger.dU + dU),
    };
    state.qLprev = qLprev;
    state.qRprev = qRprev;

    const rec: StepRecord = {
      step: state.step,
      t: state.t,
      dt: stepDt,
      T: T.slice(),
      qL: out.qL,
      qR: out.qR,
      eL,
      eR,
      dU,
      ledger: { ...state.ledger },
      snapshot: state.step % snapshotEvery === 0,
    };
    records.push(rec);
  }

  return {
    t: state.t,
    steps: records,
    T: T.slice(),
    ledger: { ...state.ledger },
    events,
    finished: state.t >= tEnd - EVENT_TOL,
  };
}
