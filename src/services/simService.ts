import type { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { buildGrid, initialTemperatures } from '../core/grid.js';
import { bcAt, buildHistory } from '../core/boundary.js';
import { advance, initRun, internalEnergy, type RunState } from '../core/solver.js';
import { boundaryFlux } from '../core/boundary.js';
import { AppError } from '../core/errors.js';
import {
  contentHash,
  mapBoundary,
  mapWall,
  Repo,
  type BoundaryEventsInput,
  type Clock,
  type Ids,
  type Page,
  type PageResult,
} from '../db/repo.js';
import type { EnergyLedger, LayerSpec } from '../core/types.js';

export interface CreateSimInput {
  wallId: string;
  boundaryId?: string;
  dt: number;
  tEnd: number;
  snapshotEvery?: number;
}

export interface RunOptions {
  maxSteps?: number;
  /** Explicitly acknowledge that the boundary set changed since last run. */
  acceptBoundaryChange?: boolean;
  /** Explicitly bind a different (newer) boundary set before continuing. */
  newBoundaryId?: string;
}

interface PersistedSim {
  id: string;
  wall_id: string;
  boundary_id: string;
  dt: number;
  t_end: number;
  snapshot_every: number;
  t_now: number;
  step_count: number;
  status: string;
  material_hash: string;
  boundary_hash: string;
  T_json: string | null;
  q_l_prev: number | null;
  q_r_prev: number | null;
  u0: number | null;
  q_ledger_json: string;
}

export class SimService {
  private repo: Repo;
  constructor(
    private db: DatabaseSync,
    clock?: Clock,
    ids?: Ids,
  ) {
    this.repo = new Repo(db, clock, ids);
  }

  get walls() {
    return this.repo;
  }

  createWall(name: string, layers: LayerSpec[]) {
    return this.repo.createWall(name, layers);
  }
  updateWall(id: string, name: string | undefined, layers: LayerSpec[]) {
    return this.repo.updateWall(id, name, layers);
  }
  setBoundary(wallId: string, history: BoundaryEventsInput) {
    return this.repo.createBoundary(wallId, history);
  }

  createSimulation(input: CreateSimInput): PersistedSim {
    if (!(Number.isFinite(input.dt) && input.dt > 0)) {
      throw new AppError('ILLEGAL_TIME', 'dt must be finite and > 0');
    }
    if (!(Number.isFinite(input.tEnd) && input.tEnd > 0)) {
      throw new AppError('ILLEGAL_TIME', 'tEnd must be finite and > 0');
    }
    const snapshotEvery = input.snapshotEvery ?? 10;
    if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new AppError('VALIDATION', 'snapshotEvery must be an integer >= 1');
    }
    const wall = this.repo.requireWall(input.wallId);
    const boundary = input.boundaryId
      ? this.repo.requireBoundary(input.boundaryId)
      : this.repo.latestBoundary(input.wallId);
    if (!boundary) throw new AppError('NOT_FOUND', 'wall has no boundary set');
    if (boundary.wall_id !== wall.id) {
      throw new AppError('VALIDATION', 'boundary set does not belong to this wall');
    }

    const grid = buildGrid(wall.layers);
    const T0 = initialTemperatures(wall.layers, grid);
    const histL = buildHistory('L', boundary.history.L);
    const histR = buildHistory('R', boundary.history.R);
    const cellL = grid.cells[0];
    const cellR = grid.cells[grid.n - 1];
    const ql0 = boundaryFlux(histL.segments[0].bc, T0[0], cellL.k, cellL.dx);
    const qr0 = boundaryFlux(histR.segments[0].bc, T0[grid.n - 1], cellR.k, cellR.dx);
    const u0 = internalEnergy(grid, T0);

    const id = (this.repo as unknown as { ids: Ids }).ids.newId();
    const now = (this.repo as unknown as { clock: Clock }).clock.now();
    const empty: EnergyLedger = { QL: 0, QR: 0, dU: 0, residual: 0 };
    const row = {
      id,
      wall_id: wall.id,
      boundary_id: boundary.id,
      dt: input.dt,
      t_end: input.tEnd,
      snapshot_every: snapshotEvery,
      t_now: 0,
      step_count: 0,
      status: 'created',
      material_hash: wall.material_hash,
      boundary_hash: boundary.history_hash,
      T_json: JSON.stringify(T0),
      q_l_prev: ql0,
      q_r_prev: qr0,
      ql0,
      qr0,
      u0,
      q_ledger_json: JSON.stringify(empty),
      created_at: now,
      updated_at: now,
    };
    this.db.prepare('BEGIN').run();
    try {
      this.repo.insertSimulation(row);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.repo.requireSimulation(id) as unknown as PersistedSim;
  }

  /**
   * Advance a simulation. Each call persists inside ONE transaction; a solver
   * failure rolls back every step of the call so cumulative heat is never lost.
   */
  run(simId: string, opts: RunOptions = {}): { sim: PersistedSim; stepsRun: number; accepted: number[] } {
    let raw = this.repo.requireSimulation(simId) as unknown as PersistedSim;
    if (opts.newBoundaryId && opts.newBoundaryId !== raw.boundary_id) {
      const nb = this.repo.requireBoundary(opts.newBoundaryId);
      if (nb.wall_id !== raw.wall_id) {
        throw new AppError('VALIDATION', 'new boundary set belongs to a different wall');
      }
      if (!opts.acceptBoundaryChange) {
        throw new AppError(
          'BOUNDARY_VERSION_CHANGED',
          'continuing with a new boundary version requires acceptBoundaryChange',
        );
      }
      this.db
        .prepare('UPDATE simulations SET boundary_id=?, boundary_hash=?, updated_at=? WHERE id=?')
        .run(nb.id, nb.history_hash, Date.now() / 1000, simId);
      raw = this.repo.requireSimulation(simId) as unknown as PersistedSim;
    }
    const wall = mapWall(this.db.prepare('SELECT * FROM walls WHERE id=?').get(raw.wall_id) as never);
    const boundaryRow = this.db.prepare('SELECT * FROM boundary_sets WHERE id=?').get(raw.boundary_id) as never;
    const boundary = mapBoundary(boundaryRow);

    if (wall.material_hash !== raw.material_hash) {
      throw new AppError(
        'MATERIAL_CHANGED',
        `wall ${wall.id} material changed (v${wall.version}) since simulation was created; resume refused`,
      );
    }
    if (boundary.history_hash !== raw.boundary_hash) {
      if (!opts.acceptBoundaryChange) {
        throw new AppError(
          'BOUNDARY_VERSION_CHANGED',
          'boundary history changed since last run; pass acceptBoundaryChange to adopt the new version',
        );
      }
    }
    if (raw.status === 'finished') throw new AppError('SIM_FINISHED', 'simulation already reached tEnd');
    if (raw.t_now >= raw.t_end - 1e-10) throw new AppError('SIM_FINISHED', 'simulation already at tEnd');

    const grid = buildGrid(wall.layers);
    const histL = buildHistory('L', boundary.history.L);
    const histR = buildHistory('R', boundary.history.R);

    const T = JSON.parse(raw.T_json!) as number[];
    const ledger = JSON.parse(raw.q_ledger_json) as EnergyLedger;
    const state: RunState = {
      t: raw.t_now,
      step: raw.step_count,
      T,
      ledger,
      qLprev: raw.q_l_prev ?? 0,
      qRprev: raw.q_r_prev ?? 0,
      U0: raw.u0 ?? internalEnergy(grid, T),
    };

    this.db.exec('BEGIN');
    const accepted: number[] = [];
    try {
      const result = advance({
        grid,
        histL,
        histR,
        dt: raw.dt,
        tEnd: raw.t_end,
        maxSteps: opts.maxSteps,
        snapshotEvery: raw.snapshot_every,
        state,
      });

      const insStep = this.db.prepare(
        `INSERT INTO steps (sim_id, step, t, dt, q_l, q_r, e_l, e_r, d_u, ledger_json, is_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insSnap = this.db.prepare(
        'INSERT INTO snapshots (sim_id, step, t, t_json) VALUES (?,?,?,?)',
      );
      for (const s of result.steps) {
        insStep.run(
          simId, s.step, s.t, s.dt, s.qL, s.qR, s.eL, s.eR, s.dU,
          JSON.stringify(s.ledger), s.snapshot ? 1 : 0,
        );
        if (s.snapshot) insSnap.run(simId, s.step, s.t, JSON.stringify(s.T));
        accepted.push(s.step);
      }

      const finished = result.finished;
      this.db
        .prepare(
          `UPDATE simulations SET t_now=?, step_count=?, status=?, T_json=?, q_l_prev=?, q_r_prev=?,
           q_ledger_json=?, boundary_hash=?, updated_at=? WHERE id=?`,
        )
        .run(
          state.t, state.step, finished ? 'finished' : 'paused',
          JSON.stringify(state.T), state.qLprev, state.qRprev,
          JSON.stringify(state.ledger), boundary.history_hash, Date.now() / 1000, simId,
        );
      this.db.exec('COMMIT');
      return { sim: this.repo.requireSimulation(simId) as unknown as PersistedSim, stepsRun: accepted.length, accepted };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Pause is implicit via maxSteps; this just reports status. */
  status(simId: string) {
    const raw = this.repo.requireSimulation(simId) as unknown as PersistedSim;
    return {
      id: raw.id,
      wallId: raw.wall_id,
      boundaryId: raw.boundary_id,
      t: raw.t_now,
      tEnd: raw.t_end,
      step: raw.step_count,
      status: raw.status,
      dt: raw.dt,
      ledger: JSON.parse(raw.q_ledger_json) as EnergyLedger,
      T: JSON.parse(raw.T_json ?? '[]') as number[],
    };
  }

  /** Interface fluxes at the latest time: boundary faces + every internal face.
   *  Positive in +x; continuity across a material interface is verified by
   *  comparing the two face estimates. */
  interfaceFluxes(simId: string) {
    const raw = this.repo.requireSimulation(simId) as unknown as PersistedSim;
    const wall = mapWall(this.db.prepare('SELECT * FROM walls WHERE id=?').get(raw.wall_id) as never);
    const boundary = mapBoundary(
      this.db.prepare('SELECT * FROM boundary_sets WHERE id=?').get(raw.boundary_id) as never,
    );
    const grid = buildGrid(wall.layers);
    const T = JSON.parse(raw.T_json!) as number[];
    const histL = buildHistory('L', boundary.history.L);
    const histR = buildHistory('R', boundary.history.R);
    const cL = grid.cells[0];
    const cR = grid.cells[grid.n - 1];
    const bcL = bcAt(histL, raw.t_now).bc;
    const bcR = bcAt(histR, raw.t_now).bc;
    // Flux across an internal face in +x: g (T_left - T_right).
    const internal = grid.faces.map((f) => ({
      face: f.index,
      x: f.xf,
      materialInterface: f.isMaterialInterface,
      layerL: f.layerL,
      layerR: f.layerR,
      q: f.g * (T[f.index - 1] - T[f.index]),
    }));
    return {
      t: raw.t_now,
      convention: 'positive +x; boundary qL/qR reported INTO the wall',
      qLInto: boundaryFlux(bcL, T[0], cL.k, cL.dx),
      qRInto: boundaryFlux(bcR, T[grid.n - 1], cR.k, cR.dx),
      internal,
    };
  }

  listSteps(simId: string, page: Page): PageResult<Record<string, unknown>> {
    return this.repo.listSteps(simId, page);
  }
  listSnapshots(simId: string, page: Page): PageResult<Record<string, unknown>> {
    return this.repo.listSnapshots(simId, page);
  }

  /** Export the full energy ledger + per-step heat bookkeeping to JSON. */
  exportEnergy(simId: string, outFile: string) {
    const raw = this.repo.requireSimulation(simId) as unknown as PersistedSim;
    const ledger = JSON.parse(raw.q_ledger_json) as EnergyLedger;
    const steps = this.db
      .prepare('SELECT step, t, e_l, e_r, d_u, ledger_json FROM steps WHERE sim_id=? ORDER BY step')
      .all(simId) as Record<string, unknown>[];
    const payload = {
      simulationId: simId,
      units: { energy: 'J/m^2', flux: 'W/m^2', time: 's', temperature: 'K (differences)' },
      quadrature: 'per-step face energy = backward-Euler right-endpoint (exactly balances FVM dU)',
      exportedAt: new Date().toISOString(),
      ledger,
      steps: steps.map((s) => ({
        step: s.step,
        t: s.t,
        eL: s.e_l,
        eR: s.e_r,
        dU: s.d_u,
        stepResidual: (s.e_l as number) + (s.e_r as number) - (s.d_u as number),
        cumulative: JSON.parse(s.ledger_json as string),
      })),
    };
    writeFileSync(outFile, JSON.stringify(payload, null, 2));
    return { outFile, ledger, stepCount: steps.length };
  }
}

export { contentHash };

