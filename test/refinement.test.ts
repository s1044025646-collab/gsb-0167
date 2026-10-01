import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSolver, advance } from '../src/core/solver.ts';
import { slabConvectionSeries } from '../src/core/analytic.ts';
import { fixture } from './helpers.ts';

const p = { thickness: 0.2, conductivity: 1.4, density: 2200, specificHeat: 850 };

test('grid refinement monotonically reduces center temperature error', () => {
  const f = fixture('convection-cooling');
  const analytic = slabConvectionSeries(p, 350, 290, 12, 0.1, 1800);
  const errors: number[] = [];
  for (const cells of [10, 20, 40, 80]) {
    const s = createSolver({ ...f, layers: [{ ...f.layers[0], cells }] });
    advance(s, 1800, 2);
    const center = s.temperatures[Math.floor(cells / 2)];
    errors.push(Math.abs(center - analytic));
  }
  for (let i = 1; i < errors.length; i++) {
    assert.ok(errors[i] <= errors[i - 1] * 1.05, { errors });
  }
  assert.ok(errors[errors.length - 1] < errors[0] / 4, { errors });
});

test('time-step refinement reduces error (implicit stability does not imply accuracy)', () => {
  const f = fixture('convection-cooling');
  const analytic = slabConvectionSeries(p, 350, 290, 12, 0.1, 1800);
  const errors: number[] = [];
  for (const dt of [100, 25, 6]) {
    const s = createSolver({ ...f, layers: [{ ...f.layers[0], cells: 60 }] });
    advance(s, 1800, dt);
    errors.push(Math.abs(s.temperatures[30] - analytic));
  }
  assert.ok(errors[2] < errors[0] / 2, { errors });
});

test('harmonic interface conductance is used (not a simple average)', () => {
  // k1 >> k2: arithmetic mean would be k2/2-like error; series resistance is exact.
  const f = fixture('multilayer-resistance');
  const face = (() => {
    const s = createSolver(f);
    return s.mesh.faces.find((x) => Math.abs(x.x - 0.05) < 1e-9)!;
  })();
  const a = f.layers[0];
  const b = f.layers[1];
  const dxA = a.thickness / a.cells;
  const dxB = b.thickness / b.cells;
  const expected = 1 / (dxA / (2 * a.conductivity) + dxB / (2 * b.conductivity));
  assert.ok(Math.abs(face.g - expected) < 1e-12);
  // Arithmetic averaging of the two half-cell conductances would differ greatly.
  const arithmetic = 0.5 * (a.conductivity / (dxA / 2) + b.conductivity / (dxB / 2));
  assert.ok(Math.abs(arithmetic - face.g) / face.g > 10);
});
