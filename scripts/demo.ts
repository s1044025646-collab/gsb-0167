/**
 * Repeatable end-to-end demonstration using injected deterministic clock/ids
 * and a project-local database under data/demo.db.
 *
 * It exercises every fixture: insulated, fixed ends, multilayer steady
 * resistance, convection cooling and step heating; prints energy balances,
 * interface fluxes and a refinement comparison; then exports an energy book.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { FakeRuntime } from '../src/db/repo.js';
import { SimService } from '../src/services/simService.js';
import { compareVariants } from '../src/services/compare.js';
import { steadySeries } from '../src/core/analytics.js';
import {
  convectionCooling,
  multilayerSteady,
  stepHeating,
  twoEndsConstant,
  uniformInsulated,
} from '../src/fixtures/materials.js';

const dir = 'data';
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, 'demo.db');
rmSync(dbFile, { force: true });
rmSync(`${dbFile}-wal`, { force: true });
rmSync(`${dbFile}-shm`, { force: true });

const db = openDatabase(dbFile);
migrate(db);
const svc = new SimService(db, new FakeRuntime(1_700_000_000), new FakeRuntime());

function events(fx: ReturnType<typeof multilayerSteady>) {
  return {
    L: fx.left.segments.map((s) => ({ t: s.t0, bc: s.bc })),
    R: fx.right.segments.map((s) => ({ t: s.t0, bc: s.bc })),
  };
}

function runFixture(name: string, fx: ReturnType<typeof multilayerSteady>, dt: number, tEnd: number, steps?: number) {
  const wall = svc.createWall(name, fx.wall.layers);
  const b = svc.setBoundary(wall.id, events(fx));
  const sim = svc.createSimulation({ wallId: wall.id, boundaryId: b.id, dt, tEnd, snapshotEvery: 10 });
  const out = svc.run(sim.id, { maxSteps: steps });
  const status = svc.status(sim.id);
  return { wall, b, sim, out, status };
}

console.log('=== 1. uniform insulated (expect zero motion) ===');
const ins = runFixture('demo-insulated', uniformInsulated(), 60, 3600);
console.log(`T range ${Math.min(...ins.status.T).toFixed(6)}..${Math.max(...ins.status.T).toFixed(6)}, residual ${ins.status.ledger.residual.toExponential(2)}`);

console.log('\n=== 2. both ends fixed temperature ===');
const ends = runFixture('demo-ends', twoEndsConstant(0, 100), 1, 1200);
console.log(`t=${ends.status.t}, residual ${ends.status.ledger.residual.toExponential(2)}`);

console.log('\n=== 3. multilayer steady series resistance (5000:1 k jump) ===');
const ml = runFixture('demo-multilayer', multilayerSteady(), 200, 200_000);
const exact = steadySeries(ml.wall.layers, 80, 20);
const fl = svc.interfaceFluxes(ml.sim.id);
const ifaces = fl.internal.filter((f) => f.materialInterface);
console.log(`exact q=${exact.q.toFixed(6)} W/m2, total R=${exact.resistance.toFixed(5)} m2K/W`);
for (const f of ifaces) {
  console.log(`  interface ${f.layerL}|${f.layerR}: q=${f.q.toFixed(6)} (error ${Math.abs(f.q - exact.q).toExponential(2)})`);
}
console.log(`energy residual ${ml.status.ledger.residual.toExponential(2)}`);

console.log('\n=== 4. convection cooling (energy bookkeeping) ===');
const cv = runFixture('demo-convection', convectionCooling(), 30, 5000);
console.log(`QL=${cv.status.ledger.QL.toFixed(3)} QR=${cv.status.ledger.QR.toFixed(3)} dU=${cv.status.ledger.dU.toFixed(3)} residual=${cv.status.ledger.residual.toExponential(2)} J/m2`);

console.log('\n=== 5. step heating with pause/resume ===');
const st = stepHeating(3600);
const stepWall = svc.createWall('demo-step', st.wall.layers);
const stepB = svc.setBoundary(stepWall.id, events(st));
const stepSim = svc.createSimulation({ wallId: stepWall.id, boundaryId: stepB.id, dt: 600, tEnd: 7200, snapshotEvery: 3 });
svc.run(stepSim.id, { maxSteps: 6 });
const paused = svc.status(stepSim.id);
console.log(`paused at t=${paused.t} (pre-event interior still ${paused.T[8].toFixed(4)}), status=${paused.status}`);
svc.run(stepSim.id);
const resumed = svc.status(stepSim.id);
console.log(`resumed to t=${resumed.t}, status=${resumed.status}, residual=${resumed.ledger.residual.toExponential(2)}`);

console.log('\n=== 6. grid/time refinement (coarse is explicitly compared, not trusted) ===');
const cmp = compareVariants(
  st.wall.layers,
  events(st),
  3600,
  [
    { label: 'coarse', cellsMultiplier: 1, dt: 300 },
    { label: 'medium', cellsMultiplier: 2, dt: 120 },
    { label: 'fine', cellsMultiplier: 4, dt: 30 },
  ],
);
for (const row of cmp.rows) {
  console.log(`  ${row.label.padEnd(7)} n=${row.nCells} dt=${row.dt} errVsFinest=${row.errVsFinest.toExponential(3)} energyRes=${row.energyResidual.toExponential(2)}`);
}

console.log('\n=== 7. energy ledger export ===');
const exported = svc.exportEnergy(ml.sim.id, join(dir, 'demo-energy.json'));
console.log(`exported ${exported.stepCount} steps to ${exported.outFile}`);

db.close();
console.log('\nDemo complete. All data is under ./data (demo.db, demo-energy.json).');
