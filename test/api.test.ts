import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../src/db/client.ts';
import { Repo } from '../src/db/repo.ts';
import { ConductionService } from '../src/core/service.ts';
import { createHandler } from '../src/api/http.ts';
import { fixture } from './helpers.ts';
import { encodeJson } from '../src/core/json.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(process.cwd(), 'data', 'api-'));
const handle = openDatabase(join(dir, 'api.db'));
const service = new ConductionService(new Repo(handle.db));

const server = http.createServer(createHandler(service));
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.close();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : encodeJson(body);
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('health', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('full end-to-end via API with pagination and idempotency', async () => {
  const f = fixture('convection-cooling');
  const created = await call('POST', '/api/walls', { name: 'w', layers: f.layers });
  assert.equal(created.status, 201);
  const wallId = created.json.id;

  const sim = await call('POST', '/api/simulations', {
    wallId,
    name: 's',
    initialTemperature: f.initialTemperature,
    left: f.left,
    right: f.right,
  });
  assert.equal(sim.status, 201);
  const simId = sim.json.id;

  const c1 = await call(
    'POST',
    `/api/simulations/${simId}/compute`,
    { targetTime: 500, maxDt: 25 },
    { 'idempotency-key': 'abc' },
  );
  assert.equal(c1.status, 200);
  assert.equal(c1.json.replayed, false);

  const c2 = await call(
    'POST',
    `/api/simulations/${simId}/compute`,
    { targetTime: 9999, maxDt: 1 },
    { 'idempotency-key': 'abc' },
  );
  assert.equal(c2.json.replayed, true);
  assert.deepEqual(c2.json.final, c1.json.final);
  assert.equal(c2.json.stepsAdded, c1.json.stepsAdded);

  const page = await call('GET', `/api/simulations/${simId}/steps?limit=5&offset=0`);
  assert.equal(page.status, 200);
  assert.equal(page.json.items.length, 5);
  assert.ok(page.json.total >= 20);

  const ledger = await call('GET', `/api/simulations/${simId}/ledger`);
  assert.equal(ledger.status, 200);
  assert.ok(Math.abs(ledger.json.maxStepEnergyResidual) < 1e-3);

  const interfaces = await call('GET', `/api/simulations/${simId}/interfaces`);
  assert.equal(interfaces.status, 200);
  assert.equal(interfaces.json.internal.length, f.layers[0].cells - 1);
});

test('validation failures return explicit error codes', async () => {
  const bad = await call('POST', '/api/walls', {
    name: 'bad',
    layers: [{ name: 'x', thickness: 0, conductivity: 1, density: 1, specificHeat: 1, cells: 4 }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'NON_POSITIVE_PROPERTY');

  const badTime = await call('POST', '/api/walls/1/simulations', {});
  assert.equal(badTime.status, 404);

  const missing = await call('GET', '/api/walls/9999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  const badPage = await call('GET', '/api/walls?limit=99999');
  assert.equal(badPage.status, 400);
  assert.equal(badPage.json.error.code, 'VALIDATION');
});

test('material modification blocks further compute with 409', async () => {
  const f = fixture('both-fixed');
  const wall = await call('POST', '/api/walls', { name: 'w2', layers: f.layers });
  const sim = await call('POST', '/api/simulations', {
    wallId: wall.json.id,
    name: 's2',
    initialTemperature: f.initialTemperature,
    left: f.left,
    right: f.right,
  });
  await call('POST', `/api/simulations/${sim.json.id}/compute`, { targetTime: 10, maxDt: 5 });
  service['repo'].db
    .prepare('UPDATE walls SET material_version = ? WHERE id = ?')
    .run('changed', wall.json.id);
  const blocked = await call('POST', `/api/simulations/${sim.json.id}/compute`, {
    targetTime: 20,
    maxDt: 5,
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'MATERIAL_MODIFIED');
});
