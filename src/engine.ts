import { AppError } from './errors.js';
import { LIMITS } from './limits.js';

export type BoundaryMode = 'dead' | 'torus';

export interface Coord {
  x: number;
  y: number;
}

/**
 * 稠密双缓冲棋盘。
 * 坐标约定：原点 (0,0) 位于左上角；x 向右 [0, width-1]，y 向下 [0, height-1]。
 * 内部用 Uint8Array，活=1，死=0；两代各持一个缓冲，严格同步更新。
 */
export class Board {
  readonly width: number;
  readonly height: number;
  readonly boundary: BoundaryMode;
  private cells: Uint8Array;

  private constructor(
    width: number,
    height: number,
    boundary: BoundaryMode,
    cells: Uint8Array,
  ) {
    this.width = width;
    this.height = height;
    this.boundary = boundary;
    this.cells = cells;
  }

  static create(width: number, height: number, boundary: BoundaryMode, alive: Coord[]): Board {
    validateDimensions(width, height);
    if (boundary !== 'dead' && boundary !== 'torus') {
      throw new AppError('VALIDATION_ERROR', `边界方式必须为 dead 或 torus，收到 ${String(boundary)}`);
    }
    if (!Array.isArray(alive)) {
      throw new AppError('VALIDATION_ERROR', 'alive 必须为坐标数组');
    }
    const cells = new Uint8Array(width * height);
    for (const c of alive) {
      validateCoord(c, width, height);
      cells[c.y * width + c.x] = 1;
    }
    return new Board(width, height, boundary, cells);
  }

  clone(): Board {
    return new Board(this.width, this.height, this.boundary, Uint8Array.from(this.cells));
  }

  isAlive(x: number, y: number): boolean {
    return this.cells[y * this.width + x] === 1;
  }

  aliveCoords(): Coord[] {
    const out: Coord[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.cells[y * this.width + x] === 1) out.push({ x, y });
      }
    }
    return out;
  }

  population(): number {
    let n = 0;
    for (const v of this.cells) if (v === 1) n++;
    return n;
  }

  /** 序列化为稳定字符串，用于逐格精确比对周期（仅内容与边界有关）。 */
  signature(): string {
    return `${this.boundary}|${this.width}x${this.height}|${this.toRle()}`;
  }

  toRle(): string {
    return Array.from(this.cells).join('');
  }

  static fromRle(width: number, height: number, boundary: BoundaryMode, rle: string): Board {
    if (rle.length !== width * height || !/^[01]+$/.test(rle)) {
      throw new AppError('INTERNAL_ERROR', '快照数据损坏');
    }
    const cells = new Uint8Array(width * height);
    for (let i = 0; i < rle.length; i++) cells[i] = rle.charCodeAt(i) - 48;
    return new Board(width, height, boundary, cells);
  }

  /**
   * 演化一代。全部邻居统计均来自当前缓冲（上一代），
   * 结果写入全新缓冲，保证同步更新。
   */
  step(): Board {
    const { width: w, height: h, boundary, cells } = this;
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const neighbors = this.countNeighbors(x, y);
        const alive = cells[y * w + x] === 1;
        // 规则固定：恰好 3 邻居出生；活细胞在 2 或 3 邻居时存活。
        next[y * w + x] = neighbors === 3 || (alive && neighbors === 2) ? 1 : 0;
      }
    }
    return new Board(w, h, boundary, next);
  }

  private countNeighbors(x: number, y: number): number {
    const { width: w, height: h, cells, boundary } = this;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (boundary === 'torus') {
          const tx = (nx + w) % w;
          const ty = (ny + h) % h;
          if (cells[ty * w + tx] === 1) count++;
        } else {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // 固定死边界
          if (cells[ny * w + nx] === 1) count++;
        }
      }
    }
    return count;
  }
}

export interface Diff {
  born: Coord[];
  survived: Coord[];
  died: Coord[];
}

/** 计算从上一代到下一代的差异（坐标按 y,x 升序，输出稳定）。 */
export function diffBoards(prev: Board, next: Board): Diff {
  const born: Coord[] = [];
  const survived: Coord[] = [];
  const died: Coord[] = [];
  for (let y = 0; y < prev.height; y++) {
    for (let x = 0; x < prev.width; x++) {
      const a = prev.isAlive(x, y);
      const b = next.isAlive(x, y);
      if (!a && b) born.push({ x, y });
      else if (a && b) survived.push({ x, y });
      else if (a && !b) died.push({ x, y });
    }
  }
  return { born, survived, died };
}

/** 把差异应用到上一代，应得到下一代（用于校验）。 */
export function applyDiff(prev: Board, diff: Diff): Board {
  const alive = new Map<string, Coord>();
  for (const c of diff.survived) alive.set(`${c.x},${c.y}`, c);
  for (const c of diff.born) alive.set(`${c.x},${c.y}`, c);
  return Board.create(prev.width, prev.height, prev.boundary, [...alive.values()]);
}

export function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new AppError('VALIDATION_ERROR', 'width 与 height 必须为整数');
  }
  if (width < LIMITS.MIN_SIDE || height < LIMITS.MIN_SIDE) {
    throw new AppError('VALIDATION_ERROR', `棋盘最小尺寸为 ${LIMITS.MIN_SIDE}×${LIMITS.MIN_SIDE}`);
  }
  if (width > LIMITS.MAX_WIDTH || height > LIMITS.MAX_HEIGHT) {
    throw new AppError('VALIDATION_ERROR', `边长不得超过 ${LIMITS.MAX_WIDTH}`);
  }
  if (width * height > LIMITS.MAX_AREA) {
    throw new AppError('PAYLOAD_TOO_LARGE', `棋盘面积不得超过 ${LIMITS.MAX_AREA}`);
  }
}

export function validateCoord(c: Coord, width: number, height: number): void {
  if (
    c === null ||
    typeof c !== 'object' ||
    !Number.isInteger(c.x) ||
    !Number.isInteger(c.y)
  ) {
    throw new AppError('VALIDATION_ERROR', '坐标必须为包含整数 x、y 的对象');
  }
  if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) {
    throw new AppError(
      'VALIDATION_ERROR',
      `坐标 (${c.x},${c.y}) 越界，合法范围 x∈[0,${width - 1}], y∈[0,${height - 1}]`,
    );
  }
}

/** 去除重复活点；返回去重后的坐标与重复数量。 */
export function dedupeCoords(alive: Coord[]): { coords: Coord[]; duplicates: number } {
  const seen = new Set<string>();
  const coords: Coord[] = [];
  let duplicates = 0;
  for (const c of alive) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
      coords.push(c);
    }
  }
  return { coords, duplicates };
}
