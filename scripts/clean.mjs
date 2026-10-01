/**
 * Remove project-local runtime data only (./data). Never touches anything
 * outside this project. Keeps nothing by default; demo regenerates it.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'data');
if (!target.startsWith(root)) throw new Error('refusing to clean outside project');
rmSync(target, { recursive: true, force: true });
console.log(`removed ${target}`);
