/**
 * Reproducible end-to-end demo. Uses a throwaway database inside ./data and
 * deterministic data; no network, no randomness, injected fixed clock.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db/client.ts';
import { Repo } from '../src/db/repo.ts';
import { ConductionService, type Clock } from '../src/core/service.ts';
import { FIXTURES } from '../src/core/fixtures.ts';
import { slabConvectionSeries, steadyFlux } from '../src/core/analytic.ts';
import { createSolver, advance } from '../src/core/solver.ts';

const dir = mkdtempSync(join(process.cwd(), 'data', 'demo-'));
const handle = openDatabase(join(dir, 'demo.db'));
let tick = 1_700_000_000_000;
const clock: Clock = { now: () => tick++ };
const service = new ConductionService(new Repo(handle.db), clock);

const say = (label: string, value?: unknown) => {
  process.stdout.write(`\n--- ${label} ---\n`);
  if (value !== undefined) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};

try {
  say('fixtures', FIXTURES.map((f) => f.key));

  const multi = FIXTURES.find((f) => f.key === 'multilayer-resistance')!.build();
  const wall = service.createWall('demo-wall', multi.layers);
  say('wall created', { id: wall.id, thickness: wall.totalThickness, materialVersion: wall.materialVersion });

  const sim = service.createSimulation(wall.id, 'demo', multi.initialTemperature, multi.left, multi.right);
  say('simulation created (boundary pinned)', { id: sim.id, boundaryVersion: sim.boundaryVersion });

  const r1 = service.compute(sim.id, { targetTime: 1800, maxDt: 30 });
  say('compute to 1800s (pause)', {
    steps: r1.stepsAdded,
    flux: r1.final?.flux,
    residual: r1.final?.energyResidual,
  });

  const r2 = service.compute(sim.id, { targetTime: 3600, maxDt: 30 });
  say('resume to 3600s', {
    time: r2.final?.time,
    cumulativeHeatIn: r2.final?.cumulativeHeatIn,
    ledgerResidual: r2.ledger.maxStepEnergyResidual,
  });

  say('energy ledger', service.ledger(sim.id));

  // Independent analytic steady-state check for the multilayer wall.
  const qAnalytic = steadyFlux(multi.layers, 370, 300);
  say('analytic multilayer steady flux', { qAnalytic });

  // Refinement comparison against the convection cooling series solution.
  const conv = FIXTURES.find((f) => f.key === 'convection-cooling')!.build();
  const rows = [];
  for (const [cells, dt] of [
    [10, 100],
    [20, 50],
    [40, 25],
    [80, 10],
  ] as const) {
    const solver = createSolver({ ...conv, layers: [{ ...conv.layers[0], cells }] });
    const r = advance(solver, 3600, dt);
    const center = r.temperatures[Math.floor(cells / 2)];
    const analytic = slabConvectionSeries(
      {
        thickness: conv.layers[0].thickness,
        conductivity: conv.layers[0].conductivity,
        density: conv.layers[0].density,
        specificHeat: conv.layers[0].specificHeat,
      },
      conv.initialTemperature,
      290,
      12,
      conv.layers[0].thickness / 2,
      3600,
    );
    rows.push({ cells, dt, center: round(center), analytic: round(analytic), absError: round(Math.abs(center - analytic)), energyResidual: r.energyResidual });
  }
  say('refinement vs analytic (coarse is reference, not truth)', rows);
  process.stdout.write('\nDemo completed successfully.\n');
} finally {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
