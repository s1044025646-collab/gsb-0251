import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { LifeService, MAX_STEPS } from '../src/service';
import { ValidationError, sameBoard, step } from '../src/core';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'golife-'));
});
after(() => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Windows 下 WAL 句柄释放可能略有延迟，短暂重试
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

test('建模、运行、查询代数与差异、字符导出', () => {
  const db = openDb(join(dir, 'a.db'));
  const svc = new LifeService(db);
  const board = svc.createBoard({
    width: 5, height: 5, boundary: 'fixed',
    alive: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
  });
  assert.equal(board.currentVersion, 1);

  const run = svc.runEvolution(board.id, 4);
  assert.equal(run.targetGeneration, 4);
  assert.deepEqual(run.cycle, { firstSeen: 0, period: 2 });

  const g1 = svc.getGeneration(run.id, 1);
  assert.equal(g1.population, 3);
  assert.ok(g1.diff.born.some((c) => c.x === 2 && (c.y === 1 || c.y === 3)));
  assert.equal(g1.diff.died.length, 2);

  const history = svc.listGenerations(run.id);
  assert.deepEqual(history.map((h) => h.generation), [0, 1, 2, 3, 4]);
  assert.deepEqual(history.map((h) => h.population), [3, 3, 3, 3, 3]);

  const rendered = svc.renderGeneration(run.id, 1);
  assert.match(rendered, /#/);
  db.close();
});

test('编辑初始棋盘产生新版本，旧运行不改变', () => {
  const db = openDb(join(dir, 'b.db'));
  const svc = new LifeService(db);
  const board = svc.createBoard({
    width: 4, height: 4, boundary: 'fixed',
    alive: [{ x: 0, y: 0 }],
  });
  const runBefore = svc.runEvolution(board.id, 1);
  const beforeG1 = svc.getGeneration(runBefore.id, 1);

  const edited = svc.editBoard(board.id, [
    { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ]);
  assert.equal(edited.currentVersion, 2);

  // 旧运行快照保持原样
  const stillG1 = svc.getGeneration(runBefore.id, 1);
  assert.deepEqual(stillG1.alive, beforeG1.alive);

  // 新运行基于新版本
  const runV2 = svc.runEvolution(board.id, 2, 2);
  assert.equal(runV2.boardVersion, 2);
  assert.equal(svc.getGeneration(runV2.id, 2).population, 4);

  // 默认运行使用当前版本 2
  const runDefault = svc.runEvolution(board.id, 1);
  assert.equal(runDefault.boardVersion, 2);
  db.close();
});

test('服务重启后可读取历史代数与结果', () => {
  const path = join(dir, 'c.db');
  const db1 = openDb(path);
  const svc1 = new LifeService(db1);
  const board = svc1.createBoard({
    width: 6, height: 6, boundary: 'torus',
    alive: [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
  });
  const run = svc1.runEvolution(board.id, 10);
  const expected = svc1.getGeneration(run.id, 7);
  db1.close();

  const db2 = openDb(path);
  const svc2 = new LifeService(db2);
  const restoredRun = svc2.getRun(run.id);
  assert.equal(restoredRun.boundary, 'torus');
  const g7 = svc2.getGeneration(run.id, 7);
  assert.ok(sameBoard(g7.alive, expected.alive));
  assert.equal(g7.population, expected.population);
  db2.close();
});

test('持久化的每代结果与实时单步一致，差异可重建棋盘', () => {
  const db = openDb(join(dir, 'd.db'));
  const svc = new LifeService(db);
  const alive = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 2 }];
  const board = svc.createBoard({ width: 7, height: 7, boundary: 'torus', alive });
  const run = svc.runEvolution(board.id, 15);

  let current = alive;
  for (let g = 1; g <= 15; g++) {
    const r = step(7, 7, 'torus', current);
    current = [...r.survived, ...r.born].sort((a, b) => a.y - b.y || a.x - b.x);
    const stored = svc.getGeneration(run.id, g);
    assert.ok(sameBoard(stored.alive, current), `第 ${g} 代不一致`);
    assert.equal(stored.population, current.length);
  }
  db.close();
});

test('资源限制与错误码', () => {
  const db = openDb(join(dir, 'e.db'));
  const svc = new LifeService(db);
  const board = svc.createBoard({ width: 3, height: 3, boundary: 'fixed', alive: [] });

  assert.throws(
    () => svc.runEvolution(board.id, MAX_STEPS + 1),
    (e: Error) => (e as ValidationError).code === 'LIMIT_EXCEEDED',
  );
  assert.throws(
    () => svc.getGeneration(999, 0),
    (e: Error) => (e as ValidationError).code === 'NOT_FOUND',
  );

  const run = svc.runEvolution(board.id, 2);
  assert.throws(
    () => svc.getGeneration(run.id, 3),
    (e: Error) => (e as ValidationError).code === 'GENERATION_NOT_FOUND',
  );
  assert.throws(
    () => svc.getBoard(12345),
    (e: Error) => (e as ValidationError).code === 'NOT_FOUND',
  );
  db.close();
});

