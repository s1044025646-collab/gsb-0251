import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BoundaryMode } from './engine.js';

export interface BoardRow {
  id: number;
  name: string;
  width: number;
  height: number;
  boundary: BoundaryMode;
  created_at: string;
}

export interface VersionRow {
  id: number;
  board_id: number;
  version: number;
  rle: string;
  note: string | null;
  created_at: string;
}

export interface RunRow {
  id: number;
  board_id: number;
  version_id: number;
  target_gen: number;
  mode: 'single' | 'batch';
  cycle_start: number | null;
  cycle_period: number | null;
  first_repeat_gen: number | null;
  stored_max: number;
  created_at: string;
}

export interface SnapshotRow {
  run_id: number;
  gen: number;
  rle: string;
  population: number;
  born: string;
  survived: string;
  died: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        boundary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS board_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        rle TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(board_id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        version_id INTEGER NOT NULL REFERENCES board_versions(id),
        target_gen INTEGER NOT NULL,
        mode TEXT NOT NULL,
        cycle_start INTEGER,
        cycle_period INTEGER,
        first_repeat_gen INTEGER,
        stored_max INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        gen INTEGER NOT NULL,
        rle TEXT NOT NULL,
        population INTEGER NOT NULL,
        born TEXT NOT NULL,
        survived TEXT NOT NULL,
        died TEXT NOT NULL,
        PRIMARY KEY (run_id, gen)
      );
      CREATE INDEX IF NOT EXISTS idx_versions_board ON board_versions(board_id);
      CREATE INDEX IF NOT EXISTS idx_runs_board ON runs(board_id);
    `);
  }

  close(): void {
    this.db.close();
  }
}
