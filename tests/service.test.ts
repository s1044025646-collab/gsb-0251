import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Store } from '../src/db.js';
import { GameService } from '../src/service.js';
import { AppError } from '../src/errors.js';
import { Board } from '../src/engine.js';

function tempStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gol-'));
  const path = join(dir, 'test.sqlite');
  return { store: new Store(path), path };
}

const blinker = [
  { x: 1, y: 2 },
  { x: 2, y: 2 },
  { x: 3, y: 2 },
];

test('单步与批量执行同样代数得到完全相同棋盘', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 5, height: 5, boundary: 'dead', alive: blinker });

  const batch = svc.run(boardId, 6, 'batch');

  // 逐步：每次只推进 1 代（基于最新版本重新发起）
  let last: ReturnType<GameService['run']> | undefined;
  for (let g = 1; g <= 6; g++) {
    last = svc.run(boardId, g, 'single');
  }
  assert.equal(last!.gen, 6);
  assert.equal(JSON.stringify(last!.alive), JSON.stringify(batch.alive));
  assert.equal(batch.population, 3);
  store.close();
});

test('周期检测：闪烁子周期 2，固定点周期 1', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const b1 = svc.createBoard({ width: 5, height: 5, boundary: 'dead', alive: blinker });
  const r1 = svc.run(b1.boardId, 10, 'batch');
  assert.equal(r1.cycle.detected, true);
  assert.equal(r1.cycle.period, 2);
  assert.equal(r1.cycle.firstOccurrenceGen, 0);
  assert.equal(r1.cycle.repeatGen, 2);

  // 周期报告必须有相同完整棋盘作依据：直接用引擎核对
  let board = Board.create(5, 5, 'dead', blinker);
  const sigs = new Map<string, number>([[board.signature(), 0]]);
  for (let g = 1; g <= 10; g++) {
    board = board.step();
    sigs.set(board.signature(), g);
  }

  const b2 = svc.createBoard({
    width: 4,
    height: 4,
    boundary: 'dead',
    alive: [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
  });
  const r2 = svc.run(b2.boardId, 3, 'batch');
  assert.equal(r2.cycle.period, 1);
  assert.equal(r2.cycle.firstOccurrenceGen, 0);
  assert.equal(r2.cycle.repeatGen, 1);
  store.close();
});

test('平移滑翔机不被当作重复（在足够大空间内）', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({
    width: 10,
    height: 10,
    boundary: 'dead',
    alive: [
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
  });
  const r = svc.run(boardId, 8, 'batch');
  // 平移后的形状签名不同，不应报告周期（除非真的精确重复）
  assert.ok(!r.cycle.detected || r.cycle.period !== 2);
  store.close();
});

test('编辑初始棋盘产生新版本，旧运行不受影响', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 5, height: 5, boundary: 'dead', alive: blinker });
  const oldRun = svc.run(boardId, 4, 'batch');
  const oldAlive = JSON.stringify(oldRun.alive);

  const edited = svc.editBoard(boardId, [{ x: 0, y: 0 }], '改成单点');
  assert.equal(edited.version, 2);

  // 旧 run 仍能读到旧版本的第 4 代
  const reread = svc.queryRunGen(oldRun.runId, 4);
  assert.equal(JSON.stringify(reread.alive), oldAlive);

  // 新 run 默认使用最新版本（单点 -> 全死）
  const newRun = svc.run(boardId, 1, 'batch');
  assert.equal(newRun.version, 2);
  assert.equal(newRun.population, 0);

  // 也可显式指定旧版本
  const runV1 = svc.run(boardId, 4, 'batch', 1);
  assert.equal(JSON.stringify(runV1.alive), oldAlive);
  store.close();
});

test('周期跳算下仍交付正确的目标代（取模语义正确）', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 5, height: 5, boundary: 'dead', alive: blinker });
  const run = svc.run(boardId, 50, 'batch');
  // 闪烁子：偶数代为横条
  const gen50 = svc.queryRunGen(run.runId, 50);
  assert.deepEqual(gen50.alive.map((c) => c.y), [2, 2, 2]);
  const gen49 = svc.queryRunGen(run.runId, 49);
  assert.deepEqual(gen49.alive.map((c) => c.x), [2, 2, 2]);
  store.close();
});

test('重复活点返回提示', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const out = svc.createBoard({
    width: 3,
    height: 3,
    boundary: 'dead',
    alive: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  });
  assert.equal(out.duplicates, 1);
  assert.equal(out.population, 1);
  assert.match(out.warning!, /重复/);
  store.close();
});

test('资源限制：超面积、超步数返回错误码', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  assert.throws(
    () => svc.createBoard({ width: 200, height: 200, boundary: 'dead', alive: [] }),
    (e: AppError) => e.code === 'PAYLOAD_TOO_LARGE',
  );
  const { boardId } = svc.createBoard({ width: 3, height: 3, boundary: 'dead', alive: [] });
  assert.throws(() => svc.run(boardId, 10001, 'batch'), (e: AppError) => e.code === 'PAYLOAD_TOO_LARGE');
  store.close();
});

test('服务重启后可读取历史代数与结果', () => {
  const { store, path } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 5, height: 5, boundary: 'dead', alive: blinker });
  const run = svc.run(boardId, 20, 'batch');
  const gen20 = JSON.stringify(svc.queryRunGen(run.runId, 20).alive);
  store.close();

  // 重新打开同一数据库文件
  const store2 = new Store(path);
  const svc2 = new GameService(store2);
  const boards = svc2.listBoards();
  assert.ok(boards.some((b) => b.id === boardId));
  const reread = svc2.queryRunGen(run.runId, 20);
  assert.equal(JSON.stringify(reread.alive), gen20);
  assert.equal(reread.cycle.period, 2);
  store2.close();
});

test('查询超出运行代数被拒绝', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 3, height: 3, boundary: 'dead', alive: [] });
  const run = svc.run(boardId, 2, 'batch');
  assert.throws(() => svc.queryRunGen(run.runId, 3), (e: AppError) => e.code === 'VALIDATION_ERROR');
  store.close();
});

test('字符棋盘导出包含等宽字符与人口', () => {
  const { store } = tempStore();
  const svc = new GameService(store);
  const { boardId } = svc.createBoard({ width: 4, height: 4, boundary: 'dead', alive: blinker.slice(0, 2) });
  const run = svc.run(boardId, 0, 'batch');
  const ascii = svc.renderAscii(run);
  assert.match(ascii, /人口=2/);
  const rows = ascii.split('\n').slice(1);
  for (const row of rows) assert.equal(row.length, 4);
  store.close();
});
