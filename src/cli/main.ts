import { join } from 'node:path';
import { openDatabase } from '../db/client.ts';
import { Repo } from '../db/repo.ts';
import { ConductionService } from '../core/service.ts';
import { FIXTURES, MATERIALS } from '../core/fixtures.ts';
import { createSolver, advance } from '../core/solver.ts';
import { slabConvectionSeries, slabFixedEndsSeries, steadyFlux } from '../core/analytic.ts';
import { AppError } from '../core/errors.ts';

const dbPath = process.env.DB_PATH ?? join(process.cwd(), 'data', 'walls.db');
const handle = openDatabase(dbPath);
const repo = new Repo(handle.db);
const service = new ConductionService(repo);

function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function header(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function layersFromFixture(key: string) {
  const f = FIXTURES.find((x) => x.key === key);
  if (!f) throw new AppError('NOT_FOUND', `unknown fixture: ${key}`);
  return f.build();
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parse(rest);

  try {
    switch (command) {
      case 'materials': {
        header('Fictional materials');
        printJson(MATERIALS);
        break;
      }
      case 'fixtures': {
        header('Fixtures');
        printJson(FIXTURES.map((f) => ({ key: f.key, description: f.description })));
        break;
      }
      case 'wall:create': {
        const fx = String(args.fixture ?? 'multilayer-resistance');
        const built = layersFromFixture(fx);
        header(`Before: no wall (fixture=${fx})`);
        process.stdout.write(`layers=${built.layers.length} thickness=${built.layers.reduce((s, l) => s + l.thickness, 0)}m\n`);
        const wall = service.createWall(args.name ?? fx, built.layers);
        header('After: wall created');
        printJson({ id: wall.id, name: wall.name, totalThickness: wall.totalThickness, materialVersion: wall.materialVersion });
        process.stdout.write(`\nWALL_ID=${wall.id}\n`);
        break;
      }
      case 'sim:create': {
        const fx = String(args.fixture ?? 'multilayer-resistance');
        const built = layersFromFixture(fx);
        const wallId = Number(args.wallId);
        header(`Before: simulation for wall ${wallId} at t=0`);
        const sim = service.createSimulation(
          wallId,
          args.name ?? fx,
          built.initialTemperature,
          built.left,
          built.right,
        );
        header('After: simulation created (boundary version pinned)');
        printJson({
          id: sim.id,
          wallId: sim.wallId,
          initialTemperature: sim.initialTemperature,
          boundaryVersion: sim.boundaryVersion,
          materialVersionSnapshot: sim.materialVersionSnapshot,
        });
        process.stdout.write(`\nSIM_ID=${sim.id}\n`);
        break;
      }
      case 'boundary:show': {
        const sim = service.getSimulation(Number(args.simId));
        header('Pinned boundary history');
        printJson({ boundaryVersion: sim.boundaryVersion, left: sim.left, right: sim.right });
        break;
      }
      case 'compute': {
        const simId = Number(args.simId);
        const before = service.state(simId);
        header(`Before: t=${before.time}s cells=${before.cellCount} Q_in=${before.cumulativeHeatIn.toFixed(6)} J/m^2`);
        const result = service.compute(simId, {
          targetTime: Number(args.target),
          maxDt: Number(args.dt ?? 10),
          idempotencyKey: args.idem ? String(args.idem) : undefined,
        });
        header(`After: ${result.stepsAdded} step(s), replayed=${result.replayed}`);
        if (result.final) {
          printJson({
            time: result.final.time,
            flux: result.final.flux,
            cumulativeHeatIn: result.final.cumulativeHeatIn,
            energyResidual: result.final.energyResidual,
            solveResidual: result.final.solveResidual,
          });
        }
        break;
      }
      case 'interfaces': {
        header('Internal interface heat flux (+x positive)');
        printJson(service.interfaceFluxes(Number(args.simId)));
        break;
      }
      case 'state': {
        printJson(service.state(Number(args.simId)));
        break;
      }
      case 'ledger': {
        const value = service.ledger(Number(args.simId));
        header('Energy ledger');
        printJson(value);
        break;
      }
      case 'ledger:export': {
        const fs = await import('node:fs');
        const out = String(args.out ?? join(process.cwd(), 'data', `ledger-${args.simId}.json`));
        fs.writeFileSync(out, JSON.stringify(service.ledger(Number(args.simId)), null, 2));
        process.stdout.write(`exported energy ledger -> ${out}\n`);
        break;
      }
      case 'steps': {
        printJson(service.listSteps(Number(args.simId), Number(args.limit ?? 20), Number(args.offset ?? 0)));
        break;
      }
      case 'compare': {
        await compare(String(args.fixture ?? 'convection-cooling'), Number(args.time ?? 3600));
        break;
      }
      default:
        usage();
        return command === undefined ? 0 : 2;
    }
    return 0;
  } catch (err) {
    if (err instanceof AppError) {
      process.stderr.write(`ERROR [${err.code}] ${err.message}\n`);
      if (err.details) process.stderr.write(JSON.stringify(err.details) + '\n');
      return 1;
    }
    throw err;
  } finally {
    handle.close();
  }
}

function usage(): void {
  process.stdout.write(
    [
      'Usage: npm run cli -- <command> [options]',
      'Commands:',
      '  materials                         list fictional material properties',
      '  fixtures                          list standard fixtures',
      '  wall:create --fixture KEY --name N',
      '  sim:create --wallId ID --fixture KEY',
      '  boundary:show --simId ID',
      '  compute --simId ID --target T [--dt D] [--idem KEY]',
      '  interfaces --simId ID             internal interface heat flux',
      '  state --simId ID                  full temperature vector + time + versions',
      '  ledger --simId ID                 energy accounting',
      '  ledger:export --simId ID --out F  export energy ledger JSON',
      '  steps --simId ID [--limit N --offset N]',
      '  compare --fixture KEY --time T    grid/time refinement vs analytic',
      '',
    ].join('\n'),
  );
}

async function compare(key: string, time: number): Promise<void> {
  const base = layersFromFixture(key);
  const grids = [10, 20, 40, 80];
  const dts = [50, 25, 12.5, 6.25];
  header(`Refinement comparison (fixture=${key}, t=${time}s)`);
  const rows = [];
  for (let r = 0; r < grids.length; r++) {
    // Scale every layer by the same factor relative to the coarsest fixture layer.
    const scaled = base.layers.map((l) => ({
      ...l,
      cells: Math.max(1, Math.round((l.cells / base.layers[0].cells) * grids[r])),
    }));
    const solver = createSolver({
      layers: scaled,
      initialTemperature: base.initialTemperature,
      left: base.left,
      right: base.right,
    });
    const last = advance(solver, time, dts[r]);
    const n = solver.mesh.cells.length;
    let analyticCenter: number;
    const p = scaled.length === 1
      ? {
          thickness: scaled[0].thickness,
          conductivity: scaled[0].conductivity,
          density: scaled[0].density,
          specificHeat: scaled[0].specificHeat,
        }
      : null;
    if (p && key === 'convection-cooling') {
      analyticCenter = slabConvectionSeries(p, base.initialTemperature, 290, 12, p.thickness / 2, time);
    } else if (p && key === 'both-fixed') {
      analyticCenter = slabFixedEndsSeries(p, base.initialTemperature, 400, 300, p.thickness / 2, time);
    } else {
      analyticCenter = NaN;
    }
    const centerTemp = last.temperatures[Math.floor(n / 2)];
    rows.push({
      cells: n,
      dt: dts[r],
      centerTemp,
      analyticCenter,
      absError: Number.isFinite(analyticCenter) ? Math.abs(centerTemp - analyticCenter) : null,
      energyResidual: last.energyResidual,
      solveResidual: last.solveResidual,
    });
  }
  if (key === 'multilayer-resistance') {
    const q = steadyFlux(base.layers, 370, 300);
    process.stdout.write(`analytic steady flux = ${q.toFixed(6)} W/m^2\n`);
  }
  printJson(rows);
  process.stdout.write(
    '\nNote: backward Euler is unconditionally stable but time accuracy improves with smaller dt;\n' +
      'coarse grids/dt are reference calculations, not exact solutions.\n',
  );
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
