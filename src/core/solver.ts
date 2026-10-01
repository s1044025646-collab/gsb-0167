import type {
  BoundaryCondition,
  BoundaryHistory,
  InternalFlux,
  LayerInput,
  StepResult,
} from './types.ts';
import { boundaryConductance, buildMesh, validateLayers } from './mesh.ts';
import { breakpointsBetween, conditionAt, validateHistory } from './boundary.ts';
import { fail } from './errors.ts';

export interface SolverState {
  layers: LayerInput[];
  mesh: ReturnType<typeof buildMesh>;
  left: BoundaryHistory;
  right: BoundaryHistory;
  time: number;
  temperatures: number[];
  initialTemperatures: number[];
  internalEnergy0: number;
  cumulativeHeatIn: number;
}

function sourceTemp(bc: BoundaryCondition): number {
  if (bc.type === 'temperature') return bc.value as number;
  if (bc.type === 'convection') return bc.fluidTemperature as number;
  return 0; // adiabatic: conductance is 0, source term unused
}

export function internalEnergy(state: Pick<SolverState, 'mesh' | 'temperatures'>): number {
  let u = 0;
  const { cells } = state.mesh;
  for (let i = 0; i < cells.length; i++) {
    u += cells[i].capacity * cells[i].dx * state.temperatures[i];
  }
  return u;
}

/**
 * Solve a tridiagonal system A T = b (Thomas algorithm).
 * sub[i], diag[i], sup[i] with sup[n-1]=sub[0]=0.
 */
export function solveTridiagonal(sub: number[], diag: number[], sup: number[], rhs: number[]): number[] {
  const n = diag.length;
  const cp = new Array<number>(n);
  const dp = new Array<number>(n);
  cp[0] = sup[0] / diag[0];
  dp[0] = rhs[0] / diag[0];
  for (let i = 1; i < n; i++) {
    const denom = diag[i] - sub[i] * cp[i - 1];
    cp[i] = i < n - 1 ? sup[i] / denom : 0;
    dp[i] = (rhs[i] - sub[i] * dp[i - 1]) / denom;
  }
  const x = new Array<number>(n);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

export interface CreateSolverInput {
  layers: unknown;
  initialTemperature: unknown;
  left: unknown;
  right: unknown;
}

export function createSolver(input: CreateSolverInput): SolverState {
  const layers = validateLayers(input.layers);
  if (typeof input.initialTemperature !== 'number' || !Number.isFinite(input.initialTemperature)) {
    fail('VALIDATION', 'initialTemperature must be a finite number', input.initialTemperature);
  }
  const left = validateHistory(input.left);
  const right = validateHistory(input.right);
  const mesh = buildMesh(layers);
  const temperatures = mesh.cells.map(() => input.initialTemperature as number);
  const state: SolverState = {
    layers,
    mesh,
    left,
    right,
    time: 0,
    temperatures,
    initialTemperatures: [...temperatures],
    internalEnergy0: 0,
    cumulativeHeatIn: 0,
  };
  state.internalEnergy0 = internalEnergy(state);
  return state;
}

/** One backward-Euler step using the conditions active at end time. */
export function step(state: SolverState, dt: number): StepResult {
  if (!Number.isFinite(dt) || dt <= 0) {
    fail('ILLEGAL_TIME', 'time step must be a positive finite number', { dt });
  }
  const { cells, faces } = state.mesh;
  const n = cells.length;
  const endTime = state.time + dt;
  const bcL = conditionAt(state.left, endTime);
  const bcR = conditionAt(state.right, endTime);

  const gL = boundaryConductance(state.layers[cells[0].layerIndex].conductivity, cells[0].dx, bcL);
  const gR = boundaryConductance(
    state.layers[cells[n - 1].layerIndex].conductivity,
    cells[n - 1].dx,
    bcR,
  );

  const sub = new Array<number>(n).fill(0);
  const diag = new Array<number>(n).fill(0);
  const sup = new Array<number>(n).fill(0);
  const rhs = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const cap = cells[i].capacity * cells[i].dx;
    diag[i] = cap / dt;
    rhs[i] = (cap / dt) * state.temperatures[i];
    if (i > 0) {
      const g = faces[i - 1].g;
      diag[i] += g;
      sub[i] = -g;
      diag[i - 1] += g;
      sup[i - 1] = -g;
    }
  }
  diag[0] += gL;
  diag[n - 1] += gR;
  rhs[0] += gL * sourceTemp(bcL);
  rhs[n - 1] += gR * sourceTemp(bcR);

  const next = solveTridiagonal(sub, diag, sup, rhs);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(next[i])) {
      fail('NON_FINITE', 'solver produced a non-finite temperature', { cell: i, value: next[i] });
    }
  }

  // Surface heat flux, positive in +x direction [W/m^2].
  const qLeftIntoWall = gL * (sourceTemp(bcL) - next[0]);
  const qRightIntoWall = gR * (sourceTemp(bcR) - next[n - 1]);
  const normalizeZero = (v: number) => (Object.is(v, -0) ? 0 : v);
  // Signed +x flux at the right surface:
  const qLeftPlusX = normalizeZero(qLeftIntoWall);
  const qRightPlusX = normalizeZero(-qRightIntoWall);

  let solveResidual = 0;
  for (let i = 0; i < n; i++) {
    let r = diag[i] * next[i] - rhs[i];
    if (i > 0) r += sub[i] * next[i - 1];
    if (i < n - 1) r += sup[i] * next[i + 1];
    const ar = Math.abs(r);
    if (ar > solveResidual) solveResidual = ar;
  }

  const prev = state.temperatures;
  let dU = 0;
  for (let i = 0; i < n; i++) {
    dU += cells[i].capacity * cells[i].dx * (next[i] - prev[i]);
  }
  // Backward-Euler energy accounting: flux evaluated at end of step * dt.
  const boundaryEnergyStep = (qLeftIntoWall + qRightIntoWall) * dt;

  state.temperatures = next;
  state.time = endTime;
  state.cumulativeHeatIn += boundaryEnergyStep;

  const u = internalEnergy(state);

  return {
    time: endTime,
    dt,
    temperatures: [...next],
    flux: { left: qLeftPlusX, right: qRightPlusX },
    boundaryEnergyStep,
    internalEnergyStep: dU,
    internalEnergy: u,
    cumulativeHeatIn: state.cumulativeHeatIn,
    energyResidual: state.cumulativeHeatIn - (u - state.internalEnergy0),
    solveResidual,
    leftCondition: bcL,
    rightCondition: bcR,
  };
}

