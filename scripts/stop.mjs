/**
 * Stop ONLY the project API process recorded in data/server.pid /
 * data/server.json. Never touches unrelated processes.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);

let pid = null;
if (existsSync('data/server.pid')) pid = Number(readFileSync('data/server.pid', 'utf8').trim());
if ((!pid || !Number.isInteger(pid)) && existsSync('data/server.json')) {
  pid = JSON.parse(readFileSync('data/server.json', 'utf8')).pid;
}

if (!pid) {
  console.log('no running project API recorded (data/server.pid missing)');
  process.exit(0);
}
try {
  process.kill(pid, 'SIGTERM');
  console.log(`sent SIGTERM to project API pid ${pid}`);
} catch (e) {
  if (e.code === 'ESRCH') console.log(`pid ${pid} already stopped`);
  else throw e;
}
rmSync('data/server.pid', { force: true });
