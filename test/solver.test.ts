import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, initialTemperatures } from '../src/core/grid.js';
import { buildHistory } from '../src/core/boundary.js';
import { advance, initRun, internalEnergy, implicitStep } from '../src/core/solver.js';
import { slabSeries, steadySeries, interpolateTo } from '../src/core/analytics.js';
import { convectionCooling, multilayerSteady, stepHeating, twoEndsConstant, uniformInsulated } from '../src/fixtures/materials.js';
import { AppError } from '../src/core/errors.js';
import { compareVariants } from '../src/services/compare.js';

function runCase(fx: ReturnType<typeof multilayerSteady>, dt: number, tEnd: number, mult = 1) {
  const layers = fx.wall.layers.map((l) => ({ ...l, n: Math.max(1, Math.round(l.n * mult)) }));
  const grid = buildGrid(layers);
  const T0 = initialTemperatures(layers, grid);
  const state = initRun(grid, T0);
  const result = advance({
    grid,
    histL: fx.left,
    histR: fx.right,
    dt,
    tEnd,
    snapshotEvery: 1,
    state,
  });
  return { grid, result };
}

describe('uniform insulated slab', () => {
  test('temperature stays exactly constant and no energy moves', () => {
    const fx = uniformInsulated();
    const { grid, result } = runCase(fx, 60, 3600);
    for (let i = 0; i < grid.n; i++) assert.ok(Math.abs(result.T[i] - 20) < 1e-12);
    assert.ok(Math.abs(result.ledger.QL) < 1e-10);
    assert.ok(Math.abs(result.ledger.QR) < 1e-10);
    assert.ok(Math.abs(result.ledger.residual) < 1e-9);
  });
});

describe('energy conservation and temperature-scale invariance', () => {
  test('QL+QR == dU with trapezoidal face-energy quadrature', () => {
    const fx = convectionCooling();
    const { result } = runCase(fx, 30, 5000);
    assert.ok(Math.abs(result.ledger.residual) < 1e-7, `residual ${result.ledger.residual}`);
  });

  test('shifting every temperature by a constant does not change fluxes or dU', () => {
    const fx = convectionCooling();
    const a = runCase(fx, 30, 4000);
    const shiftedLayers = fx.wall.layers.map((l) => ({ ...l, T0: l.T0 + 123.4 }));
    const shifted: typeof fx = {
      wall: { ...fx.wall, layers: shiftedLayers },
      left: buildHistory('L', [{ t: 0, bc: { kind: 'convection', h: 15, Tinf: 20 + 123.4 } }]),
      right: buildHistory('R', [{ t: 0, bc: { kind: 'convection', h: 15, Tinf: 20 + 123.4 } }]),
    };
    const b = runCase(shifted, 30, 4000);
    for (let i = 0; i < a.grid.n; i++) {
      assert.ok(Math.abs(a.result.T[i] - (b.result.T[i] - 123.4)) < 1e-8);
    }
    assert.ok(Math.abs(a.result.ledger.dU - b.result.ledger.dU) < 1e-6);
  });
});

describe('multilayer steady state against independent analytic series resistance', () => {
  test('converges to exact q and piecewise-linear T; interface flux continuous', () => {
    const fx = multilayerSteady();
    const exact = steadySeries(fx.wall.layers, 80, 20);
    const { grid, result } = runCase(fx, 200, 200_000, 2);
    let maxErr = 0;
    for (let i = 0; i < grid.n; i++) {
      maxErr = Math.max(maxErr, Math.abs(result.T[i] - exact.T(grid.cells[i].xc)));
    }
    assert.ok(maxErr < 1e-6, `steady T maxErr ${maxErr}`);
    assert.ok(Math.abs(result.ledger.residual) < 1e-3, `residual ${result.ledger.residual}`);
    // flux continuity across every internal face, incl. 5000:1 k jump
    for (const f of grid.faces) {
      const q = f.g * (result.T[f.index - 1] - result.T[f.index]);
      assert.ok(Math.abs(q - exact.q) < 1e-7 * Math.abs(exact.q), `face ${f.index} q=${q} vs ${exact.q}`);
    }
  });
});

describe('single-material transient series solution', () => {
  test('matches analytic slab solution at cell centers and refines toward it', () => {
    const fx = twoEndsConstant(0, 100);
    const layer = { ...fx.wall.layers[0], T0: 25 };
    const exact = slabSeries(layer, 0, 100, 600);
    const errs: number[] = [];
    for (const mult of [1, 2, 4]) {
      const { grid, result } = runCase(
        { wall: { name: 'x', layers: [{ ...layer, n: layer.n * mult }] }, left: fx.left, right: fx.right },
        mult >= 4 ? 0.5 : 1,
        600,
        1,
      );
      let maxErr = 0;
      for (let i = 0; i < grid.n; i++) {
        maxErr = Math.max(maxErr, Math.abs(result.T[i] - exact(grid.cells[i].xc, 600)));
      }
      errs.push(maxErr);
    }
    assert.ok(errs[0] < 5.0, `coarse transient maxErr ${errs[0]}`);
    assert.ok(errs[2] < errs[0] / 2, `expected refinement, got ${errs.join(',')}`);
  });
});

