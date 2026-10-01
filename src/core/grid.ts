import type { Cell, Grid, InternalFace, LayerSpec } from './types.js';
import { AppError, fail } from './errors.js';

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Build a cell-centered non-uniform grid. Every layer is split into `n`
 * equal-width cells; cell-centered properties are uniform within a layer.
 */
export function buildGrid(layers: LayerSpec[]): Grid {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new AppError('VALIDATION', 'at least one layer is required');
  }

  const cells: Cell[] = [];
  let x = 0;
  for (const layer of layers) {
    if (!layer || typeof layer.name !== 'string' || layer.name.length === 0) {
      throw new AppError('VALIDATION', 'each layer needs a non-empty name');
    }
    for (const key of ['thickness', 'k', 'rho', 'cp', 'T0', 'n'] as const) {
      if (!isFiniteNumber(layer[key])) {
        throw new AppError('VALIDATION', `layer ${layer.name}: ${key} must be a finite number`, {
          field: key,
        });
      }
    }
    if (layer.thickness <= 0) {
      throw new AppError(
        'NON_POSITIVE_PROPERTY',
        `layer ${layer.name}: thickness must be > 0`,
      );
    }
    for (const key of ['k', 'rho', 'cp'] as const) {
      if (layer[key] <= 0) {
        throw new AppError(
          'NON_POSITIVE_PROPERTY',
          `layer ${layer.name}: ${key} must be > 0`,
          { field: key },
        );
      }
    }
    if (!Number.isInteger(layer.n) || layer.n < 1) {
      throw new AppError('BAD_GRID', `layer ${layer.name}: n must be an integer >= 1`);
    }

    const dx = layer.thickness / layer.n;
    for (let j = 0; j < layer.n; j++) {
      cells.push({
        index: cells.length,
        layer: layer.name,
        xc: x + (j + 0.5) * dx,
        dx,
        k: layer.k,
        rho: layer.rho,
        cp: layer.cp,
      });
    }
    x += layer.thickness;
  }

  if (cells.some((c) => !isFiniteNumber(c.xc))) {
    fail('BAD_GRID', 'non-finite cell coordinate');
  }

  const totalThickness = x;
  const faces: InternalFace[] = [];
  for (let i = 1; i < cells.length; i++) {
    const left = cells[i - 1];
    const right = cells[i];
    // Conductance across the shared face from the two half-cell resistances.
    // This series combination is exact for piecewise-constant k and stays
    // well behaved when kL >> kR (a simple arithmetic mean would not).
    const rLeft = left.dx / (2 * left.k);
    const rRight = right.dx / (2 * right.k);
    const g = 1 / (rLeft + rRight);
    if (!Number.isFinite(g) || g <= 0) fail('SOLVER_NON_FINITE', 'bad face conductance');
    faces.push({
      index: i,
      xf: left.xc + left.dx / 2,
      g,
      isMaterialInterface: left.layer !== right.layer,
      layerL: left.layer,
      layerR: right.layer,
    });
  }

  return { cells, faces, totalThickness, n: cells.length };
}

/** Initial temperature vector from per-layer T0. */
export function initialTemperatures(layers: LayerSpec[], grid: Grid): number[] {
  const T0byLayer = new Map(layers.map((l) => [l.name, l.T0]));
  return grid.cells.map((c) => {
    const t0 = T0byLayer.get(c.layer);
    if (t0 === undefined || !Number.isFinite(t0)) {
      fail('VALIDATION', `missing initial temperature for layer ${c.layer}`);
    }
    return t0;
  });
}

/** Cell capacitance per unit area C = rho cp dx [J/(m2 K)]. */
export function capacitance(c: Cell): number {
  return c.rho * c.cp * c.dx;
}
