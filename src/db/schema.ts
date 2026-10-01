export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS walls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  layers_json TEXT NOT NULL,
  total_thickness REAL NOT NULL,
  material_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS simulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wall_id INTEGER NOT NULL REFERENCES walls(id),
  name TEXT NOT NULL,
  initial_temperature REAL NOT NULL,
  left_history_json TEXT NOT NULL,
  right_history_json TEXT NOT NULL,
  boundary_version TEXT NOT NULL,
  material_version_snapshot TEXT NOT NULL,
  time REAL NOT NULL DEFAULT 0,
  temperatures_json TEXT,
  cumulative_heat_in REAL NOT NULL DEFAULT 0,
  internal_energy0 REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id INTEGER NOT NULL REFERENCES simulations(id),
  seq INTEGER NOT NULL,
  time REAL NOT NULL,
  dt REAL NOT NULL,
  temperatures_json TEXT NOT NULL,
  flux_left REAL NOT NULL,
  flux_right REAL NOT NULL,
  boundary_energy_step REAL NOT NULL,
  internal_energy_step REAL NOT NULL,
  internal_energy REAL NOT NULL,
  cumulative_heat_in REAL NOT NULL,
  energy_residual REAL NOT NULL,
  solve_residual REAL NOT NULL,
  UNIQUE(sim_id, seq)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  sim_id INTEGER,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_sim ON sim_steps(sim_id, seq);
CREATE INDEX IF NOT EXISTS idx_sims_wall ON simulations(wall_id);
`,
  },
];
