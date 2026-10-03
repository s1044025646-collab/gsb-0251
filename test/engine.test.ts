import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  step,
  stepDense,
  normalizeSpec,
  ValidationError,
  applyDiff,
  sameBoard,
  evolve,
  renderBoard,
  Cell,
} from '../src/core';

test('出生：死细胞在恰好 3 个邻居时出生；其余邻居数不出生', () => {
  const offsets = [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ];
  for (let k = 0; k <= 8; k++) {
    const alive: Cell[] = offsets.slice(0, k).map((o) => ({ x: 5 + o.x, y: 5 + o.y }));
    const result = step(11, 11, 'fixed', alive);
    const centerBorn = result.born.some((c) => c.x === 5 && c.y === 5);
    assert.equal(centerBorn, k === 3, `k=${k} 时中心出生判定错误`);
  }
});

test('生存：活细胞仅在 2 或 3 个邻居时存活', () => {
  const offsets = [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ];
  for (let k = 0; k <= 8; k++) {
    const center = { x: 5, y: 5 };
    const alive: Cell[] = [center, ...offsets.slice(0, k).map((o) => ({ x: 5 + o.x, y: 5 + o.y }))];
    const result = step(11, 11, 'fixed', alive);
    const centerSurvives = result.survived.some((c) => c.x === 5 && c.y === 5);
    assert.equal(centerSurvives, k === 2 || k === 3, `k=${k} 时中心存活判定错误`);
  }
});

test('矩形非正方形棋盘坐标正确', () => {
  const result = step(7, 4, 'fixed', [
    { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 },
  ]);
  assert.ok(result.born.some((c) => c.x === 3 && c.y === 0));
  assert.ok(result.born.some((c) => c.x === 3 && c.y === 2));
  assert.ok(result.died.some((c) => c.x === 2 && c.y === 1));
  assert.ok(result.died.some((c) => c.x === 4 && c.y === 1));
  assert.equal(result.population, 3);
});

test('固定死边界：边缘细胞界外邻居视为死', () => {
  const fixed = step(5, 5, 'fixed', [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.equal(fixed.population, 0);
});

test('环面边界：角落环绕，对面边互为邻居', () => {
  const alive: Cell[] = [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 4 }];
  const result = step(5, 5, 'torus', alive);
  assert.equal(result.survived.length, 4);
  assert.equal(result.died.length, 0);

  const fixedResult = step(5, 5, 'fixed', alive);
  assert.equal(fixedResult.population, 0);
});

test('全死棋盘始终保持全死', () => {
  for (const boundary of ['fixed', 'torus'] as const) {
    const result = step(4, 4, boundary, []);
    assert.deepEqual(result.born, []);
    assert.deepEqual(result.died, []);
    assert.equal(result.population, 0);
  }
});

test('重复坐标去重并计数，越界与尺寸被拒绝', () => {
  const { cells, duplicates } = normalizeSpec({
    width: 3,
    height: 3,
    boundary: 'fixed',
    alive: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 2 }],
  });
  assert.equal(cells.length, 2);
  assert.equal(duplicates, 2);

  assert.throws(
    () => normalizeSpec({ width: 2, height: 3, boundary: 'fixed', alive: [] }),
    (e: Error) => (e as ValidationError).code === 'INVALID_DIMENSION',
  );
  assert.throws(
    () => normalizeSpec({ width: 3, height: 3, boundary: 'fixed', alive: [{ x: 3, y: 0 }] }),
    (e: Error) => (e as ValidationError).code === 'OUT_OF_BOUNDS',
  );
  assert.throws(
    () => normalizeSpec({ width: 3, height: 3, boundary: 'fixed', alive: [{ x: -1, y: 0 }] }),
    (e: Error) => (e as ValidationError).code === 'OUT_OF_BOUNDS',
  );
  assert.throws(
    () => normalizeSpec({ width: 101, height: 100, boundary: 'fixed', alive: [] }),
    (e: Error) => (e as ValidationError).code === 'LIMIT_EXCEEDED',
  );
});

