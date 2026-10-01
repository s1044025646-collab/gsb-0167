import type { DatabaseSync } from 'node:sqlite';
import { buildGrid, initialTemperatures } from '../core/grid.js';
import { buildHistory } from '../core/boundary.js';
import { advance, initRun, internalEnergy } from '../core/solver.js';
import { interpolateTo } from '../core/analytics.js';
import { AppError } from '../core/errors.js';
import { mapBoundary, mapWall, type BoundaryEventsInput } from '../db/repo.js';
import type { LayerSpec } from '../core/types.js';

export interface Variant {
  label: string;
  /** Per-layer cell count multiplier applied to the stored grid. */
  cellsMultiplier: number;
  dt: number;
}

export interface CompareRow {
  label: string;
  nCells: number;
  dt: number;
  t: number;
  tEnd: number;
  Tcenter: number;
  errVsFinest: number;
  energyResidual: number;
  steps: number;
}

/**
 * Run the SAME physical case on a family of grids/time steps and report
 * differences against the finest variant. The coarse run is NEVER presented
 * as exact: convergence is shown by shrinking error and split events are
 * reported from every variant.
 */
export function compareVariants(
  layers: LayerSpec[],
  history: BoundaryEventsInput,
  tEnd: number,
  variants: Variant[],
): { rows: CompareRow[]; finestLabel: string; eventSplits: Record<string, number[]>; grids: { label: string; xc: number[] }[] } {
  if (variants.length < 2) throw new AppError('VALIDATION', 'need at least two variants to compare');
  const runs = variants.map((v) => {
    const scaled: LayerSpec[] = layers.map((l) => ({
      ...l,
      n: Math.max(1, Math.round(l.n * v.cellsMultiplier)),
    }));
    const grid = buildGrid(scaled);
    const T0 = initialTemperatures(scaled, grid);
    const histL = buildHistory('L', history.L);
    const histR = buildHistory('R', history.R);
    const state = initRun(grid, T0);
    const result = advance({
      grid,
      histL,
      histR,
      dt: v.dt,
      tEnd,
      snapshotEvery: 1,
      state,
    });
    return { v, grid, result };
  });

  const finest = runs[runs.length - 1];
  const rows: CompareRow[] = runs.map((r) => {
    const interp = interpolateTo(
      finest.grid.cells.map((c) => c.xc),
      r.grid.cells.map((c) => c.xc),
      r.result.T,
    );
    let err = 0;
    for (let i = 0; i < interp.length; i++) err = Math.max(err, Math.abs(interp[i] - finest.result.T[i]));
    const mid = r.result.T[Math.floor(r.result.T.length / 2)];
    return {
      label: r.v.label,
      nCells: r.grid.n,
      dt: r.v.dt,
      t: r.result.t,
      tEnd,
      Tcenter: mid,
      errVsFinest: err,
      energyResidual: r.result.ledger.residual,
      steps: r.result.steps.length,
    };
  });

  return {
    rows,
    finestLabel: finest.v.label,
    eventSplits: Object.fromEntries(runs.map((r) => [r.v.label, r.result.events])),
    grids: runs.map((r) => ({ label: r.v.label, xc: r.grid.cells.map((c) => c.xc) })),
  };
}

export function compareStored(db: DatabaseSync, wallId: string, boundaryId: string | undefined, tEnd: number, dtList: number[], multList: number[]) {
  const wallRow = db.prepare('SELECT * FROM walls WHERE id=?').get(wallId);
  if (!wallRow) throw new AppError('NOT_FOUND', 'wall not found');
  const wall = mapWall(wallRow as never);
  const bRow = boundaryId
    ? db.prepare('SELECT * FROM boundary_sets WHERE id=?').get(boundaryId)
    : db.prepare('SELECT * FROM boundary_sets WHERE wall_id=? ORDER BY version DESC LIMIT 1').get(wallId);
  if (!bRow) throw new AppError('NOT_FOUND', 'boundary set not found');
  const boundary = mapBoundary(bRow as never);
  const variants: Variant[] = multList.map((m, i) => ({
    label: `x${m}_dt${dtList[i] ?? dtList[dtList.length - 1]}`,
    cellsMultiplier: m,
    dt: dtList[i] ?? dtList[dtList.length - 1],
  }));
  return compareVariants(wall.layers, boundary.history, tEnd, variants);
}

export { internalEnergy };
