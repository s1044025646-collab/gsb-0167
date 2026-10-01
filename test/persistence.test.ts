import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimFromFixture, fixture, makeHarness, type Harness } from './helpers.ts';
import { AppError } from '../src/core/errors.ts';
import { openDatabase } from '../src/db/client.ts';
import { Repo } from '../src/db/repo.ts';
import { ConductionService, type Clock } from '../src/core/service.ts';

test('pause/resume preserves time, full temperature vector and cumulative heat', () => {
  const h = makeHarness();
  try {
    const { simId } = createSimFromFixture(h.service, 'convection-cooling');
    const first = h.service.compute(simId, { targetTime: 1000, maxDt: 20 });
    const mid = h.service.state(simId);

    // second compute call resumes and accumulates rather than restarting
    const second = h.service.compute(simId, { targetTime: 2000, maxDt: 20 });
    const end = h.service.state(simId);
    assert.equal(end.time, 2000);
    assert.ok(Math.abs(end.cumulativeHeatIn - second.ledger.cumulativeHeatIn) < 1e-9);
    assert.ok(Math.abs(end.cumulativeHeatIn) >= Math.abs(mid.cumulativeHeatIn));
    assert.equal(end.temperatures.length, mid.temperatures.length);
    assert.equal(first.stepsAdded + second.stepsAdded, second.ledger.steps);
  } finally {
    h.close();
  }
});

test('cumulative heat is not lost across process restart (reopen database)', () => {
  const h = makeHarness();
  let simId = 0;
  try {
    const created = createSimFromFixture(h.service, 'multilayer-resistance');
    simId = created.simId;
    h.service.compute(simId, { targetTime: 500, maxDt: 25 });
    const beforeClose = h.service.state(simId);
    h.handle.close();

    const reopened = openDatabase(h.dbPath);
    try {
      const repo2 = new Repo(reopened.db);
      const svc2 = new ConductionService(repo2, { now: () => 123 } as Clock);
      const afterOpen = svc2.state(simId);
      assert.equal(afterOpen.time, beforeClose.time);
      assert.deepEqual(afterOpen.temperatures, beforeClose.temperatures);
      assert.ok(Math.abs(afterOpen.cumulativeHeatIn - beforeClose.cumulativeHeatIn) < 1e-9);
      const continued = svc2.compute(simId, { targetTime: 1000, maxDt: 25 });
      assert.equal(continued.final?.time, 1000);
    } finally {
      reopened.close();
    }
  } finally {
    h.close();
  }
});

test('resume is refused when the wall materials were modified after snapshot', () => {
  const h = makeHarness();
  try {
    const f = fixture('convection-cooling');
    const wall = h.service.createWall('w', f.layers);
    const sim = h.service.createSimulation(wall.id, 's', f.initialTemperature, f.left, f.right);
    // Tamper with material definition while keeping the same wall id.
    const tampered = f.layers.map((l) => ({ ...l, conductivity: l.conductivity * 10 }));
    h.repo.db
      .prepare('UPDATE walls SET layers_json = ?, material_version = ? WHERE id = ?')
      .run(JSON.stringify(tampered), 'tampered-version', wall.id);
    assert.throws(
      () => h.service.compute(sim.id, { targetTime: 10, maxDt: 1 }),
      (e: Error) => e instanceof AppError && e.code === 'MATERIAL_MODIFIED',
    );
  } finally {
    h.close();
  }
});

test('repeated compute with the same idempotency key replays and adds no steps', () => {
  const h = makeHarness();
  try {
    const { simId } = createSimFromFixture(h.service, 'both-fixed');
    const a = h.service.compute(simId, { targetTime: 100, maxDt: 10, idempotencyKey: 'k-1' });
    const stepsAfterA = a.ledger.steps;
    const b = h.service.compute(simId, { targetTime: 999, maxDt: 3, idempotencyKey: 'k-1' });
    assert.equal(b.replayed, true);
    assert.deepEqual(b.final, a.final);
    assert.equal(b.ledger.steps, stepsAfterA);
  } finally {
    h.close();
  }
});

test('failed append rolls back without advancing simulation state', () => {
  const h = makeHarness();
  try {
    const { simId } = createSimFromFixture(h.service, 'both-fixed');
    h.service.compute(simId, { targetTime: 50, maxDt: 10 });
    const steps = h.repo.listSteps(simId, 500, 0).total;

    // Make step insertion fail mid-transaction while leaving the table present.
    h.repo.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON sim_steps
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    assert.throws(() => h.service.compute(simId, { targetTime: 100, maxDt: 10 }), /injected failure/);

    const sim = h.repo.getSimulation(simId);
    assert.equal(sim.time, 50);
    assert.equal(h.repo.listSteps(simId, 500, 0).total, steps);
    // A subsequent valid compute still works (no poisoned transaction state).
    h.repo.db.exec('DROP TRIGGER fail_insert');
    const ok = h.service.compute(simId, { targetTime: 100, maxDt: 10 });
    assert.equal(ok.final?.time, 100);
  } finally {
    h.close();
  }
});

test('step pagination works', () => {
  const h: Harness = makeHarness();
  try {
    const { simId } = createSimFromFixture(h.service, 'both-fixed');
    h.service.compute(simId, { targetTime: 100, maxDt: 5 });
    const page1 = h.service.listSteps(simId, 10, 0);
    const page2 = h.service.listSteps(simId, 10, 10);
    assert.equal(page1.items.length, 10);
    assert.equal(page1.items[0].seq, 1);
    assert.equal(page2.items[0].seq, 11);
    assert.equal(page1.total, 20);
  } finally {
    h.close();
  }
});
