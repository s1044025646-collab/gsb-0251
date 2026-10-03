export type Boundary = 'fixed' | 'torus';

export interface Cell {
  x: number;
  y: number;
}

export interface BoardSpec {
  width: number;
  height: number;
  boundary: Boundary;
  alive: Cell[];
}

export interface Diff {
  survived: Cell[];
  born: Cell[];
  died: Cell[];
}

export interface GenerationResult extends Diff {
  population: number;
}

export const MIN_SIDE = 3;
export const MAX_AREA = 10_000;

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/** 规范化棋盘输入：校验尺寸、边界、坐标，去重。返回去重后的活点。 */
export function normalizeSpec(spec: BoardSpec): { cells: Cell[]; duplicates: number } {
  const { width, height, boundary, alive } = spec;

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ValidationError('INVALID_DIMENSION', '宽高必须为整数');
  }
  if (width < MIN_SIDE || height < MIN_SIDE) {
    throw new ValidationError('INVALID_DIMENSION', `棋盘最小尺寸为 ${MIN_SIDE}×${MIN_SIDE}`);
  }
  if (width * height > MAX_AREA) {
    throw new ValidationError('LIMIT_EXCEEDED', `棋盘面积超出上限 ${MAX_AREA}`);
  }
  if (boundary !== 'fixed' && boundary !== 'torus') {
    throw new ValidationError('INVALID_BOUNDARY', "边界方式必须为 'fixed' 或 'torus'");
  }
  if (!Array.isArray(alive)) {
    throw new ValidationError('INVALID_ALIVE', 'alive 必须为坐标数组');
  }

  const seen = new Set<number>();
  const cells: Cell[] = [];
  let duplicates = 0;

  for (const c of alive) {
    if (!c || !Number.isInteger(c.x) || !Number.isInteger(c.y)) {
      throw new ValidationError('INVALID_CELL', '坐标必须为整数 {x,y}');
    }
    if (c.x < 0 || c.x >= width || c.y < 0 || c.y >= height) {
      throw new ValidationError(
        'OUT_OF_BOUNDS',
        `坐标 (${c.x},${c.y}) 越界，棋盘为 ${width}×${height}，原点 (0,0)`,
      );
    }
    const key = c.y * width + c.x;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    cells.push({ x: c.x, y: c.y });
  }

  sortCells(cells);
  return { cells, duplicates };
}

export function sortCells(cells: Cell[]): void {
  cells.sort((a, b) => (a.y - b.y || a.x - b.x));
}

/**
 * 单代同步演化（正式引擎，稀疏集合实现）。
 * 所有格子仅依据上一代计算；先完整计算出下一代集合，再做差异比对。
 */
export function step(
  width: number,
  height: number,
  boundary: Boundary,
  prev: Cell[],
): GenerationResult {
  const alive = new Set<number>(prev.map((c) => c.y * width + c.x));
  const next = new Set<number>();
  const neighborCache = new Map<number, number>();

  const consider = (nx: number, ny: number) => {
    let x = nx;
    let y = ny;
    if (boundary === 'torus') {
      x = (nx + width) % width;
      y = (ny + height) % height;
    } else if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      return;
    }
    const k = y * width + x;
    neighborCache.set(k, (neighborCache.get(k) ?? 0) + 1);
  };

  for (const c of prev) {
    const key = c.y * width + c.x;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        consider(c.x + dx, c.y + dy);
      }
    }
  }

  for (const [key, count] of neighborCache) {
    const isAlive = alive.has(key);
    if ((isAlive && (count === 2 || count === 3)) || (!isAlive && count === 3)) {
      next.add(key);
    }
  }
  const nextCells: Cell[] = [];
  for (const key of next) nextCells.push({ x: key % width, y: Math.floor(key / width) });
  sortCells(nextCells);

  return diffCells(prev, nextCells);
}

/**
 * 稠密双缓冲参考实现：直接在 Uint8Array 上逐格计算，作为小棋盘基准核对正式引擎。
 */
export function stepDense(
  width: number,
  height: number,
  boundary: Boundary,
  prev: Cell[],
): GenerationResult {
  const a = new Uint8Array(width * height);
  for (const c of prev) a[c.y * width + c.x] = 1;
  const b = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          let nx = x + dx;
          let ny = y + dy;
          if (boundary === 'torus') {
            nx = (nx + width) % width;
            ny = (ny + height) % height;
            if (a[ny * width + nx]) n++;
          } else if (nx >= 0 && nx < width && ny >= 0 && ny < height && a[ny * width + nx]) {
            n++;
          }
        }
      }
      const alive = a[y * width + x] === 1;
      if ((alive && (n === 2 || n === 3)) || (!alive && n === 3)) {
        b[y * width + x] = 1;
      }
    }
  }

  const next: Cell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (b[y * width + x]) next.push({ x, y });
    }
  }
  return diffCells(prev, next);
}

