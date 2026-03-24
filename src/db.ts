/**
 * SQLite DB — pipelines + runs
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(__dirname, "../data/a2a-poc.db");

// Ensure data dir
mkdirSync(resolve(__dirname, "../data"), { recursive: true });

const db: import("better-sqlite3").Database = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agents TEXT NOT NULL, -- JSON array of agent names in order
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
    status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
    input TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    agent_name TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed | waiting_user
    output TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    validation_errors TEXT, -- JSON: array of { attempt, errors[], raw } per failed attempt
    started_at TEXT,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS backlog_tickets (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    agent_name TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_configs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT REFERENCES pipelines(id),
    channel_type TEXT NOT NULL DEFAULT 'generic',
    webhook_url TEXT NOT NULL,
    event_filters TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_config_id TEXT NOT NULL REFERENCES webhook_configs(id),
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    http_status INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );
`);

// ── Migrations ──────────────────────────────────────────────────────────────

// Add attempt + validation_errors columns if missing (for existing DBs)
const columns = db.prepare("PRAGMA table_info(run_steps)").all() as { name: string }[];
const colNames = columns.map(c => c.name);
if (!colNames.includes("attempt")) {
  db.exec("ALTER TABLE run_steps ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
}
if (!colNames.includes("validation_errors")) {
  db.exec("ALTER TABLE run_steps ADD COLUMN validation_errors TEXT");
}
if (!colNames.includes("summary_output")) {
  db.exec("ALTER TABLE run_steps ADD COLUMN summary_output TEXT");
}

// Add replay columns to runs table if missing
const runColumns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
const runColNames = runColumns.map(c => c.name);
if (!runColNames.includes("replay_of")) {
  db.exec("ALTER TABLE runs ADD COLUMN replay_of TEXT");
}
if (!runColNames.includes("replay_from_step")) {
  db.exec("ALTER TABLE runs ADD COLUMN replay_from_step INTEGER");
}

// Add group_id and group_order columns to run_steps if missing
if (!colNames.includes("group_id")) {
  db.exec("ALTER TABLE run_steps ADD COLUMN group_id TEXT");
}
if (!colNames.includes("group_order")) {
  db.exec("ALTER TABLE run_steps ADD COLUMN group_order INTEGER");
}

// Create run_groups table for parallel execution tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS run_groups (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    group_order INTEGER NOT NULL,
    failure_strategy TEXT DEFAULT 'fail_all',
    status TEXT DEFAULT 'pending',
    merged_output TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

export default db;
