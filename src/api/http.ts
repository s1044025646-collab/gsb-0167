import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConductionService } from '../core/service.ts';
import { parseId, parsePagination } from '../core/service.ts';
import { AppError } from '../core/errors.ts';
import { decodeJson } from '../core/json.ts';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION: 400,
  NON_POSITIVE_PROPERTY: 400,
  ILLEGAL_TIME: 400,
  THICKNESS_MISMATCH: 400,
  NON_FINITE: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  MATERIAL_MODIFIED: 409,
  IDEMPOTENCY_REPLAY: 200,
};

export function createHandler(service: ConductionService) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url as string, 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      // Walls
      if (method === 'POST' && path === '/api/walls') {
        const body = await readJson(req);
        const wall = service.createWall(body.name, body.layers);
        return sendJson(res, 201, wall);
      }
      if (method === 'GET' && path === '/api/walls') {
        const { limit, offset } = parsePagination({
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
        });
        return sendJson(res, 200, service.listWalls(limit, offset));
      }
      {
        const m = path.match(/^\/api\/walls\/(\d+)$/);
        if (m && method === 'GET') {
          return sendJson(res, 200, service.getWall(parseId(m[1], 'id')));
        }
      }

      // Simulations
      if (method === 'POST' && path === '/api/simulations') {
        const body = await readJson(req);
        const sim = service.createSimulation(
          body.wallId,
          body.name,
          body.initialTemperature,
          body.left,
          body.right,
        );
        return sendJson(res, 201, sim);
      }
      if (method === 'GET' && path === '/api/simulations') {
        const { limit, offset } = parsePagination({
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
        });
        const wallId = url.searchParams.get('wallId');
        return sendJson(
          res,
          200,
          service.listSimulations(wallId === null ? null : parseId(wallId, 'wallId'), limit, offset),
        );
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)$/);
        if (m && method === 'GET') {
          return sendJson(res, 200, service.getSimulation(parseId(m[1], 'id')));
        }
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)\/compute$/);
        if (m && method === 'POST') {
          const body = await readJson(req);
          const key = (req.headers['idempotency-key'] as string | undefined) ?? body.idempotencyKey;
          const result = service.compute(parseId(m[1], 'id'), {
            targetTime: body.targetTime,
            maxDt: body.maxDt,
            idempotencyKey: key,
          });
          return sendJson(res, 200, result);
        }
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)\/state$/);
        if (m && method === 'GET') {
          return sendJson(res, 200, service.state(parseId(m[1], 'id')));
        }
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)\/interfaces$/);
        if (m && method === 'GET') {
          return sendJson(res, 200, service.interfaceFluxes(parseId(m[1], 'id')));
        }
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)\/ledger$/);
        if (m && method === 'GET') {
          return sendJson(res, 200, service.ledger(parseId(m[1], 'id')));
        }
      }
      {
        const m = path.match(/^\/api\/simulations\/(\d+)\/steps$/);
        if (m && method === 'GET') {
          const { limit, offset } = parsePagination({
            limit: url.searchParams.get('limit'),
            offset: url.searchParams.get('offset'),
          });
          return sendJson(res, 200, service.listSteps(parseId(m[1], 'id'), limit, offset));
        }
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, STATUS_BY_CODE[err.code] ?? 500, {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      sendJson(res, 500, {
        error: { code: 'INTERNAL', message: (err as Error).message },
      });
    }
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return decodeJson(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new AppError('VALIDATION', 'request body must be valid JSON');
    throw err;
  }
}
