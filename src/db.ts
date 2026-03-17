/**
 * SQLite DB — pipelines + runs
 */

import Database from "better-sqlite3";
import { resolve } from "path";

const DB_PATH = resolve(__dirname, "../data/a2a-poc.db");

// Ensure data dir
import { mkdirSync } from "fs";
mkdirSync(resolve(__dirname, "../data"), { recursive: true });

const db = new Database(DB_PATH);
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
    status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
    output TEXT,
    started_at TEXT,
    ended_at TEXT
  );
`);

export default db;