/** 比对两代，返回存活 / 出生 / 死亡，并附带人口。 */
export function diffCells(prev: Cell[], next: Cell[]): GenerationResult {
  const key = (c: Cell) => `${c.x}:${c.y}`;
  const prevSet = new Set(prev.map(key));
  const nextSet = new Set(next.map(key));

  const survived: Cell[] = [];
  const born: Cell[] = [];
  const died: Cell[] = [];

  for (const c of prev) {
    if (nextSet.has(key(c))) survived.push(c);
    else died.push(c);
  }
  for (const c of next) {
    if (!prevSet.has(key(c))) born.push(c);
  }

  sortCells(survived);
  sortCells(died);
  sortCells(born);

  return { survived, born, died, population: next.length };
}

/** 将差异应用到上一代，必须恢复出目标棋盘。 */
export function applyDiff(prev: Cell[], diff: Diff): Cell[] {
  const key = (c: Cell) => `${c.x}:${c.y}`;
  const out = new Map<string, Cell>();
  for (const c of prev) out.set(key(c), c);
  for (const c of diff.died) out.delete(key(c));
  for (const c of diff.born) out.set(key(c), c);
  const cells = [...out.values()];
  sortCells(cells);
  return cells;
}

export function sameBoard(a: Cell[], b: Cell[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((c) => `${c.x}:${c.y}`));
  for (const c of b) if (!sa.has(`${c.x}:${c.y}`)) return false;
  return true;
}

export interface EvolvedGeneration {
  generation: number;
  cells: Cell[];
  diff: Diff;
  population: number;
}

/**
 * 连续演化到第 targetGen 代（generation 0 为初始棋盘）。
 * 同时检测完整棋盘重复：返回第一次出现代数与周期（无重复为 null）。
 * 检测基于完整坐标集合，平移相似形状不会被当作重复。
 */
export function evolve(
  spec: BoardSpec,
  targetGen: number,
): { generations: EvolvedGeneration[]; firstSeen: number | null; period: number | null } {
  if (!Number.isInteger(targetGen) || targetGen < 0) {
    throw new ValidationError('INVALID_GENERATION', '目标代数必须为非负整数');
  }

  const { width, height, boundary } = spec;
  let current = spec.alive;
  const generations: EvolvedGeneration[] = [
    {
      generation: 0,
      cells: current,
      diff: { survived: [], born: [], died: [] },
      population: current.length,
    },
  ];

  const seen = new Map<string, number>();
  seen.set(encodeCells(current, width), 0);
  let firstSeen: number | null = null;
  let period: number | null = null;

  for (let g = 1; g <= targetGen; g++) {
    const result = step(width, height, boundary, current);
    current = [...result.survived, ...result.born];
    sortCells(current);

    generations.push({
      generation: g,
      cells: current,
      diff: { survived: result.survived, born: result.born, died: result.died },
      population: result.population,
    });

    if (firstSeen === null) {
      const sig = encodeCells(current, width);
      const prior = seen.get(sig);
      if (prior !== undefined) {
        firstSeen = prior;
        period = g - prior;
      } else {
        seen.set(sig, g);
      }
    }
  }

  return { generations, firstSeen, period };
}

export function encodeCells(cells: Cell[], width: number): string {
  const pts = cells.map((c) => `${c.x}:${c.y}`);
  pts.sort((a, b) => {
    const [ax, ay] = a.split(':').map(Number);
    const [bx, by] = b.split(':').map(Number);
    return ay - by || ax - bx;
  });
  return pts.join(',');
}

export function decodeCells(encoded: string): Cell[] {
  if (encoded === '') return [];
  return encoded.split(',').map((tok) => {
    const [x, y] = tok.split(':').map(Number);
    return { x, y };
  });
}

/**
 * 字符棋盘导出。活细胞 '#'，死细胞 '.'，行末换行。
 * 坐标原点 (0,0) 位于左上角，x 向右、y 向下。
 */
export function renderBoard(
  width: number,
  height: number,
  cells: Cell[],
  opts: { alive?: string; dead?: string } = {},
): string {
  const aliveCh = opts.alive ?? '#';
  const deadCh = opts.dead ?? '.';
  const grid = new Uint8Array(width * height);
  for (const c of cells) grid[c.y * width + c.x] = 1;
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) line += grid[y * width + x] ? aliveCh : deadCh;
    lines.push(line);
  }
  return lines.join('\n');
}
