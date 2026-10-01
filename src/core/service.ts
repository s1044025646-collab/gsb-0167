import type { Repo, SimRow, WallRow } from '../db/repo.ts';
import type { BoundaryHistory, LayerInput, StepResult } from './types.ts';
import { validateLayers } from './mesh.ts';
import { constantHistory, validateHistory } from './boundary.ts';
import { advance, createSolver, interfaceFluxes, type SolverState } from './solver.ts';
import { fail } from './errors.ts';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ComputeRequest {
  targetTime: number;
  maxDt: number;
  idempotencyKey?: string;
}

export interface ComputeResponse {
  simulationId: number;
  fromTime: number;
  targetTime: number;
  stepsAdded: number;
  final: StepResult | null;
  ledger: ReturnType<Repo['energyLedger']>;
  replayed: boolean;
}

export class ConductionService {
  private readonly repo: Repo;
  private readonly clock: Clock;
  constructor(repo: Repo, clock: Clock = systemClock) {
    this.repo = repo;
    this.clock = clock;
  }

 createWall(name: unknown, layers: unknown): WallRow {
    if (typeof name !== 'string' || name.length === 0) {
      fail('VALIDATION', 'name must be a non-empty string');
    }
    const valid = validateLayers(layers);
    assertThicknessContinuous(valid);
    return this.repo.createWall(name, valid, this.clock.now());
  }

  createSimulation(
    wallId: unknown,
    name: unknown,
    initialTemperature: unknown,
    left: unknown,
    right: unknown,
  ): SimRow {
    const id = parseId(wallId, 'wallId');
    if (typeof name !== 'string' || name.length === 0) {
      fail('VALIDATION', 'name must be a non-empty string');
    }
    if (typeof initialTemperature !== 'number' || !Number.isFinite(initialTemperature)) {
      fail('VALIDATION', 'initialTemperature must be finite');
    }
    // Touch wall to 404 early and validate histories through the solver.
    this.repo.getWall(id);
    const sim = this.repo.createSimulation(
      id,
      name,
      initialTemperature,
      normalizeHistory(left),
      normalizeHistory(right),
      this.clock.now(),
    );
    return sim;
  }

  getWall(id: number): WallRow {
    return this.repo.getWall(id);
  }

  listWalls(limit: number, offset: number) {
    return this.repo.listWalls(limit, offset);
  }

  listSimulations(wallId: number | null, limit: number, offset: number) {
    return this.repo.listSimulations(wallId, limit, offset);
  }

  listSteps(simId: number, limit: number, offset: number) {
    return this.repo.listSteps(simId, limit, offset);
  }

  getSimulation(id: number): SimRow {
    return this.repo.getSimulation(id);
  }

  /** Rebuild the in-memory solver from persisted state (restart / resume). */
  hydrate(simId: number): { state: SolverState; sim: SimRow } {
    const sim = this.repo.getSimulation(simId);
    this.repo.assertMaterialCurrent(sim);
    const wall = this.repo.getWall(sim.wallId);
    const state = createSolver({
      layers: wall.layers,
      initialTemperature: sim.initialTemperature,
      left: sim.left,
      right: sim.right,
    });
    if (!sim.temperatures) fail('CONFLICT', 'simulation has no temperature vector');
    if (sim.temperatures.length !== state.mesh.cells.length) {
      fail(
        'THICKNESS_MISMATCH',
        'stored temperature vector length does not match the wall mesh',
        { stored: sim.temperatures.length, mesh: state.mesh.cells.length },
      );
    }
    for (const t of sim.temperatures) {
      if (!Number.isFinite(t)) fail('NON_FINITE', 'stored temperature is non-finite');
    }
    state.time = sim.time;
    state.temperatures = [...sim.temperatures];
    state.cumulativeHeatIn = sim.cumulativeHeatIn;
    return { state, sim };
  }

