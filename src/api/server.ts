import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDatabase } from '../db/migrate.js';
import { buildApp } from './app.js';

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Bind to 127.0.0.1 only. Port 0 lets the OS assign a free port; the chosen
 * port is written to data/server.json so the CLI/demo can find it.
 */
export async function startServer(dbFile = process.env.WALL_DB ?? 'data/wall.db'): Promise<StartedServer> {
  mkdirSync('data', { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db);
  const { listener } = buildApp(db);
  const server = createServer(listener);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');
  const port = addr.port;
  writeFileSync(join('data', 'server.json'), JSON.stringify({ host: '127.0.0.1', port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  console.log(`[wall] API listening on http://127.0.0.1:${port} (pid ${process.pid}), db ${dbFile}`);

  const close = () =>
    new Promise<void>((resolveClose) => {
      server.close(() => {
        db.close();
        resolveClose();
      });
    });
  return { server, port, close };
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
})();

if (isMain) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
