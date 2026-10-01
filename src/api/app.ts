import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { AppError, type ErrorCode } from '../core/errors.js';
import { parsePage, type Clock, type Ids, contentHash } from '../db/repo.js';
import { SimService } from '../services/simService.js';
import { compareStored } from '../services/compare.js';

type Handler = (body: any, query: URLSearchParams, svc: SimService, db: DatabaseSync) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (params: Record<string, string>, body: any, query: URLSearchParams, svc: SimService, db: DatabaseSync) => unknown | Promise<unknown>;
}

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NON_POSITIVE_PROPERTY: 422,
  THICKNESS_MISMATCH: 422,
  ILLEGAL_TIME: 422,
  BAD_GRID: 422,
  BAD_BOUNDARY: 422,
  SOLVER_NON_FINITE: 422,
  NOT_FOUND: 404,
  MATERIAL_CHANGED: 409,
  BOUNDARY_VERSION_CHANGED: 409,
  SIM_FINISHED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONFLICT: 409,
  INTERNAL: 500,
};

function route(method: string, path: string, handler: Route['handler']): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  return { method, pattern, keys, handler };
}

export function buildApp(db: DatabaseSync, clock?: Clock, ids?: Ids) {
  const svc = new SimService(db, clock, ids);

  const routes: Route[] = [
    route('POST', '/api/walls', (_p, b) => svc.createWall(required(b, 'name', 'string'), requireLayers(b))),
    route('GET', '/api/walls', (_p, _b, q) => svc.walls.listWalls(parsePage(Object.fromEntries(q)))),
    route('GET', '/api/walls/:id', (p) => svc.walls.requireWall(p.id)),
    route('PUT', '/api/walls/:id', (p, b) =>
      svc.updateWall(p.id, typeof b.name === 'string' ? b.name : undefined, requireLayers(b))),
    route('POST', '/api/walls/:id/boundaries', (p, b) =>
      svc.setBoundary(p.id, requireHistory(b))),
    route('GET', '/api/walls/:id/boundaries', (p, _b, q) =>
      svc.walls.listBoundaries(p.id, parsePage(Object.fromEntries(q)))),
    route('POST', '/api/simulations', (_p, b) =>
      svc.createSimulation({
        wallId: required(b, 'wallId', 'string'),
        boundaryId: typeof b.boundaryId === 'string' ? b.boundaryId : undefined,
        dt: numberField(b, 'dt'),
        tEnd: numberField(b, 'tEnd'),
        snapshotEvery: b.snapshotEvery,
      })),
    route('GET', '/api/simulations', (_p, _b, q) =>
      svc.walls.listSimulations(parsePage(Object.fromEntries(q)), (q.get('wallId') ?? undefined) as string | undefined)),
    route('GET', '/api/simulations/:id', (p) => svc.status(p.id)),
    route('POST', '/api/simulations/:id/run', (p, b) =>
      svc.run(p.id, {
        maxSteps: optionalInt(b, 'maxSteps'),
        acceptBoundaryChange: Boolean(b?.acceptBoundaryChange),
        newBoundaryId: typeof b?.newBoundaryId === 'string' ? b.newBoundaryId : undefined,
      })),
    route('GET', '/api/simulations/:id/steps', (p, _b, q) =>
      svc.listSteps(p.id, parsePage(Object.fromEntries(q)))),
    route('GET', '/api/simulations/:id/snapshots', (p, _b, q) =>
      svc.listSnapshots(p.id, parsePage(Object.fromEntries(q)))),
    route('GET', '/api/simulations/:id/fluxes', (p) => svc.interfaceFluxes(p.id)),
    route('POST', '/api/simulations/:id/export-energy', (p, b) =>
      svc.exportEnergy(p.id, typeof b?.outFile === 'string' ? b.outFile : `data/energy-${p.id}.json`)),
    route('POST', '/api/compare', (_p, b) =>
      compareStored(
        db,
        required(b, 'wallId', 'string'),
        typeof b.boundaryId === 'string' ? b.boundaryId : undefined,
        numberField(b, 'tEnd'),
        // Allow either a single dt (reused across variants) or dt list.
        Array.isArray(b.dt) ? numberArray(b, 'dt') : [numberField(b, 'dt')],
        numberArray(b, 'cellMultipliers').map((n) => Math.round(n)),
      )),
  ];

  async function listener(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return send(res, 200, { ok: true });
      }
      const body = await readJson(req);
      const found = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!found) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
      const match = url.pathname.match(found.pattern)!;
      const params = Object.fromEntries(found.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));

      // Idempotency: replay stored response for identical repeated POST/PUT.
      const idemKey = req.headers['idempotency-key'];
      if (typeof idemKey === 'string' && idemKey.length > 0 && (req.method === 'POST' || req.method === 'PUT')) {
        const existing = svc.walls.idempotencyGet(idemKey);
        const reqHash = contentHash({ path: url.pathname, body });
        if (existing) {
          if (existing.request_hash !== reqHash) {
            throw new AppError('IDEMPOTENCY_CONFLICT', 'same Idempotency-Key reused with a different request');
          }
          res.setHeader('Idempotent-Replay', 'true');
          return send(res, existing.status_code as number, JSON.parse(existing.response_json as string));
        }
        const result = await found.handler(params, body, url.searchParams, svc, db);
        persistIdempotency(db, idemKey, reqHash, result, 200);
        return send(res, 200, result);
      }

      const result = await found.handler(params, body, url.searchParams, svc, db);
      return send(res, 200, result);
    } catch (e) {
      if (e instanceof AppError) {
        return send(res, statusByCode[e.code] ?? 500, { error: { code: e.code, message: e.message, details: e.details } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  }

  return { listener, svc };
}

function persistIdempotency(db: DatabaseSync, key: string, reqHash: string, result: unknown, status: number) {
  db.prepare(
    `INSERT INTO idempotency_keys (key, request_hash, resource_type, resource_id, status_code, response_json, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(key, reqHash, 'response', '', status, JSON.stringify(result ?? null), Date.now() / 1000);
}

function send(res: ServerResponse, code: number, payload: unknown) {
  const json = JSON.stringify(payload, replacer);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function replacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? Number(v) : v;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new AppError('VALIDATION', 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function required(b: any, field: string, type: 'string'): string {
  if (!b || typeof b[field] !== type || (b[field] as string).length === 0) {
    throw new AppError('VALIDATION', `field "${field}" is required and must be a non-empty ${type}`);
  }
  return b[field];
}

function numberField(b: any, field: string): number {
  if (!b || typeof b[field] !== 'number' || !Number.isFinite(b[field])) {
    throw new AppError('VALIDATION', `field "${field}" must be a finite number`);
  }
  return b[field];
}

function optionalInt(b: any, field: string): number | undefined {
  if (!b || b[field] === undefined) return undefined;
  if (!Number.isInteger(b[field])) throw new AppError('VALIDATION', `field "${field}" must be an integer`);
  return b[field];
}

function numberArray(b: any, field: string): number[] {
  if (!b || !Array.isArray(b[field]) || b[field].length === 0) {
    throw new AppError('VALIDATION', `field "${field}" must be a non-empty number array`);
  }
  for (const n of b[field]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new AppError('VALIDATION', `field "${field}" must contain finite numbers`);
    }
  }
  return b[field];
}

function requireLayers(b: any) {
  if (!b || !Array.isArray(b.layers) || b.layers.length === 0) {
    throw new AppError('VALIDATION', 'field "layers" must be a non-empty array');
  }
  return b.layers;
}

function requireHistory(b: any) {
  if (!b || !Array.isArray(b.L) || !Array.isArray(b.R)) {
    throw new AppError('VALIDATION', 'boundary body needs L and R event arrays');
  }
  return { L: b.L, R: b.R };
}

export { createHash };