  compute(simId: unknown, req: ComputeRequest): ComputeResponse {
    const id = parseId(simId, 'simulationId');
    if (
      typeof req.targetTime !== 'number' ||
      !Number.isFinite(req.targetTime) ||
      req.targetTime < 0
    ) {
      fail('VALIDATION', 'targetTime must be a finite number >= 0');
    }
    if (typeof req.maxDt !== 'number' || !(req.maxDt > 0) || !Number.isFinite(req.maxDt)) {
      fail('ILLEGAL_TIME', 'maxDt must be a positive finite number');
    }
    if (req.idempotencyKey) {
      const cached = this.repo.getIdempotency(req.idempotencyKey);
      if (cached) {
        return this.withFreshLedger(cached as ComputeResponse);
      }
    }

    const { state, sim } = this.hydrate(id);
    const fromTime = sim.time;
    if (req.targetTime < fromTime - 1e-12) {
      fail('ILLEGAL_TIME', 'targetTime is earlier than the current simulation time', {
        targetTime: req.targetTime,
        current: fromTime,
      });
    }

    let seq = this.repo.nextSeq(id);
    let last: StepResult | null = null;
    let stepsAdded = 0;
    if (req.targetTime > fromTime + 1e-12) {
      advance(state, req.targetTime, req.maxDt, (result) => {
        this.repo.appendStep(sim, seq++, result, this.clock.now());
        last = result;
        stepsAdded++;
      });
    }

    const response: ComputeResponse = {
      simulationId: id,
      fromTime,
      targetTime: req.targetTime,
      stepsAdded,
      // freeze a compact final snapshot; ledger is re-read fresh on replay
      final: last
        ? {
            time: last.time,
            dt: last.dt,
            temperatures: last.temperatures,
            flux: last.flux,
            boundaryEnergyStep: last.boundaryEnergyStep,
            internalEnergyStep: last.internalEnergyStep,
            internalEnergy: last.internalEnergy,
            cumulativeHeatIn: last.cumulativeHeatIn,
            energyResidual: last.energyResidual,
            solveResidual: last.solveResidual,
            leftCondition: last.leftCondition,
            rightCondition: last.rightCondition,
          }
        : null,
      ledger: this.repo.energyLedger(id),
      replayed: false,
    };
    if (req.idempotencyKey) {
      this.repo.rememberIdempotency(req.idempotencyKey, response, id, this.clock.now());
    }
    return response;
  }

  /** Replay helper: refresh ledger against current stored rows. */
  private withFreshLedger(resp: ComputeResponse): ComputeResponse {
    return { ...resp, ledger: this.repo.energyLedger(resp.simulationId), replayed: true };
  }

  interfaceFluxes(simId: number) {
    const { state } = this.hydrate(simId);
    return {
      simulationId: simId,
      time: state.time,
      internal: interfaceFluxes(state),
      materialVersions: {
        boundary: this.repo.getSimulation(simId).boundaryVersion,
      },
    };
  }

  ledger(simId: number) {
    return this.repo.energyLedger(simId);
  }

  state(simId: number) {
    const { state } = this.hydrate(simId);
    return {
      simulationId: simId,
      time: state.time,
      temperatures: state.temperatures,
      cellCount: state.mesh.cells.length,
      cumulativeHeatIn: state.cumulativeHeatIn,
      boundaryVersion: this.repo.getSimulation(simId).boundaryVersion,
    };
  }
}

export function parseId(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    fail('VALIDATION', `${field} must be a positive integer`, { value });
  }
  return n;
}

export function parsePagination(query: {
  limit?: unknown;
  offset?: unknown;
}): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    fail('VALIDATION', 'limit must be an integer in [1, 500]', { limit });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    fail('VALIDATION', 'offset must be a non-negative integer', { offset });
  }
  return { limit, offset };
}

function assertThicknessContinuous(layers: LayerInput[]): void {
  // Total thickness must be positive finite and consistent with the layers.
  const sum = layers.reduce((s, l) => s + l.thickness, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    fail('THICKNESS_MISMATCH', 'total wall thickness must be positive finite', { sum });
  }
}

function normalizeHistory(raw: unknown): BoundaryHistory {
  if (raw && typeof raw === 'object' && Array.isArray((raw as BoundaryHistory).segments)) {
    return validateHistory(raw);
  }
  // shorthand: a single constant condition
  if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
    return constantHistory(validateHistory({ segments: [{ start: 0, end: Infinity, condition: raw }] }).segments[0].condition);
  }
  fail('VALIDATION', 'boundary must be a condition or history');
}

export { versionHash } from './version.ts';
export { validateHistory } from './boundary.ts';
export type { BoundaryHistory };
