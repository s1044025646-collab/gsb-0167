import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { FakeRuntime } from '../src/db/repo.js';
import { SimService } from '../src/services/simService.js';
import type { DatabaseSync } from 'node:sqlite';

let counter = 0;

export function tempDb(): { db: DatabaseSync; file: string; dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `wall-test-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'test.db');
  const db = openDatabase(file);
  migrate(db);
  return {
    db,
    file,
    dir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed (e.g. reopen-style tests)
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function newService(db: DatabaseSync): SimService {
  return new SimService(db, new FakeRuntime(), new FakeRuntime());
}

export function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * (1 + Math.max(Math.abs(a), Math.abs(b)));
}
