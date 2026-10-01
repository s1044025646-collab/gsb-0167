import type { DatabaseSync } from 'node:sqlite';
import type {
  BoundaryHistory,
  LayerInput,
  StepResult,
} from '../core/types.ts';
import { buildMesh } from '../core/mesh.ts';
import { versionHash } from '../core/version.ts';
import { fail } from '../core/errors.ts';
import { decodeJson, encodeJson } from '../core/json.ts';

export interface WallRow {
  id: number;
  name: string;
  layers: LayerInput[];
  totalThickness: number;
  materialVersion: string;
  createdAt: number;
}

export interface SimRow {
  id: number;
  wallId: number;
  name: string;
  initialTemperature: number;
  left: BoundaryHistory;
  right: BoundaryHistory;
  boundaryVersion: string;
  materialVersionSnapshot: string;
  time: number;
  temperatures: number[] | null;
  cumulativeHeatIn: number;
  internalEnergy0: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface StepRow extends StepResult {
  id: number;
  simId: number;
  seq: number;
}

export class Repo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createWall(name: string, layers: LayerInput[], now: number): WallRow {
    const total = layers.reduce((s, l) => s + l.thickness, 0);
    const materialVersion = versionHash(layers);
    const info = this.db
      .prepare(
        `INSERT INTO walls (name, layers_json, total_thickness, material_version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, encodeJson(layers), total, materialVersion, now);
    const id = Number(info.lastInsertRowid);
    return this.getWall(id);
  }

  getWall(id: number): WallRow {
    const row = this.db.prepare('SELECT * FROM walls WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) fail('NOT_FOUND', `wall ${id} not found`);
    const wall = mapWall(row);
    const layerTotal = wall.layers.reduce((s, l) => s + l.thickness, 0);
    if (Math.abs(layerTotal - wall.totalThickness) > 1e-12 * Math.max(1, layerTotal)) {
      fail(
        'THICKNESS_MISMATCH',
        `wall ${id} stored total thickness does not match its layer definitions`,
        { stored: wall.totalThickness, layerTotal },
      );
    }
    return wall;
  }

  listWalls(limit: number, offset: number): { items: WallRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM walls').get() as { c: number }).c;
    const rows = this.db
      .prepare('SELECT * FROM walls ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(mapWall), total };
  }

  createSimulation(
    wallId: number,
    name: string,
    initialTemperature: number,
    left: BoundaryHistory,
    right: BoundaryHistory,
    now: number,
  ): SimRow {
    const wall = this.getWall(wallId);
    const boundaryVersion = versionHash({ left, right });
    const info = this.db
      .prepare(
        `INSERT INTO simulations
         (wall_id, name, initial_temperature, left_history_json, right_history_json,
          boundary_version, material_version_snapshot, time, temperatures_json,
          cumulative_heat_in, internal_energy0, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, 'active', ?, ?)`,
      )
      .run(
        wall.id,
        name,
        initialTemperature,
        encodeJson(left),
        encodeJson(right),
        boundaryVersion,
        wall.materialVersion,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    // Initialize temperatures and U0 from the wall mesh.
    const mesh = buildMesh(wall.layers);
    const temps = mesh.cells.map(() => initialTemperature);
    const u0 = mesh.cells.reduce((s, c) => s + c.capacity * c.dx * initialTemperature, 0);
    this.db
      .prepare(
        `UPDATE simulations SET temperatures_json = ?, internal_energy0 = ?, updated_at = ? WHERE id = ?`,
      )
      .run(encodeJson(temps), u0, now, id);
    return this.getSimulation(id);
  }

  getSimulation(id: number): SimRow {
    const row = this.db.prepare('SELECT * FROM simulations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) fail('NOT_FOUND', `simulation ${id} not found`);
    return mapSim(row);
  }

  listSimulations(
    wallId: number | null,
    limit: number,
    offset: number,
  ): { items: SimRow[]; total: number } {
    const where = wallId === null ? '' : 'WHERE wall_id = ?';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) c FROM simulations ${where}`)
      .get(...(wallId === null ? [] : [wallId])) as { c: number };
    const rows = this.db
      .prepare(`SELECT * FROM simulations ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...(wallId === null ? [limit, offset] : [wallId, limit, offset])) as Record<string, unknown>[];
    return { items: rows.map(mapSim), total: totalRow.c };
  }

  /** Fail if the wall's materials were modified after the simulation snapshot. */
  assertMaterialCurrent(sim: SimRow): void {
    const wall = this.getWall(sim.wallId);
    if (wall.materialVersion !== sim.materialVersionSnapshot) {
      fail(
        'MATERIAL_MODIFIED',
        `wall ${wall.id} material definition changed since simulation ${sim.id} was created; resume is refused`,
        {
          wallVersion: wall.materialVersion,
          simSnapshot: sim.materialVersionSnapshot,
        },
      );
    }
  }

  nextSeq(simId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) m FROM sim_steps WHERE sim_id = ?')
      .get(simId) as { m: number };
    return row.m + 1;
  }

  /** Persist one step and advance simulation state atomically. */
  appendStep(sim: SimRow, seq: number, result: StepResult, now: number): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO sim_steps
           (sim_id, seq, time, dt, temperatures_json, flux_left, flux_right,
            boundary_energy_step, internal_energy_step, internal_energy, cumulative_heat_in,
            energy_residual, solve_residual)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sim.id,
          seq,
          result.time,
          result.dt,
          encodeJson(result.temperatures),
          result.flux.left,
          result.flux.right,
          result.boundaryEnergyStep,
          result.internalEnergyStep,
          result.internalEnergy,
          result.cumulativeHeatIn,
          result.energyResidual,
          result.solveResidual,
        );
      this.db
        .prepare(
          `UPDATE simulations SET time = ?, temperatures_json = ?, cumulative_heat_in = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          result.time,
          encodeJson(result.temperatures),
          result.cumulativeHeatIn,
          now,
          sim.id,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // transaction may already be aborted by the engine
      }
      throw err;
    }
  }

  listSteps(simId: number, limit: number, offset: number): { items: StepRow[]; total: number } {
    const total = (
      this.db.prepare('SELECT COUNT(*) c FROM sim_steps WHERE sim_id = ?').get(simId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare('SELECT * FROM sim_steps WHERE sim_id = ? ORDER BY seq LIMIT ? OFFSET ?')
      .all(simId, limit, offset) as Record<string, unknown>[];
    return { items: rows.map((r) => mapStep(r, simId)), total };
  }

  getStep(simId: number, seq: number): StepRow {
    const row = this.db
      .prepare('SELECT * FROM sim_steps WHERE sim_id = ? AND seq = ?')
      .get(simId, seq) as Record<string, unknown> | undefined;
    if (!row) fail('NOT_FOUND', `step ${seq} of simulation ${simId} not found`);
    return mapStep(row, simId);
  }

  rememberIdempotency(key: string, response: unknown, simId: number | null, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (key, sim_id, response_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, simId, encodeJson(response), now);
  }

  getIdempotency(key: string): unknown | null {
    const row = this.db
      .prepare('SELECT response_json FROM idempotency_keys WHERE key = ?')
      .get(key) as { response_json: string } | undefined;
    return row ? decodeJson(row.response_json) : null;
  }

  /** Aggregated energy ledger from stored steps. */
  energyLedger(simId: number) {
    const sim = this.getSimulation(simId);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(boundary_energy_step),0) AS boundary_energy,
           COALESCE(SUM(internal_energy_step),0) AS internal_energy_change,
           MAX(ABS(energy_residual)) AS max_residual,
           COUNT(*) AS steps
         FROM sim_steps WHERE sim_id = ?`,
      )
      .get(simId) as {
      boundary_energy: number;
      internal_energy_change: number;
      max_residual: number | null;
      steps: number;
    };
    return {
      simulationId: simId,
      time: sim.time,
      steps: row.steps,
      cumulativeHeatIn: sim.cumulativeHeatIn,
      summedBoundaryEnergy: row.boundary_energy,
      internalEnergyChange: row.internal_energy_change,
      maxStepEnergyResidual: row.max_residual ?? 0,
      units: {
        temperature: 'K',
        time: 's',
        flux: 'W/m^2 (+x positive; surface values reported into wall)',
        energy: 'J/m^2',
        integration: 'per-step backward-Euler end flux times dt, summed',
      },
    };
  }
}

function mapWall(row: Record<string, unknown>): WallRow {
  return {
    id: row.id as number,
    name: row.name as string,
    layers: decodeJson(row.layers_json as string) as LayerInput[],
    totalThickness: row.total_thickness as number,
    materialVersion: row.material_version as string,
    createdAt: row.created_at as number,
  };
}

function mapSim(row: Record<string, unknown>): SimRow {
  return {
    id: row.id as number,
    wallId: row.wall_id as number,
    name: row.name as string,
    initialTemperature: row.initial_temperature as number,
    left: decodeJson(row.left_history_json as string) as BoundaryHistory,
    right: decodeJson(row.right_history_json as string) as BoundaryHistory,
    boundaryVersion: row.boundary_version as string,
    materialVersionSnapshot: row.material_version_snapshot as string,
    time: row.time as number,
    temperatures: row.temperatures_json
      ? (decodeJson<number[]>(row.temperatures_json as string))
      : null,
    cumulativeHeatIn: row.cumulative_heat_in as number,
    internalEnergy0: row.internal_energy0 as number,
    status: row.status as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapStep(row: Record<string, unknown>, simId: number): StepRow {
  return {
    id: row.id as number,
    simId,
    seq: row.seq as number,
    time: row.time as number,
    dt: row.dt as number,
    temperatures: decodeJson<number[]>(row.temperatures_json as string),
    flux: { left: row.flux_left as number, right: row.flux_right as number },
    boundaryEnergyStep: row.boundary_energy_step as number,
    internalEnergyStep: row.internal_energy_step as number,
    internalEnergy: row.internal_energy as number,
    cumulativeHeatIn: row.cumulative_heat_in as number,
    internalEnergy: 0,
    energyResidual: row.energy_residual as number,
    solveResidual: row.solve_residual as number,
  };
}
