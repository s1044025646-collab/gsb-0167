#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, openDatabase } from '../db/migrate.js';
import { SimService } from '../services/simService.js';
import { compareVariants } from '../services/compare.js';
import { buildGrid } from '../core/grid.js';
import { AppError } from '../core/errors.js';
import {
  convectionCooling,
  multilayerSteady,
  stepHeating,
  twoEndsConstant,
  uniformInsulated,
} from '../fixtures/materials.js';
import type { BoundaryHistory, LayerSpec } from '../core/types.js';
import type { BoundaryEventsInput } from '../db/repo.js';

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const FIXTURES: Record<
  string,
  () => { wall: { name: string; layers: LayerSpec[] }; left: BoundaryHistory; right: BoundaryHistory }
> = {
  insulated: uniformInsulated,
  ends: twoEndsConstant,
  multilayer: multilayerSteady,
  convection: convectionCooling,
  step: stepHeating,
};

function historyFromFixture(name: string): BoundaryEventsInput {
  const fx = FIXTURES[name];
  if (!fx) throw new AppError('VALIDATION', `unknown fixture ${name}`);
  const f = fx();
  const toEvents = (h: BoundaryHistory) => h.segments.map((s) => ({ t: s.t0, bc: s.bc }));
  return { L: toEvents(f.left), R: toEvents(f.right) };
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  const dbFile = flags.db ?? 'data/wall.db';
  mkdirSync('data', { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db);
  const svc = new SimService(db);

  try {
    switch (cmd) {
      case 'help':
        printHelp();
        break;

      case 'init-db': {
        console.log('before: applying any pending schema migrations');
        const applied = migrate(db);
        console.log(
          `after: ${applied.length === 0 ? 'already up to date' : 'applied ' + applied.join(', ')} (${dbFile})`,
        );
        break;
      }

      case 'wall:create': {
        const spec = readJsonFile(required(flags, 'file', '--file <layers.json>'));
        const name = flags.name ?? spec.name ?? 'wall';
        const layers = (spec.layers ?? spec) as LayerSpec[];
        const grid0 = buildGrid(layers);
        console.log(
          `before: layers=${layers.length}, total thickness=${grid0.totalThickness.toFixed(4)} m, cells=${grid0.n}`,
        );
        const wall = svc.createWall(name, layers);
        console.log(
          `after: wall ${wall.id} "${wall.name}" v${wall.version} hash=${wall.material_hash.slice(0, 10)} cells=${wall.n_cells}`,
        );
        break;
      }

      case 'wall:show': {
        const wall = svc.walls.requireWall(required(flags, 'id', '--id <wallId>'));
        const grid = buildGrid(wall.layers);
        console.log(`wall ${wall.id} "${wall.name}" v${wall.version} L=${wall.thickness} cells=${wall.n_cells}`);
        for (const l of wall.layers) {
          console.log(
            `  ${l.name}: L=${l.thickness} k=${l.k} rho=${l.rho} cp=${l.cp} T0=${l.T0} n=${l.n}`,
          );
        }
        console.log(`material interfaces: ${grid.faces.filter((f) => f.isMaterialInterface).length}`);
        break;
      }

      case 'wall:list': {
        const page = svc.walls.listWalls({
          limit: Number(flags.limit ?? 50),
          offset: Number(flags.offset ?? 0),
        });
        console.log(`walls from offset=${page.offset} nextOffset=${page.nextOffset}`);
        for (const w of page.items) {
          console.log(`  ${w.id} v${w.version} "${w.name}" cells=${w.n_cells}`);
        }
        break;
      }

      case 'boundary:set': {
        const wallId = required(flags, 'wall', '--wall <wallId>');
        const beforeB = svc.walls.latestBoundary(wallId);
        console.log(`before: ${beforeB ? `boundary v${beforeB.version}` : 'no boundary set'}`);
        const history = flags.fixture
          ? historyFromFixture(flags.fixture)
          : (readJsonFile(required(flags, 'file', '--file <boundary.json> or --fixture')) as BoundaryEventsInput);
        const b = svc.setBoundary(wallId, history);
        console.log(
          `after: boundary ${b.id} v${b.version} for wall ${wallId} hash=${b.history_hash.slice(0, 10)}`,
        );
        break;
      }

      case 'sim:create': {
        const sim = svc.createSimulation({
          wallId: required(flags, 'wall', '--wall <wallId>'),
          boundaryId: flags.boundary,
          dt: num(flags, 'dt'),
          tEnd: num(flags, 't-end'),
          snapshotEvery: flags['snapshot-every'] ? Number(flags['snapshot-every']) : undefined,
        });
        console.log(
          `simulation ${sim.id}: wall=${sim.wall_id} dt=${sim.dt} tEnd=${sim.t_end} status=${sim.status} t=0/${sim.t_end}`,
        );
        break;
      }

      case 'sim:run': {
        const id = required(flags, 'id', '--id <simId>');
        const before = svc.status(id);
        console.log(
          `before: t=${before.t.toFixed(3)}/${before.tEnd} step=${before.step} status=${before.status} residual=${before.ledger.residual.toExponential(3)}`,
        );
        const out = svc.run(id, {
          maxSteps: flags.steps ? Number(flags.steps) : undefined,
          acceptBoundaryChange: flags['accept-boundary'] === 'true',
          newBoundaryId: flags.boundary,
        });
        const after = svc.status(id);
        console.log(
          `after: ran ${out.stepsRun} steps, t=${after.t.toFixed(3)}/${after.tEnd} step=${after.step} status=${after.status}`,
        );
        console.log(
          `energy [J/m2]: QL=${after.ledger.QL.toFixed(6)} QR=${after.ledger.QR.toFixed(6)} dU=${after.ledger.dU.toFixed(6)} residual=${after.ledger.residual.toExponential(3)}`,
        );
        break;
      }

      case 'sim:status': {
        const s = svc.status(required(flags, 'id', '--id <simId>'));
        console.log(`sim ${s.id}: t=${s.t}/${s.tEnd} step=${s.step} status=${s.status}`);
        console.log(
          `ledger: QL=${s.ledger.QL} QR=${s.ledger.QR} dU=${s.ledger.dU} residual=${s.ledger.residual}`,
        );
        break;
      }

      case 'flux': {
        const f = svc.interfaceFluxes(required(flags, 'id', '--id <simId>'));
        console.log(`fluxes at t=${f.t} (${f.convention})`);
        console.log(`  L face q_in=${f.qLInto.toFixed(6)}  R face q_in=${f.qRInto.toFixed(6)} W/m2`);
        for (const face of f.internal) {
          const tag = face.materialInterface ? `INTERFACE ${face.layerL}|${face.layerR}` : '';
          console.log(`  face@${face.x.toFixed(4)} q(+x)=${face.q.toFixed(6)} ${tag}`);
        }
        break;
      }

      case 'compare': {
        const wall = svc.walls.requireWall(required(flags, 'wall', '--wall <wallId>'));
        const b = flags.boundary
          ? svc.walls.requireBoundary(flags.boundary)
          : svc.walls.latestBoundary(wall.id);
        if (!b) throw new AppError('NOT_FOUND', 'no boundary set');
        const tEnd = num(flags, 't-end');
        const fallbackDt = flags.dt ? Number(flags.dt) : 60;
        const mults = (flags.multipliers ?? '1,2,4').split(',').map(Number);
        const dts = (flags.dts ?? String(fallbackDt)).split(',').map(Number).reverse();
        const variants = mults.map((m, i) => ({
          label: `x${m}`,
          cellsMultiplier: m,
          dt: dts[Math.min(i, dts.length - 1)],
        }));
        const report = compareVariants(wall.layers, b.history, tEnd, variants);
        console.log(`refinement vs finest="${report.finestLabel}" (coarse is NOT exact):`);
        for (const row of report.rows) {
          console.log(
            `  ${row.label.padEnd(6)} n=${String(row.nCells).padStart(4)} dt=${row.dt} steps=${row.steps} Tcenter=${row.Tcenter.toFixed(6)} errVsFinest=${row.errVsFinest.toExponential(3)} energyRes=${row.energyResidual.toExponential(3)}`,
          );
        }
        for (const [label, ev] of Object.entries(report.eventSplits)) {
          if (ev.length) console.log(`  ${label}: split at event times ${ev.join(', ')}`);
        }
        break;
      }

      case 'energy:export': {
        const id = required(flags, 'id', '--id <simId>');
        const before = svc.status(id);
        const out = flags.out ?? `data/energy-${id}.json`;
        console.log(`before: t=${before.t} steps=${before.step} residual=${before.ledger.residual}`);
        const r = svc.exportEnergy(id, resolve(out));
        console.log(
          `after: exported ${r.stepCount} steps to ${r.outFile}; residual=${r.ledger.residual.toExponential(3)}`,
        );
        break;
      }

      case 'fixture:demo': {
        const name = flags.name ?? 'multilayer';
        const fx = FIXTURES[name];
        if (!fx) throw new AppError('VALIDATION', `unknown fixture ${name}`);
        const f = fx();
        const wall = svc.createWall(f.wall.name, f.wall.layers);
        const bset = svc.setBoundary(wall.id, historyFromFixture(name));
        const sim = svc.createSimulation({
          wallId: wall.id,
          boundaryId: bset.id,
          dt: Number(flags.dt ?? 60),
          tEnd: Number(flags['t-end'] ?? 3600),
          snapshotEvery: 5,
        });
        console.log(`fixture ${name}: wall=${wall.id} boundary=${bset.id} sim=${sim.id}`);
        const r = svc.run(sim.id);
        const after = svc.status(sim.id);
        console.log(
          `ran ${r.stepsRun} steps -> t=${after.t} status=${after.status} residual=${after.ledger.residual.toExponential(3)}`,
        );
        break;
      }

      default:
        printHelp();
    }
  } finally {
    db.close();
  }
}

function required(flags: Record<string, string>, key: string, msg: string): string {
  if (!flags[key]) throw new AppError('VALIDATION', `missing flag ${msg}`);
  return flags[key];
}

function num(flags: Record<string, string>, key: string): number {
  const raw = flags[key];
  if (raw === undefined) throw new AppError('VALIDATION', `missing numeric flag --${key}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AppError('VALIDATION', `flag --${key} must be a number`);
  return n;
}

function printHelp() {
  console.log(`wall - 1-D multilayer transient conduction CLI

usage:
  wall init-db
  wall wall:create --file layers.json [--name X] [--db data/wall.db]
  wall wall:show --id <wallId>
  wall wall:list [--limit N] [--offset N]
  wall boundary:set --wall <wallId> (--file boundary.json | --fixture insulated|ends|multilayer|convection|step)
  wall sim:create --wall <wallId> --dt 60 --t-end 3600 [--boundary <id>] [--snapshot-every 5]
  wall sim:run --id <simId> [--steps N] [--accept-boundary true] [--boundary <newBoundaryId>]
  wall sim:status --id <simId>
  wall flux --id <simId>
  wall compare --wall <wallId> --t-end 3600 [--dt 60] [--multipliers 1,2,4] [--dts 120,60,30]
  wall energy:export --id <simId> [--out data/energy.json]
  wall fixture:demo [--name multilayer] [--dt 60] [--t-end 3600]

Flux sign: positive in +x (left -> right). Boundary qL/qR are energy INTO the wall.`);
}

main().catch((e) => {
  if (e instanceof AppError) {
    console.error(`error [${e.code}]: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});
