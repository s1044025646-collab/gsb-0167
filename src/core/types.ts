/**
 * Domain model for 1-D multilayer plane-wall transient conduction.
 *
 * Coordinate convention
 * ----------------------
 * x increases from the LEFT face (x = 0, "side L") to the RIGHT face
 * (x = total thickness, "side R"). Heat flux q is POSITIVE in +x.
 *
 * All quantities are per unit cross-sectional area (A = 1 m^2):
 *   thickness L [m], conductivity k [W/(m K)], density rho [kg/m^3],
 *   specific heat cp [J/(kg K)], temperature [K or deg C, differences only].
 *
 * Boundary conditions:
 *   { kind: 'temperature', T }            prescribed face temperature [K]
 *   { kind: 'insulated' }                 zero heat flux (symmetry)
 *   { kind: 'convection', h, Tinf }       q = h (T_face - Tinf), h [W/m2K]
 */

export type BoundaryKind = 'temperature' | 'insulated' | 'convection';

export interface BCTemperature {
  kind: 'temperature';
  T: number;
}
export interface BCInsulated {
  kind: 'insulated';
}
export interface BCConvection {
  kind: 'convection';
  h: number;
  Tinf: number;
}
export type BoundaryCondition = BCTemperature | BCInsulated | BCConvection;

export type Side = 'L' | 'R';

/** A single homogeneous layer. */
export interface LayerSpec {
  name: string;
  thickness: number; // [m]
  k: number; // conductivity [W/(m K)]
  rho: number; // density [kg/m^3]
  cp: number; // specific heat [J/(kg K)]
  T0: number; // initial temperature [K]
  n: number; // number of finite volumes in this layer (>= 1)
}

/** A piecewise-constant boundary schedule segment, valid for t0 <= t < t1. */
export interface BCSegment {
  t0: number; // [s]
  t1: number; // [s], Infinity for the open-ended last segment
  bc: BoundaryCondition;
}

export interface BoundaryHistory {
  side: Side;
  segments: BCSegment[]; // sorted, contiguous, covering [0, Infinity)
}

/** A finite-volume cell after grid construction. */
export interface Cell {
  index: number;
  layer: string;
  xc: number; // cell center [m]
  dx: number; // cell width [m]
  k: number;
  rho: number;
  cp: number;
}

/** Internal face between cell i-1 and cell i. */
export interface InternalFace {
  index: number; // face index = right-neighbor cell index, 1..N-1
  xf: number; // face position [m]
  /** harmonic-style series conductance [W/(m2 K)]: 1 / (dxL/2kL + dxR/2kR) */
  g: number;
  isMaterialInterface: boolean;
  layerL: string;
  layerR: string;
}

export interface Grid {
  cells: Cell[];
  faces: InternalFace[];
  totalThickness: number;
  n: number;
}

export interface SolverOptions {
  /** Max integration step. Steps are split automatically at boundary events. */
  dt: number; // [s]
  tEnd: number; // [s]
  /** Persist a snapshot (full T vector) every k accepted steps (>=1). */
  snapshotEvery?: number;
  /** Stop after this many accepted steps; used for pause/resume. */
  maxSteps?: number;
}

export interface EnergyLedger {
  /** Net energy that entered through L face over elapsed time [J/m2]. */
  QL: number;
  /** Net energy that entered through R face over elapsed time [J/m2]. */
  QR: number;
  /** Sum of internal-energy changes of all cells relative to t=0 [J/m2]. */
  dU: number;
  /** QL + QR - dU; identically ~0 for an energy-conserving step sequence. */
  residual: number;
}

export interface StepRecord {
  step: number;
  t: number;
  dt: number;
  T: number[];
  /** Heat flux INTO the wall at L at the END of this step [W/m2]. */
  qL: number;
  /** Heat flux INTO the wall at R at the END of this step [W/m2]. */
  qR: number;
  /** Energy entering through L during THIS step (implicit right-endpoint) [J/m2]. */
  eL: number;
  /** Energy entering through R during THIS step (implicit right-endpoint) [J/m2]. */
  eR: number;
  /** Internal energy change during THIS step [J/m2]. */
  dU: number;
  ledger: EnergyLedger;
  snapshot: boolean;
}

export interface SolveResult {
  t: number;
  steps: StepRecord[];
  T: number[];
  ledger: EnergyLedger;
  events: number[]; // times at which a boundary change forced a step split
  finished: boolean; // true when t >= tEnd
}
