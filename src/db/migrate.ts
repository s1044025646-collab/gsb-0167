import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Apply every *.sql migration in src/db/migrations exactly once.
 * Safe to run repeatedly; also re-run automatically on server start.
 */
export function migrate(db: DatabaseSync): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at REAL NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolve migrations from tsx layout (src/db) and compiled layout
  // (dist/src/db, with copied assets).
  const candidates = [
    join(here, 'migrations'),
    join(here, '..', '..', '..', 'src', 'db', 'migrations'),
  ];
  const dir = candidates.find((d) => safeExists(d)) ?? candidates[0];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const tx = db.exec.bind(db);
    void tx;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now() / 1000);
      db.exec('COMMIT');
      done.push(f);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return done;
}

import { existsSync, readFileSync } from 'node:fs';
function safeExists(d: string): boolean {
  return existsSync(d);
}
