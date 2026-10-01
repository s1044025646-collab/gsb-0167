/** Stop a server started by npm start, using the project-local pid file. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pidPath = process.env.PID_PATH ?? join(process.cwd(), 'data', 'server.pid');
if (!existsSync(pidPath)) {
  process.stdout.write('no pid file; server is not running under this project\n');
  process.exit(0);
}
const pid = Number(readFileSync(pidPath, 'utf8').trim());
try {
  process.kill(pid, 'SIGTERM');
  process.stdout.write(`sent SIGTERM to project server pid ${pid}\n`);
} catch (err) {
  process.stdout.write(`process ${pid} not running; removing stale pid file\n`);
} finally {
  rmSync(pidPath, { force: true });
}
