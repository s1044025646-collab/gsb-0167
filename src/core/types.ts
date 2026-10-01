export interface LayerInput {
  name: string;
  thickness: number; // m, positive
  conductivity: number; // W/(m K), positive
  density: number; // kg/m^3, positive
  specificHeat: number; // J/(kg K), positive
  cells: number; // integer >= 1
}

export type BoundaryType = 'temperature' | 'adiabatic' | 'convection';

export interface BoundaryCondition {
  type: BoundaryType;
  /** temperature boundary: imposed surface temperature [K] */
  value?: number;
  /** convection: fluid temperature [K] */
  fluidTemperature?: number;
  /** convection: heat transfer coefficient [W/(m^2 K)] */
  htc?: number;
}

export interface BoundarySegment {
  /** segment is active for t in [start, end); last segment end may be Infinity */
  start: number; // s
  end: number; // s
  condition: BoundaryCondition;
}

export interface BoundaryHistory {
  /** ordered, non-overlapping segments covering [0, Infinity) */
  segments: BoundarySegment[];
}

export interface Cell {
  layerIndex: number;
  center: number; // m, global x
  dx: number; // m
  /** volumetric heat capacity rho*cp [J/(m^3 K)] */
  capacity: number;
}

export interface InternalFace {
  /** face is between cell index and index+1 */
  index: number;
  x: number; // m
  /** combined conductance per unit area [W/(m^2 K)] = 1 / (half-cell resistance sum) */
  g: number;
}

export interface Mesh {
  cells: Cell[];
  faces: InternalFace[];
  totalThickness: number;
}

export interface MeshSnapshot extends Mesh {
  layers: LayerInput[];
}

export interface SurfaceHeatFlux {
  /** heat flux into the wall at x=0 [W/m^2], +x direction positive */
  left: number;
  /** heat flux into the wall at x=L [W/m^2], +x direction positive */
  right: number;
}

export interface InternalFlux {
  faceIndex: number;
  x: number;
  /** positive in +x direction [W/m^2] */
  q: number;
}

export interface StepResult {
  time: number; // s, time at end of step
  dt: number; // s
  temperatures: number[]; // K, per cell
  flux: SurfaceHeatFlux;
  /** heat entering wall through both surfaces during this step [J/m^2] */
  boundaryEnergyStep: number;
  /** change in internal energy during this step [J/m^2] */
  internalEnergyStep: number;
  /** internal energy above reference temperature 0 K at end of step [J/m^2] */
  internalEnergy: number;
  /** cumulative heat entering through left + right [J/m^2] */
  cumulativeHeatIn: number;
  /** energy residual: cumulativeHeatIn - (U - U0) [J/m^2] */
  energyResidual: number;
  /** tridiagonal solve residual norm */
  solveResidual: number;
  leftCondition: BoundaryCondition;
  rightCondition: BoundaryCondition;
}

export interface AdvanceOptions {
  targetTime: number; // s
  maxDt: number; // s
  /** injectable clock used only for timestamps in persistence layer */
  onStep?: (step: StepResult) => void;
}
