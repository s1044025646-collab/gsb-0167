import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const pairs = [
  ['src/db/migrations', 'dist/src/db/migrations'],
];
for (const [from, to] of pairs) {
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}
