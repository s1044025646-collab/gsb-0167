import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DbHandle } from '../src/db/client.ts';
import { Repo } from '../src/db/repo.ts';
import { ConductionService, type Clock } from '../src/core/service.ts';
import { FIXTURES } from '../src/core/fixtures.ts';

export interface Harness {
  dir: string;
  dbPath: string;
  handle: DbHandle;
  repo: Repo;
  service: ConductionService;
  close: () => void;
}

export function makeHarness(now = 1_700_000_000_000): Harness {
  const dir = mkdtempSync(join(process.cwd(), 'data', 'test-'));
  const dbPath = join(dir, 'walls.db');
  const handle = openDatabase(dbPath);
  const repo = new Repo(handle.db);
  let t = now;
  const clock: Clock = { now: () => t++ };
  const service = new ConductionService(repo, clock);
  return {
    dir,
    dbPath,
    handle,
    repo,
    service,
    close: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function fixture(key: string) {
  const f = FIXTURES.find((x) => x.key === key);
  if (!f) throw new Error(`missing fixture ${key}`);
  return f.build();
}

export function createSimFromFixture(
  service: ConductionService,
  key: string,
  name = key,
): { wallId: number; simId: number } {
  const f = fixture(key);
  const wall = service.createWall(name, f.layers);
  const sim = service.createSimulation(wall.id, name, f.initialTemperature, f.left, f.right);
  return { wallId: wall.id, simId: sim.id };
}
