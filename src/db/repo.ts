import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildGrid, initialTemperatures } from '../core/grid.js';
import { buildHistory } from '../core/boundary.js';
import { AppError } from '../core/errors.js';
import type { BoundaryCondition, LayerSpec } from '../core/types.js';

export interface Clock {
  now(): number;
}
export interface Ids {
  newId(): string;
}

export const realClock: Clock = { now: () => Date.now() / 1000 };
export const realIds: Ids = { newId: () => randomUUID() };

/** Deterministic injected clock/id source used by tests and demos. */
export class FakeRuntime implements Clock, Ids {
  private t: number;
  private seq = 0;
  constructor(start = 1_700_000_000) {
    this.t = start;
  }
  now(): number {
    this.t += 0.001;
    return this.t;
  }
  newId(): string {
    this.seq += 1;
    return `id-${this.seq.toString(16).padStart(12, '0')}`;
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function contentHash(v: unknown): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex');
}

export interface Page {
  limit: number;
  offset: number;
}

export function parsePage(query: { limit?: string | number; offset?: string | number }): Page {
  const limit = clampInt(query.limit, 50, 1, 200);
  const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { limit, offset };
}

function clampInt(v: string | number | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError('VALIDATION', 'pagination limit/offset must be integers');
  }
  return Math.min(max, Math.max(min, n));
}

export interface PageResult<T> {
  items: T[];
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface WallRow {
  id: string;
  name: string;
  version: number;
  layers: LayerSpec[];
  material_hash: string;
  thickness: number;
  n_cells: number;
  created_at: number;
  updated_at: number;
}

export interface BoundaryEventsInput {
  L: { t: number; bc: BoundaryCondition }[];
  R: { t: number; bc: BoundaryCondition }[];
}

export interface BoundaryRow {
  id: string;
  wall_id: string;
  version: number;
  history: BoundaryEventsInput;
  history_hash: string;
  created_at: number;
}

export class Repo {
  constructor(
    private db: DatabaseSync,
    private clock: Clock = realClock,
    private ids: Ids = realIds,
  ) {}

  createWall(name: string, layers: LayerSpec[]): WallRow {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AppError('VALIDATION', 'wall name is required');
    }
    const grid = buildGrid(layers);
    void initialTemperatures(layers, grid);
    const hash = contentHash(layers);
    const id = this.ids.newId();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO walls (id, name, version, layers_json, material_hash, thickness, n_cells, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, JSON.stringify(layers), hash, grid.totalThickness, grid.n, now, now);
    return this.getWall(id)!;
  }

  updateWall(id: string, name: string | undefined, layers: LayerSpec[]): WallRow {
    const existing = this.requireWall(id);
    const grid = buildGrid(layers);
    const hash = contentHash(layers);
    const now = this.clock.now();
    const newName = name ?? existing.name;
    const newVersion = existing.version + 1;
    this.db
      .prepare(
        `UPDATE walls SET name=?, version=?, layers_json=?, material_hash=?, thickness=?, n_cells=?, updated_at=?
         WHERE id=?`,
      )
      .run(newName, newVersion, JSON.stringify(layers), hash, grid.totalThickness, grid.n, now, id);
    return this.getWall(id)!;
  }