/**
 * Advance to targetTime with steps <= maxDt. Steps are split exactly at
 * boundary step times so the active condition never spans a discontinuity.
 */
export function advance(
  state: SolverState,
  targetTime: number,
  maxDt: number,
  onStep?: (s: StepResult) => void,
): StepResult {
  if (!Number.isFinite(targetTime) || targetTime < state.time) {
    fail('ILLEGAL_TIME', 'targetTime must be finite and not earlier than current time', {
      targetTime,
      current: state.time,
    });
  }
  if (!Number.isFinite(maxDt) || maxDt <= 0) {
    fail('ILLEGAL_TIME', 'maxDt must be a positive finite number', { maxDt });
  }

  let last: StepResult | null = null;
  while (state.time < targetTime - 1e-12) {
    const breaks = [
      ...breakpointsBetween(state.left, state.time, targetTime),
      ...breakpointsBetween(state.right, state.time, targetTime),
    ].sort((a, b) => a - b);
    const nextBreak = breaks.length > 0 ? breaks[0] : targetTime;
    const dt = Math.min(maxDt, Math.max(nextBreak - state.time, 1e-15));
    last = step(state, dt);
    onStep?.(last);
  }
  if (last === null) {
    fail('ILLEGAL_TIME', 'nothing to advance', { time: state.time, targetTime });
  }
  return last;
}

/** Flux at internal material interfaces, positive in +x [W/m^2]. */
export function interfaceFluxes(state: SolverState): InternalFlux[] {
  const t = state.temperatures;
  return state.mesh.faces.map((f) => ({
    faceIndex: f.index,
    x: f.x,
    q: f.g * (t[f.index] - t[f.index + 1]),
  }));
}
