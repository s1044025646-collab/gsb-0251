import { Store, type BoardRow, type RunRow, type SnapshotRow, type VersionRow } from './db.js';
import { AppError } from './errors.js';
import { LIMITS } from './limits.js';
import {
  Board,
  dedupeCoords,
  diffBoards,
  type BoundaryMode,
  type Coord,
  type Diff,
} from './engine.js';

export interface CreateBoardInput {
  name?: string;
  width: number;
  height: number;
  boundary: BoundaryMode;
  alive?: Coord[];
}

export interface CycleInfo {
  detected: boolean;
  firstOccurrenceGen: number | null;
  repeatGen: number | null;
  period: number | null;
}

export interface GenResult {
  runId: number;
  boardId: number;
  version: number;
  gen: number;
  boundary: BoundaryMode;
  width: number;
  height: number;
  population: number;
  alive: Coord[];
  diff: Diff;
  cycle: CycleInfo;
}

export class GameService {
  constructor(private store: Store) {}

  createBoard(input: CreateBoardInput) {
    const width = input.width;
    const height = input.height;
    const boundary = input.boundary;
    const rawAlive = input.alive ?? [];
    // 先建棋盘做校验，再去重
    Board.create(width, height, boundary, rawAlive);
    const { coords, duplicates } = dedupeCoords(rawAlive);
    const board = Board.create(width, height, boundary, coords);

    const insBoard = this.store.db.prepare(
      `INSERT INTO boards (name, width, height, boundary) VALUES (?,?,?,?)`,
    );
    const info = insBoard.run(input.name?.toString() || '未命名棋盘', width, height, boundary);
    const boardId = Number(info.lastInsertRowid);
    this.store.db
      .prepare(`INSERT INTO board_versions (board_id, version, rle, note) VALUES (?,?,?,?)`)
      .run(boardId, 1, board.toRle(), '初始版本');

    return {
      boardId,
      version: 1,
      duplicates,
      warning: duplicates > 0 ? `检测到 ${duplicates} 个重复活点，已按一个细胞处理` : null,
      width,
      height,
      boundary,
      population: board.population(),
      alive: board.aliveCoords(),
    };
  }