describe('boundary step splitting at exact time', () => {
  test('no change before tStep and a step boundary lands exactly on event time', () => {
    const fx = stepHeating(3600);
    const { grid, result } = runCase(fx, 600, 7200);
    assert.deepEqual(result.events, [3600]);
    // There must be an accepted step ending exactly at 3600.
    assert.ok(result.steps.some((s) => Math.abs(s.t - 3600) < 1e-9));
    // Before the step (insulated both sides) interior is still at 20.
    const atStep = result.steps.find((s) => Math.abs(s.t - 3600) < 1e-9)!;
    for (let i = 1; i < grid.n; i++) assert.ok(Math.abs(atStep.T[i] - 20) < 1e-10);
    // Afterwards heat enters from the left only: left cells hottest.
    assert.ok(result.T[0] > result.T[grid.n - 1]);
    assert.ok(result.ledger.residual < 1e-7);
  });
});

describe('refinement', () => {
  test('coarse differs from fine and error shrinks under refinement', () => {
    const fx = stepHeating(1800);
    const report = compareVariants(
      fx.wall.layers,
      {
        L: fx.left.segments.map((s) => ({ t: s.t0, bc: s.bc })),
        R: fx.right.segments.map((s) => ({ t: s.t0, bc: s.bc })),
      },
      3600,
      [
        { label: 'coarse', cellsMultiplier: 1, dt: 300 },
        { label: 'medium', cellsMultiplier: 2, dt: 120 },
        { label: 'fine', cellsMultiplier: 4, dt: 30 },
      ],
    );
    const errs = report.rows.map((r) => r.errVsFinest);
    assert.ok(errs[0] > errs[1]);
    assert.ok(errs[2] === 0);
    assert.ok(errs[0] > 1e-3, 'coarse must visibly differ from fine (coarse is not exact)');
  });
});

describe('failure modes', () => {
  test('non-positive properties are rejected', () => {
    assert.throws(
      () => buildGrid([{ name: 'a', thickness: 0.1, k: 0, rho: 1, cp: 1, T0: 0, n: 2 }]),
      (e: unknown) => e instanceof AppError && e.code === 'NON_POSITIVE_PROPERTY',
    );
    assert.throws(
      () => buildGrid([{ name: 'a', thickness: -0.1, k: 1, rho: 1, cp: 1, T0: 0, n: 2 }]),
      (e: unknown) => e instanceof AppError && e.code === 'NON_POSITIVE_PROPERTY',
    );
  });

  test('illegal times are rejected', () => {
    const fx = uniformInsulated();
    const grid = buildGrid(fx.wall.layers);
    const state = initRun(grid, initialTemperatures(fx.wall.layers, grid));
    assert.throws(
      () =>
        advance({
          grid,
          histL: fx.left,
          histR: fx.right,
          dt: 0,
          tEnd: 10,
          snapshotEvery: 1,
          state,
        }),
      (e: unknown) => e instanceof AppError && e.code === 'ILLEGAL_TIME',
    );
  });

  test('ill-conditioned NaN injection produces SOLVER_NON_FINITE', () => {
    const grid = buildGrid([{ name: 'a', thickness: 0.1, k: 1, rho: 1, cp: 1, T0: 0, n: 4 }]);
    const bc = { kind: 'temperature', T: Number.NaN } as never;
    assert.throws(
      () => implicitStep(grid, new Array(4).fill(0), 1, bc, bc),
      (e: unknown) => e instanceof AppError && e.code === 'SOLVER_NON_FINITE',
    );
  });

  test('boundary event not starting at t=0 is rejected', () => {
    assert.throws(
      () => buildHistory('L', [{ t: 5, bc: { kind: 'insulated' } }]),
      (e: unknown) => e instanceof AppError && e.code === 'BAD_BOUNDARY',
    );
  });
});

describe('internal energy bookkeeping', () => {
  test('U recomputed from full T vector equals stored cumulative dU + U0', () => {
    const fx = convectionCooling();
    const { grid, result } = runCase(fx, 60, 3000);
    const layers0 = fx.wall.layers;
    const U0 = internalEnergy(grid, initialTemperatures(layers0.map((l) => ({ ...l, n: grid.cells.filter((c) => c.layer === l.name).length })), grid));
    const Unow = internalEnergy(grid, result.T);
    assert.ok(Math.abs(Unow - U0 - result.ledger.dU) < 1e-7);
  });

  test('interpolation helper is monotone', () => {
    const v = interpolateTo([0.5, 1.5], [0, 1, 2], [0, 10, 20]);
    assert.deepEqual(v, [5, 15]);
  });
});
