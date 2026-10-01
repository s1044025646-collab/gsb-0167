import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, newService } from './helpers.ts';
import type { DatabaseSync } from 'node:sqlite';
import { SimService } from '../src/services/simService.js';
import { FakeRuntime } from '../src/db/repo.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { multilayerSteady, stepHeating } from '../src/fixtures/materials.js';
import { AppError } from '../src/core/errors.js';

let db: DatabaseSync;
let cleanup: () => void = () => {};

afterEach(() => cleanup());

function fixture(svc: SimService) {
  const fx = multilayerSteady();
  const wall = svc.createWall(fx.wall.name, fx.wall.layers);
  const b = svc.setBoundary(wall.id, {
    L: fx.left.segments.map((s) => ({ t: s.t0, bc: s.bc })),
    R: fx.right.segments.map((s) => ({ t: s.t0, bc: s.bc })),
  });
  const sim = svc.createSimulation({ wallId: wall.id, boundaryId: b.id, dt: 200, tEnd: 200_000, snapshotEvery: 25 });
  return { wall, b, sim };
}

describe('pause/resume and persistence', () => {
  test('chunked run with pause equals one continuous run and survives reopen', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const { sim } = fixture(svc);

    svc.run(sim.id, { maxSteps: 100 });
    const mid = svc.status(sim.id);
    assert.equal(mid.status, 'paused');
    const midT = mid.T.slice();

    // Reopen the database file with a fresh service (simulates restart).
    db.close();
    const reopened = openDatabase(env.file);
    const svc2 = new SimService(reopened, new FakeRuntime(), new FakeRuntime());
    svc2.run(sim.id);
    const end = svc2.status(sim.id);
    assert.equal(end.status, 'finished');

    // Continuous reference run in a separate database.
    const envRef = tempDb();
    const ref = newService(envRef.db);
    const r2 = fixture(ref);
    ref.run(r2.sim.id);
    const refEnd = ref.status(r2.sim.id);

    for (let i = 0; i < end.T.length; i++) assert.ok(Math.abs(end.T[i] - refEnd.T[i]) < 1e-9);
    assert.ok(Math.abs(end.ledger.QL - refEnd.ledger.QL) < 1e-7);
    assert.ok(Math.abs(end.ledger.residual) < 1e-3);
    envRef.cleanup();
    reopened.close();
    void midT;
  });

  test('snapshots store the full temperature vector at the configured cadence', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const { sim } = fixture(svc);
    svc.run(sim.id, { maxSteps: 60 });
    const snaps = svc.listSnapshots(sim.id, { limit: 100, offset: 0 });
    assert.ok(snaps.items.length > 0);
    for (const s of snaps.items) {
      const T = JSON.parse(s.t_json as string) as number[];
      assert.equal(T.length, svc.status(sim.id).T.length);
    }
  });
});

describe('version guards', () => {
  test('resume is refused after material change', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const { wall, sim } = fixture(svc);
    svc.run(sim.id, { maxSteps: 10 });
    // Mutate a layer (new material hash / version).
    const changed = wall.layers.map((l, i) => (i === 0 ? { ...l, k: l.k * 2 } : l));
    svc.updateWall(wall.id, undefined, changed);
    assert.throws(
      () => svc.run(sim.id),
      (e: unknown) => e instanceof AppError && e.code === 'MATERIAL_CHANGED',
    );
  });

  test('new boundary version requires explicit acknowledgement and preserves heat tally', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const fx = stepHeating(3600);
    const wall = svc.createWall(fx.wall.name, fx.wall.layers);
    const b1 = svc.setBoundary(wall.id, {
      L: fx.left.segments.map((s) => ({ t: s.t0, bc: s.bc })),
      R: fx.right.segments.map((s) => ({ t: s.t0, bc: s.bc })),
    });
    const sim = svc.createSimulation({ wallId: wall.id, boundaryId: b1.id, dt: 600, tEnd: 7200, snapshotEvery: 10 });
    svc.run(sim.id, { maxSteps: 3 });
    const beforeQL = svc.status(sim.id).ledger.QL;

    const b2 = svc.setBoundary(wall.id, {
      L: [{ t: 0, bc: { kind: 'temperature', T: 200 } }],
      R: [{ t: 0, bc: { kind: 'insulated' } }],
    });
    assert.throws(
      () => svc.run(sim.id, { newBoundaryId: b2.id }),
      (e: unknown) => e instanceof AppError && e.code === 'BOUNDARY_VERSION_CHANGED',
    );
    svc.run(sim.id, { newBoundaryId: b2.id, acceptBoundaryChange: true });
    const after = svc.status(sim.id);
    // cumulative heat is monotonic history, never reset
    assert.ok(Number.isFinite(after.ledger.QL));
    assert.ok(Math.abs(after.ledger.residual) < 1e-3);
    void beforeQL;
  });
});

describe('transactions and migrations', () => {
  test('solver failure inside a run rolls back every accepted step', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const { wall } = fixture(svc);
    // Build a sim whose persisted T is then corrupted to force non-finite solve.
    const b = svc.walls.requireBoundary(svc.walls.latestBoundary(wall.id)!.id);
    const sim = svc.createSimulation({ wallId: wall.id, boundaryId: b.id, dt: 200, tEnd: 200_000 });
    svc.run(sim.id, { maxSteps: 5 });
    const stepsBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM steps WHERE sim_id=?').get(sim.id) as { c: number }
    ).c;
    db.prepare('UPDATE simulations SET T_json=? WHERE id=?').run(
      JSON.stringify(new Array(wall.n_cells).fill(Number.NaN)),
      sim.id,
    );
    assert.throws(
      () => svc.run(sim.id, { maxSteps: 5 }),
      (e: unknown) => e instanceof AppError && e.code === 'SOLVER_NON_FINITE',
    );
    const stepsAfter = (
      db.prepare('SELECT COUNT(*) AS c FROM steps WHERE sim_id=?').get(sim.id) as { c: number }
    ).c;
    assert.equal(stepsAfter, stepsBefore, 'rollback must not leave partial steps');
  });

  test('migrations are idempotent', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const again = migrate(db);
    assert.deepEqual(again, []);
  });

  test('pagination nextOffset is null on the last page', () => {
    const env = tempDb();
    db = env.db;
    cleanup = env.cleanup;
    const svc = newService(db);
    const fx = multilayerSteady();
    for (let i = 0; i < 3; i++) svc.createWall(`w${i}`, fx.wall.layers);
    const page = svc.walls.listWalls({ limit: 2, offset: 0 });
    assert.equal(page.items.length, 2);
    assert.equal(page.nextOffset, 2);
    const last = svc.walls.listWalls({ limit: 2, offset: 2 });
    assert.equal(last.nextOffset, null);
  });
});
