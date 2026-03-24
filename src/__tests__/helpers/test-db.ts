/**
 * Test DB helper — creates in-memory SQLite with full a2a-poc schema.
 * Used by vi.mock("../db.js") in test files.
 */

import Database from "better-sqlite3";

export function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agents TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      template_name TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      replay_of TEXT,
      replay_from_step INTEGER
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      validation_errors TEXT,
      started_at TEXT,
      ended_at TEXT,
      summary_output TEXT,
      group_id TEXT,
      group_order INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost REAL,
      retry_token_overhead REAL
    );

    CREATE TABLE IF NOT EXISTS run_groups (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      group_order INTEGER NOT NULL,
      failure_strategy TEXT DEFAULT 'fail_all',
      status TEXT DEFAULT 'pending',
      merged_output TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backlog_tickets (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_configs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT,
      channel_type TEXT NOT NULL DEFAULT 'generic',
      webhook_url TEXT NOT NULL,
      event_filters TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_config_id TEXT NOT NULL,
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

  return db;
}

/** Wipe all rows — call in beforeEach for isolation */
export function cleanDb(db: InstanceType<typeof Database>): void {
  db.exec("DELETE FROM webhook_deliveries");
  db.exec("DELETE FROM webhook_configs");
  db.exec("DELETE FROM backlog_tickets");
  db.exec("DELETE FROM run_groups");
  db.exec("DELETE FROM run_steps");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM pipelines");
}