  getBoard(boardId: number): BoardRow & { latestVersion: number } {
    const row = this.store.db.prepare(`SELECT * FROM boards WHERE id = ?`).get(boardId) as
      | BoardRow
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `棋盘 ${boardId} 不存在`);
    const v = this.store.db
      .prepare(`SELECT MAX(version) AS v FROM board_versions WHERE board_id = ?`)
      .get(boardId) as { v: number };
    return { ...row, latestVersion: v.v };
  }

  listBoards(): BoardRow[] {
    return this.store.db.prepare(`SELECT * FROM boards ORDER BY id`).all() as unknown as BoardRow[];
  }

  listVersions(boardId: number): VersionRow[] {
    this.getBoard(boardId);
    return this.store.db
      .prepare(`SELECT * FROM board_versions WHERE board_id = ? ORDER BY version`)
      .all(boardId) as unknown as VersionRow[];
  }

  getVersion(boardId: number, version: number): { row: VersionRow; board: BoardRow } {
    const board = this.getBoard(boardId);
    const row = this.store.db
      .prepare(`SELECT * FROM board_versions WHERE board_id = ? AND version = ?`)
      .get(boardId, version) as VersionRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `棋盘 ${boardId} 的版本 ${version} 不存在`);
    return { row, board };
  }

  /** 编辑初始棋盘 -> 生成新版本；旧运行仍引用旧版本，保持不变。 */
  editBoard(boardId: number, alive: Coord[], note?: string) {
    const boardRow = this.getBoard(boardId);
    Board.create(boardRow.width, boardRow.height, boardRow.boundary, alive);
    const { coords, duplicates } = dedupeCoords(alive);
    const board = Board.create(boardRow.width, boardRow.height, boardRow.boundary, coords);
    const next = boardRow.latestVersion + 1;
    this.store.db
      .prepare(`INSERT INTO board_versions (board_id, version, rle, note) VALUES (?,?,?,?)`)
      .run(boardId, next, board.toRle(), note ?? `编辑版本 ${next}`);
    return {
      boardId,
      version: next,
      duplicates,
      warning: duplicates > 0 ? `检测到 ${duplicates} 个重复活点，已按一个细胞处理` : null,
      population: board.population(),
      alive: board.aliveCoords(),
    };
  }

  private loadBoardForVersion(boardId: number, version: number | 'latest'): {
    board: Board;
    versionNumber: number;
  } {
    const boardRow = this.getBoard(boardId);
    const versionNumber = version === 'latest' ? boardRow.latestVersion : version;
    const { row } = this.getVersion(boardId, versionNumber);
    return {
      board: Board.fromRle(boardRow.width, boardRow.height, boardRow.boundary, row.rle),
      versionNumber,
    };
  }

  private getVersionId(boardId: number, versionNumber: number): number {
    const row = this.store.db
      .prepare(`SELECT id FROM board_versions WHERE board_id = ? AND version = ?`)
      .get(boardId, versionNumber) as { id: number };
    return row.id;
  }

  /**
   * 演化到目标代并持久化一次运行。
   * 采用签名映射检测完全相同棋盘；命中周期后用取模安全跳算，
   * 但返回的代数语义始终是目标代。
   */
  run(boardId: number, targetGen: number, mode: 'single' | 'batch', version: number | 'latest' = 'latest'): GenResult {
    if (!Number.isInteger(targetGen) || targetGen < 0) {
      throw new AppError('VALIDATION_ERROR', '目标代数必须为不小于 0 的整数');
    }
    if (targetGen > LIMITS.MAX_STEPS) {
      throw new AppError('PAYLOAD_TOO_LARGE', `目标代数不得超过 ${LIMITS.MAX_STEPS}`);
    }
    const { board: initBoard, versionNumber } = this.loadBoardForVersion(boardId, version);
    const versionId = this.getVersionId(boardId, versionNumber);

    const runInfo = this.store.db
      .prepare(`INSERT INTO runs (board_id, version_id, target_gen, mode) VALUES (?,?,?,?)`)
      .run(boardId, versionId, targetGen, mode);
    const runId = Number(runInfo.lastInsertRowid);

    const insSnap = this.store.db.prepare(
      `INSERT OR REPLACE INTO snapshots (run_id, gen, rle, population, born, survived, died)
       VALUES (?,?,?,?,?,?,?)`,
    );

    const putSnapshot = (gen: number, prev: Board | null, cur: Board) => {
      const diff: Diff = prev === null ? { born: [], survived: [], died: [] } : diffBoards(prev, cur);
      insSnap.run(
        runId,
        gen,
        cur.toRle(),
        cur.population(),
        JSON.stringify(diff.born),
        JSON.stringify(diff.survived),
        JSON.stringify(diff.died),
      );
    };

    putSnapshot(0, null, initBoard);
    const firstSeen = new Map<string, number>([[initBoard.signature(), 0]]);
    let current = initBoard;
    let cycleStart: number | null = null;
    let cyclePeriod: number | null = null;
    let repeatGen: number | null = null;
    let storedMax = 0;

    for (let gen = 1; gen <= targetGen; gen++) {
      const next = current.step();
      const sig = next.signature();
      const prior = firstSeen.get(sig);
      if (prior !== undefined && cycleStart === null) {
        cycleStart = prior;
        repeatGen = gen;
        cyclePeriod = gen - prior;
      }
      if (firstSeen.has(sig) === false) firstSeen.set(sig, gen);

      let storeGen = gen;
      if (cycleStart !== null && cyclePeriod !== null && gen > cycleStart + cyclePeriod - 1) {
        // 仅保留一个周期的快照，之后按模跳算
        storeGen = cycleStart + (((gen - cycleStart) % cyclePeriod) + cyclePeriod) % cyclePeriod;
      }
      const needInsert = storeGen === gen; // 周期内或进入周期前
      if (needInsert) {
        if (storedMax + 1 > LIMITS.MAX_SNAPSHOTS) {
          throw new AppError(
            'PAYLOAD_TOO_LARGE',
            `保存快照数量超过上限 ${LIMITS.MAX_SNAPSHOTS}（未检测到可跳算周期）`,
          );
        }
        putSnapshot(gen, current, next);
        storedMax = gen;
      }
      current = next;
    }

    this.store.db
      .prepare(
        `UPDATE runs SET cycle_start=?, cycle_period=?, first_repeat_gen=?, stored_max=? WHERE id=?`,
      )
      .run(cycleStart, cyclePeriod, repeatGen, storedMax, runId);

    return this.assemble(runId, boardId, versionNumber, targetGen);
  }

  private resolveStoredGen(run: RunRow, gen: number): number {
    if (gen <= (run.stored_max ?? gen)) return gen;
    if (run.cycle_start !== null && run.cycle_period !== null) {
      return run.cycle_start + (((gen - run.cycle_start) % run.cycle_period) + run.cycle_period) % run.cycle_period;
    }
    return gen;
  }

  private assemble(runId: number, boardId: number, versionNumber: number, gen: number): GenResult {
    const run = this.store.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
    if (!run) throw new AppError('NOT_FOUND', `运行 ${runId} 不存在`);
    if (gen > run.target_gen) {
      throw new AppError('VALIDATION_ERROR', `该运行仅演化到第 ${run.target_gen} 代，无法查询第 ${gen} 代`);
    }
    const boardRow = this.getBoard(boardId);
    const storedGen = this.resolveStoredGen(run, gen);
    const snap = this.store.db
      .prepare(`SELECT * FROM snapshots WHERE run_id = ? AND gen = ?`)
      .get(runId, storedGen) as unknown as SnapshotRow | undefined;
    if (!snap) throw new AppError('INTERNAL_ERROR', `第 ${gen} 代快照缺失`);
    const board = Board.fromRle(boardRow.width, boardRow.height, boardRow.boundary, snap.rle);

    let diff: Diff;
    if (gen === 0) {
      diff = { born: [], survived: [], died: [] };
    } else {
      const prevStored = this.resolveStoredGen(run, gen - 1);
      const prevSnap = this.store.db
        .prepare(`SELECT * FROM snapshots WHERE run_id = ? AND gen = ?`)
        .get(runId, prevStored) as unknown as SnapshotRow;
      const prevBoard = Board.fromRle(boardRow.width, boardRow.height, boardRow.boundary, prevSnap.rle);
      diff = diffBoards(prevBoard, board);
    }

    return {
      runId,
      boardId,
      version: versionNumber,
      gen,
      boundary: boardRow.boundary,
      width: boardRow.width,
      height: boardRow.height,
      population: snap.population,
      alive: board.aliveCoords(),
      diff,
      cycle: {
        detected: run.cycle_period !== null,
        firstOccurrenceGen: run.cycle_start,
        repeatGen: run.first_repeat_gen,
        period: run.cycle_period,
      },
    };
  }

  listRuns(boardId?: number): RunRow[] {
    if (boardId !== undefined) {
      this.getBoard(boardId);
      return this.store.db
        .prepare(`SELECT * FROM runs WHERE board_id = ? ORDER BY id`)
        .all(boardId) as unknown as RunRow[];
    }
    return this.store.db.prepare(`SELECT * FROM runs ORDER BY id`).all() as unknown as RunRow[];
  }

  getRun(runId: number) {
    const run = this.store.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
    if (!run) throw new AppError('NOT_FOUND', `运行 ${runId} 不存在`);
    return run;
  }

  queryRunGen(runId: number, gen: number): GenResult {
    const run = this.getRun(runId);
    return this.assemble(runId, run.board_id, this.versionNumberOf(run.version_id), gen);
  }

  private versionNumberOf(versionId: number): number {
    const row = this.store.db.prepare(`SELECT version FROM board_versions WHERE id = ?`).get(versionId) as {
      version: number;
    };
    return row.version;
  }

  renderAscii(result: GenResult, aliveChar = '█', deadChar = '·'): string {
    const lines: string[] = [];
    lines.push(`第 ${result.gen} 代  人口=${result.population}  边界=${result.boundary}  ${result.width}×${result.height}`);
    const live = new Set(result.alive.map((c) => c.y * result.width + c.x));
    for (let y = 0; y < result.height; y++) {
      let line = '';
      for (let x = 0; x < result.width; x++) {
        line += live.has(y * result.width + x) ? aliveChar : deadChar;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}
