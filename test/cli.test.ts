import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cliTs = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const layersFile = fileURLToPath(new URL('../examples/layers.multilayer.json', import.meta.url));

let workdir: string;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], db?: string): Promise<CliResult> {
  const allArgs = db ? [...args, '--db', db] : args;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--no-warnings', '--import', 'tsx', cliTs, ...allArgs],
      { cwd: ROOT },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ? Number(err.code) : 1) : 0, stdout, stderr });
      },
    );
  });
}

function freshDb(label: string): string {
  workdir = join(tmpdir(), `wall-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(join(workdir, 'data'), { recursive: true });
  return join(workdir, 'data', 'cli.db');
}

afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe('CLI', () => {
  test('fixture:demo runs a full case and prints an energy balance', async () => {
    const db = freshDb('demo');
    const r = await runCli(['fixture:demo', '--name', 'convection', '--dt', '30', '--t-end', '3000'], db);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fixture convection/);
    assert.match(r.stdout, /status=finished/);
    assert.match(r.stdout, /residual=/);
    assert.ok(existsSync(db));
  });

  test('wall -> boundary -> create -> pause -> resume -> flux -> export lifecycle', async () => {
    const db = freshDb('life');
    const created = await runCli(['wall:create', '--file', layersFile], db);
    assert.equal(created.code, 0, created.stderr);
    const wallId = created.stdout.match(/wall (\S+) /)![1];

    const bcFile = fileURLToPath(new URL('../examples/boundary.step.json', import.meta.url));
    const bset = await runCli(['boundary:set', '--wall', wallId, '--file', bcFile], db);
    assert.equal(bset.code, 0, bset.stderr);
    const boundaryId = bset.stdout.match(/boundary (\S+) v/)![1];

    const simc = await runCli(
      ['sim:create', '--wall', wallId, '--boundary', boundaryId, '--dt', '400', '--t-end', '200000'],
      db,
    );
    assert.equal(simc.code, 0, simc.stderr);
    const simId = simc.stdout.match(/simulation (\S+):/)![1];

    const part = await runCli(['sim:run', '--id', simId, '--steps', '10'], db);
    assert.equal(part.code, 0, part.stderr);
    assert.match(part.stdout, /status=paused/);

    const rest = await runCli(['sim:run', '--id', simId], db);
    assert.equal(rest.code, 0, rest.stderr);
    assert.match(rest.stdout, /status=finished/);

    const flux = await runCli(['flux', '--id', simId], db);
    assert.equal(flux.code, 0, flux.stderr);
    assert.match(flux.stdout, /INTERFACE foamLight\|brickLite/);

    const outFile = join(workdir, 'ledger.json');
    const exported = await runCli(['energy:export', '--id', simId, '--out', outFile], db);
    assert.equal(exported.code, 0, exported.stderr);
    assert.ok(existsSync(outFile));
  });

  test('compare reports refinement differences and event split times', async () => {
    const db = freshDb('cmp');
    const created = await runCli(['wall:create', '--name', 'step', '--file', layersFile], db);
    const wallId = created.stdout.match(/wall (\S+) /)![1];
    await runCli(['boundary:set', '--wall', wallId, '--fixture', 'step'], db);
    const r = await runCli(
      ['compare', '--wall', wallId, '--t-end', '7200', '--dts', '600,300,150', '--multipliers', '1,2,4'],
      db,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /errVsFinest=/);
    assert.match(r.stdout, /coarse is NOT exact/);
    assert.match(r.stdout, /split at event times 3600/);
  });

  test('non-positive property fails with an explicit error code', async () => {
    const db = freshDb('bad');
    const badFile = join(workdir, 'bad.json');
    writeFileSync(
      badFile,
      JSON.stringify({ layers: [{ name: 'a', thickness: 0.1, k: -2, rho: 1, cp: 1, T0: 0, n: 2 }] }),
    );
    const r = await runCli(['wall:create', '--file', badFile], db);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[NON_POSITIVE_PROPERTY\]/);
  });
});
