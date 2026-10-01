# wall-conduction

Windows-local, fully offline **1-D transient multilayer plane-wall conduction**
solver with an energy ledger. TypeScript + Node.js (built-in `node:sqlite`),
no external services, no web UI, no heat-exchanger sizing, no control of real
heating equipment.

It provides a conservative **cell-centered finite-volume** discretization with
**backward-Euler** time integration and a **tridiagonal (Thomas) solver**;
constant properties, no phase change, unit cross-sectional area; layers
(thickness, conductivity, density, specific heat, initial temperature,
per-layer mesh), boundary histories, and versioned schemes; a JSON HTTP
**API**, a **CLI**, **fictional-material fixtures**, and automated tests;
pause/resume with full temperature vectors, snapshots, and a cumulative energy
account that survives restarts.

## Physical model and conventions

- Coordinate `x` runs from the **left** face `x=0` to the **right** face
  `x=L_tot`. A **positive internal heat flux points in +x**.
- Boundary face fluxes `qL`/`qR` are reported as energy **INTO the wall**.
- Per unit area: `L [m]`, `k [W/(m K)]`, `rho [kg/m^3]`, `cp [J/(kg K)]`,
  temperatures in K (only differences matter; results are invariant under a
  constant temperature shift).
- Cell capacitance `C_i = rho_i cp_i dx_i [J/(m^2 K)]`.
- **Internal face conductance uses series half-cell resistances**, never a
  simple arithmetic average of conductivity:

  ```
  g_f = 1 / ( dx_L/(2 k_L) + dx_R/(2 k_R) )
  ```

  This stays correct for very large conductivity jumps (fixtures include a
  5000:1 metal/insulation jump).
- **Boundary half-control-volume resistances** use distance `dx/2`:
  prescribed temperature `g_b = 2k/dx`; insulated `g_b = 0`.
- Convection `q_into = h (T_inf - T_face)` is applied implicitly with the
  half-cell resistance combined into the Robin coefficient
  `g_b = (h*k_f)/(h+k_f)`, where `k_f = 2k/dx`.
- The implicit cell equation is

  ```
  C_i/dt (T_i^{n+1} - T_i^n)
    = sum_faces g (T_neighbor^{n+1} - T_i^{n+1}) + q_boundary_into
  ```

### Boundary step splitting

Boundary histories are piecewise-constant events at times `t`. Time steps are
**split exactly at change times**: a step ending on an event uses the old
condition (the new condition applies strictly after that instant); the next
step uses the new condition. `CLI compare` and reports list event split times.

### Energy bookkeeping (fixed quadrature)

Per step, face energy uses the **backward-Euler right endpoint**:

```
eL = qL_into^{n+1} * dt,   eR = qR_into^{n+1} * dt
```

This is the quadrature that balances against the FVM cell energy update:
summing the discrete equations over all cells gives `dU = eL + eR` up to
round-off. The ledger stores cumulative `QL`, `QR`, `dU` and
`residual = QL + QR - dU`. Implicit stability does **not** imply time
accuracy: use the refinement comparison (coarse runs are never treated exact).

## Validation

Independent analytic checks live in `src/core/analytics.ts`:

- `steadySeries`: exact steady series resistance and piecewise-linear
  temperature for the multilayer wall;
- `slabSeries`: single-material Fourier series for fixed end temperatures.

Fixtures (`src/fixtures/materials.ts`, values fictional): `insulated`
(uniform insulated), `ends` (two fixed temperatures), `multilayer` (steady
resistance + interface flux continuity over a 5000:1 conductivity ratio),
`convection` (two-sided convective cooling), `step` (left temperature step,
insulated right).

Tests cover conservation, temperature-scale invariance, interface-flux
continuity, analytic agreement, refinement convergence, exact event splitting,
failure paths, transaction rollback, idempotency, pagination and restart
persistence.

## Requirements

- Windows (or any OS) with **Node.js >= 22.5** (built-in `node:sqlite`;
  developed on Node 25) and npm.
- No external services. All runtime data stays in `./data`; test data uses the
  OS temp directory.

```powershell
npm install
```

## Build, test, demo

```powershell
npm run build       # tsc -> dist/ and copies SQL migrations
npm test            # node:test across test/*.test.ts
npm run typecheck   # strict tsc including tests
npm run demo        # deterministic end-to-end demo (uses data/demo.db)
```

## Start and stop the API

The server binds **only to `127.0.0.1`** on an **OS-assigned free port**
(port 0). The chosen port is written to `data/server.json`.

```powershell
npm run build
npm run serve       # background start, prints http://127.0.0.1:<port>
Get-Content data/server.json
# ... use the API ...
npm run stop        # stops ONLY the pid recorded in data/server.pid
npm run clean       # removes project-local ./data only
```

