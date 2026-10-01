# Layered Wall 1D Transient Conduction & Energy Accounting

Backend-only (HTTP API + CLI) for one-dimensional transient heat conduction
through a unit-cross-section, multi-layer, plane wall. Constant properties, no
phase change. It manages layer thickness, conductivity, density, specific
heat, initial temperature, meshes, piecewise boundary histories and
material/boundary version snapshots.

There is **no web UI, no heat-exchanger sizing, and no control of real heating
equipment**. Material names and property values in the fixtures are fictional.

## Numerical method

- Cell-centered finite volume method on a non-overlapping control-volume mesh.
- Backward (implicit) Euler time integration; the per-step linear system is
  tridiagonal and solved with the Thomas algorithm.
- Internal-interface conductance combines the two half-control-volume thermal
  resistances **in series**: `g = 1 / (dxA/(2 kA) + dxB/(2 kB))` (harmonic),
  never a simple arithmetic average, so large conductivity contrasts are exact.
- Boundaries: prescribed temperature, adiabatic, or convection. Convection
  adds the film resistance `1/h` in series with the half-cell resistance.
- Boundary steps are split: a step lands **exactly** on its event time even
  when the requested `maxDt` does not divide it.

### Sign and units convention (fixed)

- `x` runs from the left face (0) to the right face (L). Heat flux `q` is
  positive in the `+x` direction, W/m².
- Surface values stored on each step are "heat flux **into** the wall"; the
  reported `flux.left` equals the signed `+x` flux, `flux.right = -q_in,right`.
- Temperature K, time s, energy J/m².
- Energy accounting uses a single, fixed discrete integration rule: the
  backward-Euler end-of-step surface flux times `dt`, summed over steps.
  Internal-energy change is `Σ ρ cp Δx (T_new − T_old)`. The energy residual
  is `cumulativeHeatIn − (U − U0)`; the solver also reports the tridiagonal
  residual norm. Backward Euler is unconditionally stable but **not** exact in
  time — always inspect the refinement comparison and residuals; a coarse grid
  is a reference calculation, never the truth.

## Persistence and versioning

- SQLite (Node's built-in `node:sqlite`), file at `data/walls.db` by default.
- Every step stores the **full temperature vector**, time, boundary
  conditions and both cumulative heat and energy residual.
- A simulation pins a `material_version` snapshot and a `boundary_version`.
  Resume/refuse if the wall's material definition changed afterward
  (`MATERIAL_MODIFIED`); cumulative heat is continued, never reset.
- Step insert + simulation update happen in one transaction; failures roll
  back. Migrations are idempotent and safe to re-run.
- Repeated compute submissions with the same `Idempotency-Key` (or
  `idempotencyKey`) replay the stored response and add no steps.

## Requirements

- Node.js >= 22.5 (developed on Node 25). Uses built-in `node:sqlite`,
  `node:test`, TypeScript type stripping and `fetch` — **zero third-party
  dependencies**.

## Install / test / run

No install step is strictly required (no dependencies), but:

```powershell
npm install        # optional, only writes node_modules metadata
npm test           # full automated suite (22 tests)
npm run demo       # reproducible end-to-end demo (temp DB inside ./data)
npm start          # HTTP API, binds 127.0.0.1 on an automatic free port
npm run stop       # stop the project server started by npm start
```

`npm start` prints one JSON line, e.g.
`{"listening":"127.0.0.1","port":53215,"dbPath":"...","pid":1234}`.
The server only listens on localhost. All databases, temp files and pid files
stay inside the project `data/` directory; start/stop manage only the project
server pid recorded in `data/server.pid`.

## CLI

`npm run cli -- <command> [options]` (commands print before/after state):

```text
materials                         list fictional material properties
fixtures                          list standard fixtures
wall:create --fixture KEY --name N
sim:create --wallId ID --fixture KEY
boundary:show --simId ID          show pinned boundary history/version
compute --simId ID --target T [--dt D] [--idem KEY]   advance / resume
interfaces --simId ID             internal interface heat flux (+x)
state --simId ID                  full temperature vector, time, versions
ledger --simId ID                 energy accounting
ledger:export --simId ID --out F  export energy ledger JSON
steps --simId ID [--limit N --offset N]
compare --fixture KEY --time T    grid/time refinement vs analytic
```

Example walk-through:

```powershell
npm run cli -- wall:create --fixture multilayer-resistance   # note WALL_ID
npm run cli -- sim:create --wallId 1 --fixture multilayer-resistance
npm run cli -- compute --simId 1 --target 600 --dt 20
npm run cli -- compute --simId 1 --target 1200 --dt 20       # pause/resume
npm run cli -- interfaces --simId 1
npm run cli -- ledger:export --simId 1 --out data/ledger.json
npm run cli -- compare --fixture convection-cooling --time 3600
```

## HTTP API

List endpoints return `{ items, total }` and accept `?limit=` (1..500) and
`?offset=`. Errors return `{ error: { code, message, details? } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/health` | liveness |
| POST | `/api/walls` | create wall `{ name, layers[] }` |
| GET  | `/api/walls` | list walls (paged) |
| GET  | `/api/walls/:id` | get wall + material version |
| POST | `/api/simulations` | `{ wallId, name, initialTemperature, left, right }` |
| GET  | `/api/simulations` | list (optional `?wallId=`, paged) |
| GET  | `/api/simulations/:id` | get simulation |
| POST | `/api/simulations/:id/compute` | `{ targetTime, maxDt }`, header `Idempotency-Key` |
| GET  | `/api/simulations/:id/state` | current time + full temperature vector |
| GET  | `/api/simulations/:id/interfaces` | internal interface fluxes |
| GET  | `/api/simulations/:id/steps` | stored steps (paged) |
| GET  | `/api/simulations/:id/ledger` | energy accounting |

Boundary value may be a single condition (`{type,...}`) or a history
(`{segments:[{start,end,condition},...]}`), the last segment ending at
`Infinity`. JSON bodies use the project encoder so open-ended `Infinity`
segments round-trip through persistence.

Error codes: `VALIDATION`, `NON_POSITIVE_PROPERTY`, `ILLEGAL_TIME`,
`THICKNESS_MISMATCH`, `NON_FINITE`, `NOT_FOUND`, `CONFLICT`,
`VERSION_MISMATCH`, `MATERIAL_MODIFIED`.

## Fixtures and verification

Fixtures: uniform adiabatic, both ends fixed temperature, multilayer
steady-state resistance, convection cooling, and step heating.

Independent references: a multilayer series-resistance steady solution and
single-material eigen/series solutions (symmetric convection slab, fixed-end
sine series). Tests assert conservation, temperature-scale translation
invariance, interface flux continuity, grid/time refinement convergence,
exact step splitting, checkpoint/resume, transaction rollback, restart
persistence, idempotent replay and the explicit failure paths.

## Layout

```text
src/core   physics: mesh, boundary, solver, analytic references, fixtures, service
src/db     SQLite client, migrations, repository
src/api    HTTP server/router (localhost, automatic port)
src/cli    command line interface
scripts    reproducible demo, project-local stop helper
test       node:test automated suite
```
