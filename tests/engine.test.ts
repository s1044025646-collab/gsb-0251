import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Board,
  applyDiff,
  dedupeCoords,
  diffBoards,
} from '../src/engine.js';
import { AppError } from '../src/errors.js';

/**
 * 独立的稠密双缓冲基准实现（与正式引擎分开书写），
 * 用于多代结果交叉核对。
 */
function referenceStep(live: Set<number>, w: number, h: number, torus: boolean): Set<number> {
  const at = (x: number, y: number) => {
    if (torus) {
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
    } else if (x < 0 || y < 0 || x >= w || y >= h) {
      return false;
    }
    return live.has(y * w + x);
  };
  const out = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && at(x + dx, y + dy)) n++;
      const alive = live.has(y * w + x);
      if (n === 3 || (alive && n === 2)) out.add(y * w + x);
    }
  }
  return out;
}

function setOf(b: Board): Set<number> {
  return new Set(b.aliveCoords().map((c) => c.y * b.width + c.x));
}

test('出生规则：死细胞邻居数 0..8，仅 3 邻居出生', () => {
  // 3x3 棋盘，中心为死细胞，外圈放置 k 个活邻居；其余位置全死。
  for (let k = 0; k <= 8; k++) {
    const ring = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ];
    const board = Board.create(3, 3, 'dead', ring.slice(0, k));
    const next = board.step();
    assert.equal(next.isAlive(1, 1), k === 3, `k=${k} 时中心出生应等价于 k===3`);
  }
});

test('生存规则：活细胞邻居数 0..8，仅 2 或 3 存活', () => {
  for (let k = 0; k <= 8; k++) {
    const ring = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ];
    const alive = [...ring.slice(0, k), { x: 1, y: 1 }];
    const board = Board.create(3, 3, 'dead', alive);
    const next = board.step();
    assert.equal(next.isAlive(1, 1), k === 2 || k === 3, `k=${k} 生存判定错误`);
  }
});

test('同步更新：闪烁子在同一代扫描期间不被中途修改', () => {
  const b = Board.create(5, 5, 'dead', [
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ]);
  const n1 = b.step();
  assert.deepEqual(
    n1.aliveCoords(),
    [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ],
  );
  const n2 = n1.step();
  assert.deepEqual(
    n2.aliveCoords(),
    [
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ],
  );
});

test('矩形棋盘：非正方形尺寸正常演化', () => {
  const b = Board.create(4, 3, 'dead', [
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
  const n1 = b.step();
  assert.ok(n1.isAlive(1, 0));
  assert.ok(n1.isAlive(1, 1));
  assert.ok(n1.isAlive(1, 2));
  assert.equal(n1.population(), 3);
});

test('最小尺寸 3x3，2x2 被拒绝', () => {
  assert.throws(() => Board.create(2, 2, 'dead', []), AppError);
});

test('越界坐标被拒绝（含负坐标）', () => {
  assert.throws(() => Board.create(3, 3, 'dead', [{ x: 3, y: 0 }]), AppError);
  assert.throws(() => Board.create(3, 3, 'dead', [{ x: 0, y: -1 }]), AppError);
});

test('环面角落环绕：三点跨角互相成为邻居', () => {
  // (0,0) 的环面邻居包含 (4,0),(0,4),(4,4)
  const b = Board.create(5, 5, 'torus', [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 0, y: 4 },
  ]);
  const n = b.step();
  // (4,4) 恰好拥有三个跨角邻居 -> 出生
  assert.ok(n.isAlive(4, 4), '环面下 (4,4) 应有 3 个邻居而出生');
  // 死边界下同布局不会让 (4,4) 出生
  const d = Board.create(5, 5, 'dead', [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 0, y: 4 },
  ]).step();
  assert.ok(!d.isAlive(4, 4));
});

test('全死状态正常处理且保持全死', () => {
  const b = Board.create(4, 4, 'dead', []);
  assert.equal(b.population(), 0);
  let cur = b;
  for (let g = 0; g < 5; g++) {
    assert.equal(cur.population(), 0);
    cur = cur.step();
  }
});

test('重复坐标去重并计数', () => {
  const { coords, duplicates } = dedupeCoords([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 1 },
  ]);
  assert.equal(coords.length, 2);
  assert.equal(duplicates, 3);
});

test('稳定方块为周期 1', () => {
  let b = Board.create(4, 4, 'dead', [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ]);
  const sig0 = b.signature();
  b = b.step();
  assert.equal(b.signature(), sig0);
});

test('多代结果与独立基准实现一致（含两种边界）', () => {
  for (const torus of [false, true]) {
    const seed = [
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 6, y: 0 },
      { x: 0, y: 6 },
    ];
    const w = 8;
    const h = 8;
    let board = Board.create(w, h, torus ? 'torus' : 'dead', seed);
    let ref = setOf(board);
    for (let g = 0; g < 30; g++) {
      board = board.step();
      ref = referenceStep(ref, w, h, torus);
      assert.deepEqual(setOf(board), ref, `第 ${g + 1} 代与基准不一致 (torus=${torus})`);
    }
  }
});

test('差异应用后恢复目标棋盘，且人口=活坐标数', () => {
  let b = Board.create(6, 6, 'torus', [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 5 },
    { x: 5, y: 5 },
  ]);
  for (let g = 0; g < 10; g++) {
    const next = b.step();
    const d = diffBoards(b, next);
    const rebuilt = applyDiff(b, d);
    assert.equal(rebuilt.signature(), next.signature(), `第 ${g + 1} 代差异应用后不一致`);
    assert.equal(next.population(), next.aliveCoords().length);
    assert.equal(d.born.length + d.survived.length, next.population());
    b = next;
  }
});
