import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';
import { AppError } from '../src/core/errors.ts';

test('thickness mismatch is reported when stored total disagrees with layers', () => {
  const h = makeHarness();
  try {
    const f = h.service;
    // Directly construct an inconsistent wall row through the repository:
    // total_thickness not equal to the sum of layer thicknesses.
    const layers = [
      { name: 'a', thickness: 0.1, conductivity: 1, density: 1, specificHeat: 1, cells: 4 },
    ];
    h.repo.db
      .prepare(
        `INSERT INTO walls (name, layers_json, total_thickness, material_version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('w', JSON.stringify(layers), 0.25, 'v', 1);
    assert.throws(
      () => h.repo.getWall(1),
      (e: Error) => e instanceof AppError && e.code === 'THICKNESS_MISMATCH',
    );
    void f;
  } finally {
    h.close();
  }
});

test('hydrate reports THICKNESS_MISMATCH when temperature vector length differs from mesh', () => {
  const h = makeHarness();
  try {
    const { simId } = (() => {
      const wall = h.service.createWall('w', [
        { name: 'a', thickness: 0.1, conductivity: 1, density: 1, specificHeat: 1, cells: 4 },
      ]);
      const sim = h.service.createSimulation(
        wall.id,
        's',
        300,
        { segments: [{ start: 0, end: Infinity, condition: { type: 'adiabatic' } }] },
        { segments: [{ start: 0, end: Infinity, condition: { type: 'adiabatic' } }] },
      );
      return { simId: sim.id };
    })();
    h.repo.db
      .prepare('UPDATE simulations SET temperatures_json = ? WHERE id = ?')
      .run(JSON.stringify([300, 300]), simId);
    assert.throws(
      () => h.service.compute(simId, { targetTime: 1, maxDt: 1 }),
      (e: Error) => e instanceof AppError && e.code === 'THICKNESS_MISMATCH',
    );
  } finally {
    h.close();
  }
});
