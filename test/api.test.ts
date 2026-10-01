import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDb } from './helpers.ts';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { buildApp } from '../src/api/app.js';
import { FakeRuntime } from '../src/db/repo.js';
import type { DatabaseSync } from 'node:sqlite';
import { multilayerSteady } from '../src/fixtures/materials.js';

let server: ReturnType<typeof createServer>;
let base: string;
let db: DatabaseSync;
const env = tempDb();

const fx = multilayerSteady();
const wallBody = { name: 'api-wall', layers: fx.wall.layers };
const boundaryBody = {
  L: fx.left.segments.map((s) => ({ t: s.t0, bc: s.bc })),
  R: fx.right.segments.map((s) => ({ t: s.t0, bc: s.bc })),
};

async function call(method: string, path: string, body?: unknown, idemKey?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json, replay: res.headers.get('Idempotent-Replay') };
}

async function startWith(existingDb: DatabaseSync) {
  const app = buildApp(existingDb, new FakeRuntime(), new FakeRuntime());
  server = createServer(app.listener);
  await new Promise<void>((resolveP) => server.listen(0, '127.0.0.1', () => resolveP()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('HTTP API end to end', () => {
  test('start', async () => {
    db = env.db;
    await startWith(db);
  });

  after(() => {
    server?.close();
    try {
      db?.close();
    } catch {
      // ignore
    }
    env.cleanup();
  });

  test('health', async () => {
    const r = await call('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });

  test('full lifecycle: wall, boundary, run, steps, fluxes, export', async () => {
    const wall = await call('POST', '/api/walls', wallBody);
    assert.equal(wall.status, 200);
    const wallId = wall.json.id;
    const b = await call('POST', `/api/walls/${wallId}/boundaries`, boundaryBody);
    assert.equal(b.status, 200);
    const sim = await call('POST', '/api/simulations', {
      wallId,
      boundaryId: b.json.id,
      dt: 400,
      tEnd: 200_000,
      snapshotEvery: 50,
    });
    assert.equal(sim.status, 200);
    const run = await call('POST', `/api/simulations/${sim.json.id}/run`, {});
    assert.equal(run.status, 200);
    assert.equal(run.json.sim.status, 'finished');

    const steps = await call('GET', `/api/simulations/${sim.json.id}/steps?limit=10&offset=0`);
    assert.equal(steps.status, 200);
    assert.equal(steps.json.items.length, 10);
    assert.equal(typeof steps.json.nextOffset, 'number');

    const fluxes = await call('GET', `/api/simulations/${sim.json.id}/fluxes`);
    assert.equal(fluxes.status, 200);
    const interfaces = fluxes.json.internal.filter((f: { materialInterface: boolean }) => f.materialInterface);
    assert.equal(interfaces.length, 2);

    const exported = await call('POST', `/api/simulations/${sim.json.id}/export-energy`, {
      outFile: `${env.dir}/energy.json`,
    });
    assert.equal(exported.status, 200);
    assert.ok(Math.abs(exported.json.ledger.residual) < 1e-2);
  });

  test('validation error codes for bad properties and times', async () => {
    const badWall = await call('POST', '/api/walls', {
      name: 'bad',
      layers: [{ name: 'a', thickness: 0.1, k: -1, rho: 1, cp: 1, T0: 0, n: 2 }],
    });
    assert.equal(badWall.status, 422);
    assert.equal(badWall.json.error.code, 'NON_POSITIVE_PROPERTY');

    const wall = await call('POST', '/api/walls', wallBody);
    const b = await call('POST', `/api/walls/${wall.json.id}/boundaries`, boundaryBody);
    const badSim = await call('POST', '/api/simulations', {
      wallId: wall.json.id,
      boundaryId: b.json.id,
      dt: 0,
      tEnd: 10,
    });
    assert.equal(badSim.status, 422);
    assert.equal(badSim.json.error.code, 'ILLEGAL_TIME');

    const missing = await call('GET', '/api/walls/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'NOT_FOUND');
  });

  test('idempotent repeated POST replays the same resource', async () => {
    const r1 = await call('POST', '/api/walls', wallBody, 'key-123');
    assert.equal(r1.status, 200);
    const r2 = await call('POST', '/api/walls', wallBody, 'key-123');
    assert.equal(r2.status, 200);
    assert.equal(r2.replay, 'true');
    assert.equal(r2.json.id, r1.json.id);

    const conflict = await call('POST', '/api/walls', { ...wallBody, name: 'different' }, 'key-123');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  test('refinement comparison shows coarse differs from finest', async () => {
    const wall = await call('POST', '/api/walls', wallBody);
    const b = await call('POST', `/api/walls/${wall.json.id}/boundaries`, boundaryBody);
    const cmp = await call('POST', '/api/compare', {
      wallId: wall.json.id,
      boundaryId: b.json.id,
      tEnd: 40000,
      dt: 400,
      cellMultipliers: [1, 2, 4],
    });
    assert.equal(cmp.status, 200);
    assert.equal(cmp.json.rows.length, 3);
    assert.ok(cmp.json.rows[0].errVsFinest > cmp.json.rows[1].errVsFinest);
    assert.equal(cmp.json.rows[2].errVsFinest, 0);
  });

  test('restart on the same database file preserves and resumes state', async () => {
    const wall = await call('POST', '/api/walls', wallBody);
    const b = await call('POST', `/api/walls/${wall.json.id}/boundaries`, boundaryBody);
    const sim = await call('POST', '/api/simulations', {
      wallId: wall.json.id,
      boundaryId: b.json.id,
      dt: 400,
      tEnd: 200_000,
    });
    await call('POST', `/api/simulations/${sim.json.id}/run`, { maxSteps: 20 });

    await new Promise<void>((resolveP) => server.close(() => resolveP()));
    db.close();
    db = openDatabase(env.file);
    migrate(db);
    await startWith(db);

    const status = await call('GET', `/api/simulations/${sim.json.id}`);
    assert.equal(status.json.step, 20);
    assert.equal(status.json.status, 'paused');
    const finish = await call('POST', `/api/simulations/${sim.json.id}/run`, {});
    assert.equal(finish.json.sim.status, 'finished');
  });
});