test('稀疏正式引擎与稠密双缓冲参考引擎多代结果完全一致', () => {
  const initial: Cell[] = [
    { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ];
  for (const boundary of ['fixed', 'torus'] as const) {
    let sparse = initial;
    let dense = initial;
    for (let g = 0; g < 60; g++) {
      const a = step(8, 8, boundary, sparse);
      const b = stepDense(8, 8, boundary, dense);
      sparse = [...a.survived, ...a.born].sort((p, q) => p.y - q.y || p.x - q.x);
      dense = [...b.survived, ...b.born].sort((p, q) => p.y - q.y || p.x - q.x);
      assert.ok(sameBoard(sparse, dense), `boundary=${boundary} 第 ${g + 1} 代两引擎不一致`);
      assert.equal(a.population, b.population);
    }
  }
});

test('差异应用后恢复目标棋盘，人口等于活坐标数量', () => {
  let current: Cell[] = [
    { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ];
  for (let g = 0; g < 20; g++) {
    const result = step(8, 8, 'fixed', current);
    const target = [...result.survived, ...result.born].sort((p, q) => p.y - q.y || p.x - q.x);
    const restored = applyDiff(current, result);
    assert.ok(sameBoard(restored, target));
    assert.equal(restored.length, result.population);
    assert.equal(new Set(restored.map((c) => `${c.x}:${c.y}`)).size, restored.length);
    current = target;
  }
});

test('批量演化与逐代单步结果一致', () => {
  const initial: Cell[] = [
    { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ];
  const { generations } = evolve({ width: 8, height: 8, boundary: 'torus', alive: initial }, 25);
  let current = initial;
  for (let g = 1; g <= 25; g++) {
    const r = step(8, 8, 'torus', current);
    current = [...r.survived, ...r.born].sort((p, q) => p.y - q.y || p.x - q.x);
    assert.ok(sameBoard(current, generations[g].cells), `第 ${g} 代批量与逐步不一致`);
  }
});

test('周期检测：方块周期1、闪烁子周期2、滑翔机平移不判重', () => {
  const block = evolve({
    width: 5, height: 5, boundary: 'fixed',
    alive: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
  }, 3);
  assert.deepEqual([block.firstSeen, block.period], [0, 1]);

  const blinker = evolve({
    width: 5, height: 5, boundary: 'fixed',
    alive: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
  }, 6);
  assert.equal(blinker.period, 2);
  assert.equal(blinker.firstSeen, 0);
  assert.ok(
    sameBoard(blinker.generations[blinker.firstSeen!].cells, blinker.generations[blinker.firstSeen! + 2].cells),
  );

  const glider = evolve({
    width: 12, height: 12, boundary: 'fixed',
    alive: [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
  }, 15);
  assert.equal(glider.period, null);
});

test('全死报周期1；人口相同但布局不同不提前判重', () => {
  const dead = evolve({ width: 3, height: 3, boundary: 'fixed', alive: [] }, 3);
  assert.deepEqual([dead.firstSeen, dead.period], [0, 1]);

  const twoDots = evolve({
    width: 4, height: 4, boundary: 'fixed',
    alive: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  }, 2);
  assert.equal(twoDots.firstSeen, 1);
  assert.equal(twoDots.period, 1);
});

test('字符棋盘导出', () => {
  const text = renderBoard(3, 3, [{ x: 0, y: 0 }, { x: 2, y: 2 }]);
  assert.equal(text, '#..\n...\n..#');
});

test('用户要求固定步数时交付该代，周期不改变代数含义', () => {
  const { generations } = evolve({
    width: 5, height: 5, boundary: 'fixed',
    alive: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
  }, 10);
  assert.equal(generations.length, 11);
  assert.equal(generations[10].generation, 10);
});

