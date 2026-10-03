#!/usr/bin/env node
import { join } from 'node:path';
import { Store } from './db.js';
import { GameService, type GenResult } from './service.js';
import { limitsView } from './limits.js';

function usage(): void {
  console.log(`生命游戏 CLI

用法:
  gol limits
  gol create <width> <height> <dead|torus> "[[x,y],...]" [name]
  gol boards
  gol board <boardId>
  gol versions <boardId>
  gol edit <boardId> "[[x,y],...]" [note]
  gol run <boardId> <targetGen> <single|batch> [version]
  gol runs [boardId]
  gol gen <runId> <gen>
  gol export <runId> <gen>
  gol cycle <runId>

数据目录: data/gol.sqlite （可用环境变量 GOL_DB 覆盖）
`);
}

function parseCoords(text: string): { x: number; y: number }[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('坐标必须是 [[x,y],...] 数组');
  return data.map(([x, y]) => ({ x: Number(x), y: Number(y) }));
}

function fmtCoords(coords: { x: number; y: number }[]): string {
  return coords.length ? coords.map((c) => `(${c.x},${c.y})`).join(' ') : '(无)';
}

function printResult(r: GenResult, service: GameService): void {
  console.log(service.renderAscii(r));
  console.log(`出生: ${fmtCoords(r.diff.born)}`);
  console.log(`死亡: ${fmtCoords(r.diff.died)}`);
  console.log(`存活: ${r.diff.survived.length} 个`);
  if (r.cycle.detected) {
    console.log(
      `周期: 检测到循环，第 ${r.cycle.firstOccurrenceGen} 代首次出现，第 ${r.cycle.repeatGen} 代重复，周期=${r.cycle.period}`,
    );
  } else {
    console.log('周期: 截至目标代尚未检测到完全相同棋盘');
  }
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return;
  }
  const dbPath = process.env.GOL_DB || join(process.cwd(), 'data', 'gol.sqlite');
  const store = new Store(dbPath);
  const service = new GameService(store);

  try {
    switch (cmd) {
      case 'limits':
        console.log(JSON.stringify(limitsView(), null, 2));
        break;
      case 'create': {
        const [w, h, boundary, coordsText, name] = args;
        const out = service.createBoard({
          width: Number(w),
          height: Number(h),
          boundary: boundary as 'dead' | 'torus',
          alive: parseCoords(coordsText ?? '[]'),
          name,
        });
        console.log(`已创建棋盘 id=${out.boardId} 版本=${out.version} 人口=${out.population}`);
        if (out.warning) console.log(`提示: ${out.warning}`);
        break;
      }
      case 'boards':
        for (const b of service.listBoards()) {
          console.log(
            `#${b.id} ${b.name} ${b.width}x${b.height} 边界=${b.boundary} 最新版本见 board 子命令`,
          );
        }
        break;
      case 'board':
        console.log(JSON.stringify(service.getBoard(Number(args[0])), null, 2));
        break;
      case 'versions':
        console.log(JSON.stringify(service.listVersions(Number(args[0])), null, 2));
        break;
      case 'edit': {
        const [boardId, coordsText, note] = args;
        const out = service.editBoard(Number(boardId), parseCoords(coordsText ?? '[]'), note);
        console.log(`已生成新版本 board=${out.boardId} version=${out.version} 人口=${out.population}`);
        if (out.warning) console.log(`提示: ${out.warning}`);
        break;
      }
      case 'run': {
        const [boardId, gen, mode, version] = args;
        const r = service.run(
          Number(boardId),
          Number(gen),
          mode === 'single' ? 'single' : 'batch',
          version === undefined ? 'latest' : Number(version),
        );
        printResult(r, service);
        console.log(`runId=${r.runId}`);
        break;
      }
      case 'runs':
        console.log(JSON.stringify(service.listRuns(args[0] === undefined ? undefined : Number(args[0])), null, 2));
        break;
      case 'gen': {
        const r = service.queryRunGen(Number(args[0]), Number(args[1]));
        printResult(r, service);
        break;
      }
      case 'export': {
        const r = service.queryRunGen(Number(args[0]), Number(args[1]));
        console.log(service.renderAscii(r));
        break;
      }
      case 'cycle': {
        const run = service.getRun(Number(args[0]));
        if (run.cycle_period === null) {
          console.log('未检测到周期');
        } else {
          console.log(
            JSON.stringify(
              {
                firstOccurrenceGen: run.cycle_start,
                repeatGen: run.first_repeat_gen,
                period: run.cycle_period,
              },
              null,
              2,
            ),
          );
        }
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`错误 [${(err as any).code ?? 'ERROR'}]: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
