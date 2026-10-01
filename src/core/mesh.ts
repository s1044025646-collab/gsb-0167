import type { Cell, InternalFace, LayerInput, Mesh } from './types.ts';
import { fail } from './errors.ts';

export const TOL = 1e-10;

export function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function validateLayers(layers: unknown): LayerInput[] {
  if (!Array.isArray(layers) || layers.length === 0) {
    fail('VALIDATION', 'layers must be a non-empty array');
  }
  return layers.map((raw, i) => {
    const l = raw as Partial<LayerInput>;
    const where = `layers[${i}]`;
    if (typeof l.name !== 'string' || l.name.length === 0) {
      fail('VALIDATION', `${where}.name must be a non-empty string`);
    }
    for (const key of ['thickness', 'conductivity', 'density', 'specificHeat'] as const) {
      if (!isPositiveFinite(l[key])) {
        fail('NON_POSITIVE_PROPERTY', `${where}.${key} must be a positive finite number`, {
          field: `${where}.${key}`,
          value: l[key],
        });
      }
    }
    if (!Number.isInteger(l.cells) || (l.cells as number) < 1) {
      fail('VALIDATION', `${where}.cells must be a positive integer`, {
        field: `${where}.cells`,
        value: l.cells,
      });
    }
    return {
      name: l.name as string,
      thickness: l.thickness as number,
      conductivity: l.conductivity as number,
      density: l.density as number,
      specificHeat: l.specificHeat as number,
      cells: l.cells as number,
    };
  });
}

/**
 * Build a cell-centered mesh. Each layer i is split into `cells[i]` equal
 * control volumes. Cell heat capacity per unit area is rho*cp*dx.
 */
export function buildMesh(layers: LayerInput[]): Mesh {
  const cells: Cell[] = [];
  let offset = 0;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const dx = layer.thickness / layer.cells;
    for (let j = 0; j < layer.cells; j++) {
      cells.push({
        layerIndex: li,
        center: offset + (j + 0.5) * dx,
        dx,
        capacity: layer.density * layer.specificHeat,
      });
    }
    offset += layer.thickness;
  }

  const faces: InternalFace[] = [];
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i];
    const b = cells[i + 1];
    const la = layers[a.layerIndex];
    const lb = layers[b.layerIndex];
    // Half-control-volume thermal resistances in series (harmonic combination).
    const rA = a.dx / (2 * la.conductivity);
    const rB = b.dx / (2 * lb.conductivity);
    const g = 1 / (rA + rB);
    faces.push({ index: i, x: a.center + a.dx / 2, g });
  }

  return { cells, faces, totalThickness: offset };
}

/**
 * Conductance between an end cell center and its wall surface.
 * Convection adds the film resistance 1/h in series with the half-cell
 * conduction resistance. Adiabatic walls return 0.
 */
export function boundaryConductance(
  k: number,
  dx: number,
  bc: { type: string; htc?: number },
): number {
  if (bc.type === 'adiabatic') return 0;
  const halfCell = dx / (2 * k);
  if (bc.type === 'temperature') return 1 / halfCell;
  if (bc.type === 'convection') {
    if (!isPositiveFinite(bc.htc)) {
      fail('NON_POSITIVE_PROPERTY', 'convection htc must be positive finite', { htc: bc.htc });
    }
    return 1 / (halfCell + 1 / (bc.htc as number));
  }
  fail('VALIDATION', `unknown boundary type: ${bc.type}`);
}
