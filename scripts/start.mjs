/**
 * Start the API bound to 127.0.0.1 on an OS-assigned free port.
 * Writes data/server.json with host/port/pid. Project-local only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
mkdirSync('data', { recursive: true });

const pidFile = 'data/server.pid';
if (existsSync(pidFile)) {
  const prev = Number(readFileSync(pidFile, 'utf8').trim());
  if (prev && isAlive(prev)) {
    console.error(`already running with pid ${prev} (see data/server.json)`);
    process.exit(1);
  }
  rmSync(pidFile, { force: true });
}

const entry = existsSync('dist/src/api/server.js') ? 'dist/src/api/server.js' : 'src/api/server.ts';
const args = entry.endsWith('.ts')
  ? ['--no-warnings', '--import', 'tsx', 'src/api/server.ts']
  : ['--no-warnings', 'dist/src/api/server.js'];

const child = spawn(process.execPath, args, {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, WALL_DB: process.env.WALL_DB ?? 'data/wall.db' },
});
child.unref();
writeFileSync(pidFile, String(child.pid));

// Wait for data/server.json, then print the endpoint.
const deadline = Date.now() + 10_000;
const timer = setInterval(() => {
  try {
    const info = JSON.parse(readFileSync('data/server.json', 'utf8'));
    if (info.pid === child.pid) {
      clearInterval(timer);
      console.log(`API ready at http://${info.host}:${info.port} (pid ${info.pid})`);
    }
  } catch {
    if (Date.now() > deadline) {
      clearInterval(timer);
      console.error('server did not publish data/server.json in time');
      process.exit(1);
    }
  }
}, 100);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
