CREATE TABLE walls (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  layers_json TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  thickness REAL NOT NULL,
  n_cells INTEGER NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE boundary_sets (
  id TEXT PRIMARY KEY,
  wall_id TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  history_json TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  created_at REAL NOT NULL,
  UNIQUE (wall_id, version)
);

CREATE TABLE simulations (
  id TEXT PRIMARY KEY,
  wall_id TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
  boundary_id TEXT NOT NULL REFERENCES boundary_sets(id) ON DELETE RESTRICT,
  dt REAL NOT NULL,
  t_end REAL NOT NULL,
  snapshot_every INTEGER NOT NULL,
  t_now REAL NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created',
  material_hash TEXT NOT NULL,
  boundary_hash TEXT NOT NULL,
  T_json TEXT,
  q_l_prev REAL,
  q_r_prev REAL,
  ql0 REAL,
  qr0 REAL,
  u0 REAL,
  q_ledger_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  t REAL NOT NULL,
  dt REAL NOT NULL,
  q_l REAL NOT NULL,
  q_r REAL NOT NULL,
  e_l REAL NOT NULL,
  e_r REAL NOT NULL,
  d_u REAL NOT NULL,
  ledger_json TEXT NOT NULL,
  is_snapshot INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sim_id, step)
);
CREATE INDEX idx_steps_sim ON steps(sim_id, step);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  t REAL NOT NULL,
  t_json TEXT NOT NULL,
  UNIQUE (sim_id, step)
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at REAL NOT NULL
);
