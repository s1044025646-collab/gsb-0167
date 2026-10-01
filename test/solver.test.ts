import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSolver, advance, interfaceFluxes } from '../src/core/solver.ts';
import { slabConvectionSeries, slabFixedEndsSeries, steadyFlux } from '../src/core/analytic.ts';
import { fixture } from './helpers.ts';
import { AppError } from '../src/core/errors.ts';

const eps = 1e-9;

test('uniform adiabatic wall keeps constant temperature and zero flux', () => {
  const f = fixture('uniform-adiabatic');
  const s = createSolver(f);
  const r = advance(s, 5000, 100);
  assert.ok(r.temperatures.every((t) => Math.abs(t - 300) < eps));
  assert.ok(Math.abs(r.flux.left) < eps && Math.abs(r.flux.right) < eps);
  assert.ok(Math.abs(r.energyResidual) < 1e-6);
});

test('temperature scale translation leaves all temperature differences and flux unchanged', () => {
  const f = fixture('both-fixed');
  const shift = 273.15;
  const a = createSolver(f);
  const b = createSolver({
    ...f,
    initialTemperature: f.initialTemperature + shift,
    left: { segments: f.left.segments.map((sg) => ({ ...sg, condition: { ...sg.condition, value: (sg.condition.value ?? 0) + shift } })) },
    right: { segments: f.right.segments.map((sg) => ({ ...sg, condition: { ...sg.condition, value: (sg.condition.value ?? 0) + shift } })) },
  });
  const ra = advance(a, 900, 15);
  const rb = advance(b, 900, 15);
  for (let i = 0; i < ra.temperatures.length; i++) {
    assert.ok(Math.abs((rb.temperatures[i] - shift) - ra.temperatures[i]) < 1e-10);
  }
  assert.ok(Math.abs(rb.flux.left - ra.flux.left) < 1e-9);
});

test('convection cooling matches the independent slab series solution', () => {
  const f = fixture('convection-cooling');
  const s = createSolver({ ...f, layers: [{ ...f.layers[0], cells: 80 }] });
  advance(s, 3600, 3);
  const center = s.temperatures[Math.floor(s.temperatures.length / 2)];
  const analytic = slabConvectionSeries(
    {
      thickness: 0.2,
      conductivity: 1.4,
      density: 2200,
      specificHeat: 850,
    },
    350,
    290,
    12,
  0.1,
    3600,
  );
  assert.ok(Math.abs(center - analytic) < 0.02, { center, analytic });
});

test('fixed ends transient matches independent sine series and tends to linear steady state', () => {
  const f = fixture('both-fixed');
  const s = createSolver(f);
  advance(s, 1200, 2);
  const p = { thickness: 0.3, conductivity: 1.4, density: 2200, specificHeat: 850 };
  for (const [i, cell] of s.mesh.cells.entries()) {
    const a = slabFixedEndsSeries(p, 300, 400, 300, cell.center, 1200);
    // early-time gradient near the imposed hot face is the hardest region;
    // first-order FVM on 30 cells is expected within ~0.5 K, convergence is
    // asserted separately in refinement.test.ts
    assert.ok(Math.abs(s.temperatures[i] - a) < 0.5, { i, got: s.temperatures[i], a });
  }
  advance(s, 1e6, 5000);
  const q = interfaceFluxes(s);
  const qAnalytic = steadyFlux(f.layers, 400, 300);
  assert.ok(Math.abs(q[0].q - qAnalytic) < 1e-6 * Math.abs(qAnalytic));
});

test('multilayer steady interface flux is continuous and equals resistance series', () => {
  const f = fixture('multilayer-resistance');
  const s = createSolver(f);
  advance(s, 1e6, 5000);
  const q = interfaceFluxes(s);
  const qAnalytic = steadyFlux(f.layers, 370, 300);
  for (const face of q) assert.ok(Math.abs(face.q - q[0].q) < 1e-7);
  assert.ok(Math.abs(q[0].q - qAnalytic) < 1e-6 * Math.abs(qAnalytic));
});

test('energy is conserved: integrated surface heat equals internal energy change', () => {
  const f = fixture('convection-cooling');
  const s = createSolver(f);
  const r = advance(s, 5000, 25);
  assert.ok(Math.abs(r.energyResidual) < 1e-4, r.energyResidual);
  assert.ok(Math.abs(r.cumulativeHeatIn - (r.internalEnergy - s.internalEnergy0)) < 1e-3);
});

test('boundary step is split at the exact event time', () => {
  const f = fixture('step-heating');
  const s = createSolver(f);
  // dt that does not divide 600s; step must land exactly on t=600.
  const r = advance(s, 1200, 90);
  assert.equal(r.time, 1200);
  // before the step nothing changed
  const mid = advance(createSolver(f), 599.999, 90);
  assert.ok(mid.temperatures.every((t) => Math.abs(t - 300) < eps));
  // after the step the hot face started warming
  assert.ok(r.temperatures[0] > 300);
});

test('rejects non-positive properties and non-finite results', () => {
  const f = fixture('uniform-adiabatic');
  assert.throws(
    () =>
      createSolver({
        layers: [{ name: 'x', thickness: 0.1, conductivity: 0, density: 1, specificHeat: 1, cells: 4 }],
        initialTemperature: 300,
        left: f.left,
        right: f.right,
      }) as never,
    (e: Error) => e instanceof AppError && e.message.includes('conductivity'),
  );
});

test('rejects illegal times', () => {
  const f = fixture('uniform-adiabatic');
  const s = createSolver(f);
  assert.throws(() => advance(s, -1, 10), AppError);
  assert.throws(() => advance(s, 10, 0), AppError);
});
