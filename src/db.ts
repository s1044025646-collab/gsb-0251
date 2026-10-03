import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      boundary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      alive TEXT NOT NULL,
      duplicates INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(board_id, version)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      board_version INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      boundary TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      first_seen INTEGER,
      period INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      alive TEXT NOT NULL,
      population INTEGER NOT NULL,
      survived TEXT NOT NULL,
      born TEXT NOT NULL,
      died TEXT NOT NULL,
      PRIMARY KEY(run_id, generation)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_board ON runs(board_id);
  `);
  return db;
}