  getWall(id: string): WallRow | null {
    const row = this.db.prepare('SELECT * FROM walls WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapWall(row) : null;
  }

  requireWall(id: string): WallRow {
    const w = this.getWall(id);
    if (!w) throw new AppError('NOT_FOUND', `wall ${id} not found`);
    return w;
  }

  listWalls(page: Page): PageResult<WallRow> {
    const rows = this.db
      .prepare('SELECT * FROM walls ORDER BY created_at, id LIMIT ? OFFSET ?')
      .all(page.limit + 1, page.offset) as Record<string, unknown>[];
    return paginate(rows.map(mapWall), page);
  }

  createBoundary(wallId: string, history: BoundaryEventsInput): BoundaryRow {
    this.requireWall(wallId);
    buildHistory('L', history.L);
    buildHistory('R', history.R);
    const last = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM boundary_sets WHERE wall_id = ?')
      .get(wallId) as { v: number };
    const version = last.v + 1;
    const id = this.ids.newId();
    const now = this.clock.now();
    const hash = contentHash(history);
    this.db
      .prepare(
        `INSERT INTO boundary_sets (id, wall_id, version, history_json, history_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, wallId, version, JSON.stringify(history), hash, now);
    return this.getBoundary(id)!;
  }

  getBoundary(id: string): BoundaryRow | null {
    const row = this.db.prepare('SELECT * FROM boundary_sets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapBoundary(row) : null;
  }

  requireBoundary(id: string): BoundaryRow {
    const b = this.getBoundary(id);
    if (!b) throw new AppError('NOT_FOUND', `boundary set ${id} not found`);
    return b;
  }

  latestBoundary(wallId: string): BoundaryRow | null {
    const row = this.db
      .prepare('SELECT * FROM boundary_sets WHERE wall_id = ? ORDER BY version DESC LIMIT 1')
      .get(wallId) as Record<string, unknown> | undefined;
    return row ? mapBoundary(row) : null;
  }

  listBoundaries(wallId: string, page: Page): PageResult<BoundaryRow> {
    this.requireWall(wallId);
    const rows = this.db
      .prepare('SELECT * FROM boundary_sets WHERE wall_id = ? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(wallId, page.limit + 1, page.offset) as Record<string, unknown>[];
    return paginate(rows.map(mapBoundary), page);
  }

  insertSimulation(row: {
    id: string; wall_id: string; boundary_id: string;
    dt: number; t_end: number; snapshot_every: number;
    t_now: number; step_count: number; status: string;
    material_hash: string; boundary_hash: string;
    T_json: string; q_l_prev: number; q_r_prev: number;
    ql0: number; qr0: number; u0: number;
    q_ledger_json: string; created_at: number; updated_at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO simulations
         (id, wall_id, boundary_id, dt, t_end, snapshot_every, t_now, step_count, status,
          material_hash, boundary_hash, T_json, q_l_prev, q_r_prev, ql0, qr0, u0,
          q_ledger_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.wall_id, row.boundary_id, row.dt, row.t_end, row.snapshot_every,
        row.t_now, row.step_count, row.status, row.material_hash, row.boundary_hash,
        row.T_json, row.q_l_prev, row.q_r_prev, row.ql0, row.qr0, row.u0,
        row.q_ledger_json, row.created_at, row.updated_at,
      );
  }

  getSimulation(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM simulations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? row : null;
  }

  requireSimulation(id: string): Record<string, unknown> {
    const s = this.getSimulation(id);
    if (!s) throw new AppError('NOT_FOUND', `simulation ${id} not found`);
    return s;
  }

  listSimulations(page: Page, wallId?: string): PageResult<Record<string, unknown>> {
    const rows = wallId
      ? (this.db
          .prepare('SELECT * FROM simulations WHERE wall_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?')
          .all(wallId, page.limit + 1, page.offset) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM simulations ORDER BY created_at, id LIMIT ? OFFSET ?')
          .all(page.limit + 1, page.offset) as Record<string, unknown>[]);
    return paginate(rows, page);
  }

  listSteps(simId: string, page: Page): PageResult<Record<string, unknown>> {
    this.requireSimulation(simId);
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE sim_id = ? ORDER BY step LIMIT ? OFFSET ?')
      .all(simId, page.limit + 1, page.offset) as Record<string, unknown>[];
    return paginate(rows, page);
  }

  listSnapshots(simId: string, page: Page): PageResult<Record<string, unknown>> {
    this.requireSimulation(simId);
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE sim_id = ? ORDER BY step LIMIT ? OFFSET ?')
      .all(simId, page.limit + 1, page.offset) as Record<string, unknown>[];
    return paginate(rows, page);
  }

  idempotencyGet(key: string) {
    return this.db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
  }
}

export function mapWall(row: Record<string, unknown>): WallRow {
  return {
    id: row.id as string,
    name: row.name as string,
    version: row.version as number,
    layers: JSON.parse(row.layers_json as string) as LayerSpec[],
    material_hash: row.material_hash as string,
    thickness: row.thickness as number,
    n_cells: row.n_cells as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function mapBoundary(row: Record<string, unknown>): BoundaryRow {
  return {
    id: row.id as string,
    wall_id: row.wall_id as string,
    version: row.version as number,
    history: JSON.parse(row.history_json as string) as BoundaryEventsInput,
    history_hash: row.history_hash as string,
    created_at: row.created_at as number,
  };
}

function paginate<T>(rowsWithExtra: T[], page: Page): PageResult<T> {
  const hasMore = rowsWithExtra.length > page.limit;
  const items = rowsWithExtra.slice(0, page.limit);
  return {
    items,
    limit: page.limit,
    offset: page.offset,
    nextOffset: hasMore ? page.offset + page.limit : null,
  };
}
