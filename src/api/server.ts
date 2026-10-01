import { type AddressInfo } from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { openDatabase } from '../db/client.ts';
import { Repo } from '../db/repo.ts';
import { ConductionService } from '../core/service.ts';
import { createHandler } from './http.ts';

const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
const dbPath = process.env.DB_PATH ?? join(projectRoot, 'data', 'walls.db');
const pidPath = process.env.PID_PATH ?? join(projectRoot, 'data', 'server.pid');

mkdirSync(join(projectRoot, 'data'), { recursive: true });

const handle = openDatabase(dbPath);
const repo = new Repo(handle.db);
const service = new ConductionService(repo);

const server = http.createServer(createHandler(service));

function shutdown(): void {
  server.close(() => {
    handle.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  writeFileSync(pidPath, String(process.pid));
  const line = JSON.stringify({ listening: '127.0.0.1', port, dbPath, pid: process.pid });
  process.stdout.write(line + '\n');
});

export { server };
