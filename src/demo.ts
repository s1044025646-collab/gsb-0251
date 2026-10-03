import { Board, type BoundaryMode, type Coord, diffBoards } from './engine.js';

function show(title: string, board: Board): void {
  console.log(`\n=== ${title} ===`);
  console.log(`人口=${board.population()}`);
  for (let y = 0; y < board.height; y++) {
    let line = '';
    for (let x = 0; x < board.width; x++) line += board.isAlive(x, y) ? '█' : '·';
    console.log(line);
  }
}

function showDiff(prev: Board, next: Board): void {
  const d = diffBoards(prev, next);
  const f = (cs: Coord[]) => (cs.length ? cs.map((c) => `(${c.x},${c.y})`).join(' ') : '无');
  console.log(`  出生: ${f(d.born)}`);
  console.log(`  死亡: ${f(d.died)}`);
  console.log(`  存活数: ${d.survived.length}`);
}

function evolve(title: string, start: Board, gens: number, detectCycle = false): void {
  show(`${title} 第0代`, start);
  let cur = start;
  const seen = new Map<string, number>([[cur.signature(), 0]]);
  for (let g = 1; g <= gens; g++) {
    const next = cur.step();
    console.log(`\n-- 第 ${g} 代 --`);
    showDiff(cur, next);
    show(`${title} 第${g}代`, next);
    if (detectCycle) {
      const prior = seen.get(next.signature());
      if (prior !== undefined) {
        console.log(`>> 检测到完全相同棋盘：首次第 ${prior} 代，第 ${g} 代重复，周期=${g - prior}`);
        detectCycle = false;
      } else {
        seen.set(next.signature(), g);
      }
    }
    cur = next;
  }
}

function gliderBoard(w: number, h: number, boundary: BoundaryMode): Board {
  return Board.create(w, h, boundary, [
    { x: 1, y: 0 },
    { x: 2, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ]);
}

console.log('########## 1. 稳定方块（周期 1）##########');
const block = Board.create(4, 4, 'dead', [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 1, y: 2 },
  { x: 2, y: 2 },
]);
evolve('稳定方块', block, 2, true);

console.log('\n########## 2. 闪烁子（周期 2）##########');
const blinker = Board.create(5, 5, 'dead', [
  { x: 1, y: 2 },
  { x: 2, y: 2 },
  { x: 3, y: 2 },
]);
evolve('闪烁子', blinker, 4, true);

console.log('\n########## 3. 滑翔机（会平移，4 代后形状重复但位置移动）##########');
evolve('滑翔机', gliderBoard(8, 8, 'dead'), 4, false);

console.log('\n########## 4. 同一边缘布局：固定死边界 vs 环面边界 ##########');
// 活点贴在左上角，环面下邻居会从右/下边缘绕回；死边界外邻居恒死。
const edge: Coord[] = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 5 },
];
for (const boundary of ['dead', 'torus'] as BoundaryMode[]) {
  const b = Board.create(6, 6, boundary, edge);
  console.log(`\n----- 边界=${boundary} -----`);
  show('第0代', b);
  const n1 = b.step();
  showDiff(b, n1);
  show('第1代', n1);
  const n2 = n1.step();
  show('第2代', n2);
}

console.log('\n########## 5. 环面角落环绕检查 ##########');
const corner = Board.create(5, 5, 'torus', [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 0, y: 4 },
]);
show('角落三点', corner);
show('演化一代（注意绕回）', corner.step());