Foreground during development:

```powershell
npm run dev         # node --import tsx src/api/server.ts (Ctrl+C to stop)
```

Set a different database with `$env:WALL_DB="data/other.db"`. Migrations run
at startup and are **idempotent/repeatable**.

## CLI

```powershell
npm run cli -- init-db
npm run cli -- wall:create --file examples/layers.multilayer.json
npm run cli -- wall:list
npm run cli -- wall:show --id <wallId>
npm run cli -- boundary:set --wall <wallId> --fixture multilayer
npm run cli -- sim:create --wall <wallId> --dt 400 --t-end 200000 --snapshot-every 25
npm run cli -- sim:run --id <simId> --steps 50    # pause: limit steps
npm run cli -- sim:run --id <simId>               # resume to tEnd
npm run cli -- sim:status --id <simId>
npm run cli -- flux --id <simId>                  # boundary + interface fluxes
npm run cli -- compare --wall <wallId> --t-end 7200 --dts 600,300,150 --multipliers 1,2,4
npm run cli -- energy:export --id <simId> --out data/energy.json
npm run cli -- fixture:demo --name step
```

Mutating CLI commands print `before:` / `after:` status. `--db path` selects
the database (default `data/wall.db`). Boundary JSON is shown in
`examples/boundary.step.json`; supported BC kinds are `temperature`
(`{kind:'temperature', T}`), `insulated`, and `convection`
(`{kind:'convection', h, Tinf}`).

## HTTP API

All requests/responses are JSON. Errors use
`{ "error": { "code", "message", "details?" } }`.

- `GET /healthz`
- `POST /api/walls` (`{name, layers[]}`), `GET /api/walls?limit=&offset=`,
  `GET /api/walls/:id`, `PUT /api/walls/:id` (new layer version)
- `POST /api/walls/:id/boundaries` (`{L:[...],R:[...]}`),
  `GET /api/walls/:id/boundaries?limit=&offset=`
- `POST /api/simulations` (`{wallId, boundaryId?, dt, tEnd, snapshotEvery?}`)
- `GET /api/simulations?wallId=&limit=&offset=`, `GET /api/simulations/:id`
- `POST /api/simulations/:id/run` (`{maxSteps?, acceptBoundaryChange?, newBoundaryId?}`)
- `GET /api/simulations/:id/steps`, `GET /api/simulations/:id/snapshots`
  (both paged)
- `GET /api/simulations/:id/fluxes`
- `POST /api/simulations/:id/export-energy` (`{outFile?}`)
- `POST /api/compare` (`{wallId, boundaryId?, tEnd, dt | dt[], cellMultipliers[]}`)

**Error codes**: `VALIDATION`, `NON_POSITIVE_PROPERTY`, `BAD_GRID`,
`BAD_BOUNDARY`, `ILLEGAL_TIME`, `SOLVER_NON_FINITE`, `NOT_FOUND`,
`MATERIAL_CHANGED`, `BOUNDARY_VERSION_CHANGED`, `SIM_FINISHED`,
`IDEMPOTENCY_CONFLICT` (mapped to HTTP 400/404/409/422/500).

**Idempotency**: send an `Idempotency-Key` header on `POST`/`PUT`. A repeat
with the same key and identical body replays the stored response
(`Idempotent-Replay: true`); the same key with a different body returns
`409 IDEMPOTENCY_CONFLICT`.

**Pagination**: `limit` (default 50, max 200), `offset`; responses include
`nextOffset` (`null` on the last page).

## Versioning and safe resume

- Walls and boundary sets are content-hashed (`sha256`) and versioned.
- A simulation stores the `material_hash`/`boundary_hash` it was created with
  plus the **full temperature vector**, time, step number and cumulative
  ledger.
- Resuming after a wall material change fails with `MATERIAL_CHANGED` (it
  never silently recomputes on modified materials or loses accumulated heat).
- Continuing with a **new boundary version** requires explicitly binding it
  (`newBoundaryId`) and acknowledging `acceptBoundaryChange`; cumulative heat
  is preserved across the change.

## Project layout

- `src/core/`: grid, boundary histories, TDMA, FVM solver, analytic checks
- `src/db/`: sqlite connection, repeatable SQL migrations, repository
- `src/services/`: simulation orchestration, transactions, refinement compare
- `src/api/`: HTTP app and localhost auto-port server
- `src/cli/`: command line interface
- `src/fixtures/`: fictional materials and five benchmark cases
- `scripts/`: demo, build asset copy, project-local start/stop
- `test/`: solver, persistence/rollback/restart, HTTP API and CLI tests
- `examples/`: sample wall and boundary JSON
- `data/`: created at runtime (databases, exports, `server.json`)
