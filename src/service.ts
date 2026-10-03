import type { DatabaseSync } from 'node:sqlite';
import {
  Boundary,
  Cell,
  ValidationError,
  normalizeSpec,
  evolve,
  encodeCells,
  decodeCells,
  renderBoard,
  BoardSpec,
  MIN_SIDE,
  MAX_AREA,
} from './core';

export const MAX_STEPS = 2_000;
export const MAX_SNAPSHOTS = 2_000;

export interface CreateBoardInput {
  name?: string;
  width: number;
  height: number;
  boundary: Boundary;
  alive: Cell[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export class LifeService {
  constructor(private db: DatabaseSync) {}

  createBoard(input: CreateBoardInput) {
    const { cells, duplicates } = normalizeSpec(input);
    const info = this.db
      .prepare(
        `INSERT INTO boards (name, width, height, boundary, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.name ?? null, input.width, input.height, input.boundary, nowIso());
    const boardId = Number(info.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO board_versions (board_id, version, alive, duplicates, created_at)
         VALUES (?, 1, ?, ?, ?)`,
      )
      .run(boardId, encodeCells(cells, input.width), duplicates, nowIso());
    return this.getBoard(boardId);
  }

  getBoard(boardId: number) {
    const board = this.db
      .prepare(`SELECT * FROM boards WHERE id = ?`)
      .get(boardId) as BoardRow | undefined;
    if (!board) throw new ValidationError('NOT_FOUND', `棋盘 ${boardId} 不存在`);
    const versions = this.db
      .prepare(`SELECT id, version, alive, duplicates, created_at FROM board_versions WHERE board_id = ? ORDER BY version`)
      .all(boardId) as unknown as VersionRow[];
    return {
      id: board.id,
      name: board.name,
      width: board.width,
      height: board.height,
      boundary: board.boundary,
      createdAt: board.created_at,
      versions: versions.map((v) => ({
        version: v.version,
        alive: decodeCells(v.alive),
        duplicates: v.duplicates,
        createdAt: v.created_at,
      })),
      currentVersion: versions.length ? versions[versions.length - 1].version : 1,
    };
  }

  listBoards() {
    const rows = this.db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM board_versions v WHERE v.board_id = b.id) AS version_count
         FROM boards b ORDER BY b.id`,
      )
      .all() as unknown as Array<BoardRow & { version_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      width: r.width,
      height: r.height,
      boundary: r.boundary,
      versionCount: r.version_count,
      createdAt: r.created_at,
    }));
  }

  /** 编辑初始棋盘产生新版本；不影响任何旧运行（运行按版本号与快照固化）。 */
  editBoard(boardId: number, alive: Cell[]) {
    const board = this.db
      .prepare(`SELECT * FROM boards WHERE id = ?`)
      .get(boardId) as BoardRow | undefined;
    if (!board) throw new ValidationError('NOT_FOUND', `棋盘 ${boardId} 不存在`);

    const { cells, duplicates } = normalizeSpec({
      width: board.width,
      height: board.height,
      boundary: board.boundary as Boundary,
      alive,
    });

    const maxRow = this.db
      .prepare(`SELECT MAX(version) AS v FROM board_versions WHERE board_id = ?`)
      .get(boardId) as { v: number | null };
    const nextVersion = (maxRow.v ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO board_versions (board_id, version, alive, duplicates, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(boardId, nextVersion, encodeCells(cells, board.width), duplicates, nowIso());
    return this.getBoard(boardId);
  }

  /**
   * 从指定版本（默认当前版本）的初始棋盘连续演化到 targetGeneration 并保存一次运行。
   * 每一代快照都会保存（受 MAX_SNAPSHOTS 限制）。
   */
  runEvolution(boardId: number, targetGeneration: number, version?: number) {
    if (!Number.isInteger(targetGeneration) || targetGeneration < 0) {
      throw new ValidationError('INVALID_GENERATION', '目标代数必须为非负整数');
    }
    if (targetGeneration > MAX_STEPS) {
      throw new ValidationError('LIMIT_EXCEEDED', `单次运行步数超出上限 ${MAX_STEPS}`);
    }

    const board = this.db
      .prepare(`SELECT * FROM boards WHERE id = ?`)
      .get(boardId) as BoardRow | undefined;
    if (!board) throw new ValidationError('NOT_FOUND', `棋盘 ${boardId} 不存在`);

    const useVersion = version ?? this.currentVersion(boardId);
    const verRow = this.db
      .prepare(`SELECT * FROM board_versions WHERE board_id = ? AND version = ?`)
      .get(boardId, useVersion) as VersionRow | undefined;
    if (!verRow) throw new ValidationError('NOT_FOUND', `版本 ${useVersion} 不存在`);

    const initial = decodeCells(verRow.alive);
    const spec: BoardSpec = {
      width: board.width,
      height: board.height,
      boundary: board.boundary as Boundary,
      alive: initial,
    };
    if (targetGeneration + 1 > MAX_SNAPSHOTS) {
      throw new ValidationError('LIMIT_EXCEEDED', `保存快照数量超出上限 ${MAX_SNAPSHOTS}`);
    }

    const { generations, firstSeen, period } = evolve(spec, targetGeneration);

    const runInfo = this.db
      .prepare(
        `INSERT INTO runs
           (board_id, board_version, width, height, boundary, target_generation,
            first_seen, period, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        boardId,
        useVersion,
        board.width,
        board.height,
        board.boundary,
        targetGeneration,
        firstSeen,
        period,
        nowIso(),
        nowIso(),
      );
    const runId = Number(runInfo.lastInsertRowid);

    const insertSnap = this.db.prepare(
      `INSERT INTO snapshots (run_id, generation, alive, population, survived, born, died)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const g of generations) {
      insertSnap.run(
        runId,
        g.generation,
        encodeCells(g.cells, board.width),
        g.population,
        encodeCells(g.diff.survived, board.width),
        encodeCells(g.diff.born, board.width),
        encodeCells(g.diff.died, board.width),
      );
    }

    return this.getRun(runId);
  }

  private currentVersion(boardId: number): number {
    const row = this.db
      .prepare(`SELECT MAX(version) AS v FROM board_versions WHERE board_id = ?`)
      .get(boardId) as { v: number | null };
    if (row.v == null) throw new ValidationError('NOT_FOUND', '棋盘没有初始版本');
    return row.v;
  }

  getRun(runId: number) {
    const run = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
    if (!run) throw new ValidationError('NOT_FOUND', `运行 ${runId} 不存在`);
    return {
      id: run.id,
      boardId: run.board_id,
      boardVersion: run.board_version,
      width: run.width,
      height: run.height,
      boundary: run.boundary,
      targetGeneration: run.target_generation,
      cycle:
        run.first_seen == null
          ? null
          : { firstSeen: run.first_seen, period: run.period },
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    };
  }

  listRuns(boardId?: number) {
    const rows = boardId
      ? (this.db.prepare(`SELECT * FROM runs WHERE board_id = ? ORDER BY id`).all(boardId) as unknown as RunRow[])
      : (this.db.prepare(`SELECT * FROM runs ORDER BY id`).all() as unknown as RunRow[]);
    return rows.map((r) => ({
      id: r.id,
      boardId: r.board_id,
      boardVersion: r.board_version,
      boundary: r.boundary,
      targetGeneration: r.target_generation,
      cycle: r.first_seen == null ? null : { firstSeen: r.first_seen, period: r.period },
    }));
  }

  /** 查询某次运行已生成的某一代快照与差异。 */
  getGeneration(runId: number, generation: number) {
    this.getRun(runId);
    if (!Number.isInteger(generation) || generation < 0) {
      throw new ValidationError('INVALID_GENERATION', '代数必须为非负整数');
    }
    const row = this.db
      .prepare(`SELECT * FROM snapshots WHERE run_id = ? AND generation = ?`)
      .get(runId, generation) as SnapshotRow | undefined;
    if (!row) {
      throw new ValidationError(
        'GENERATION_NOT_FOUND',
        `运行 ${runId} 中未生成第 ${generation} 代`,
      );
    }
    return {
      runId,
      generation: row.generation,
      population: row.population,
      alive: decodeCells(row.alive),
      diff: {
        survived: decodeCells(row.survived),
        born: decodeCells(row.born),
        died: decodeCells(row.died),
      },
    };
  }

  listGenerations(runId: number) {
    this.getRun(runId);
    const rows = this.db
      .prepare(`SELECT generation, population FROM snapshots WHERE run_id = ? ORDER BY generation`)
      .all(runId) as Pick<SnapshotRow, 'generation' | 'population'>[];
    return rows.map((r) => ({ generation: r.generation, population: r.population }));
  }

  /** 导出某一代字符棋盘。 */
  renderGeneration(runId: number, generation: number) {
    const snap = this.getGeneration(runId, generation);
    const run = this.getRun(runId);
    return renderBoard(run.width, run.height, snap.alive);
  }
}

interface BoardRow {
  id: number;
  name: string | null;
  width: number;
  height: number;
  boundary: string;
  created_at: string;
}

interface VersionRow {
  id: number;
  version: number;
  alive: string;
  duplicates: number;
  created_at: string;
}

interface RunRow {
  id: number;
  board_id: number;
  board_version: number;
  width: number;
  height: number;
  boundary: string;
  target_generation: number;
  first_seen: number | null;
  period: number | null;
  started_at: string;
  finished_at: string;
}

interface SnapshotRow {
  run_id: number;
  generation: number;
  alive: string;
  population: number;
  survived: string;
  born: string;
  died: string;
}

export { MIN_SIDE, MAX_AREA };
