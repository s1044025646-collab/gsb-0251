#!/usr/bin/env node
import { resolve } from 'node:path';
import { openDb } from './db';
import { LifeService, MAX_STEPS, MAX_SNAPSHOTS } from './service';
import { createApp, findFreePort } from './api';
import { ValidationError, Cell, Boundary } from './core';

const DEFAULT_DB = resolve(process.cwd(), 'data', 'golife.db');

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseCells(text: string | undefined): Cell[] {
  if (!text) throw new ValidationError('INVALID_ALIVE', '需要通过 --alive 提供坐标 JSON，例如 [{"x":1,"y":1}]');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ValidationError('INVALID_ALIVE', '--alive 不是合法 JSON');
  }
  if (!Array.isArray(data)) throw new ValidationError('INVALID_ALIVE', '--alive 必须是坐标数组');
  return data as Cell[];
}

function jsonOut(value: unknown, pretty: boolean) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'help';
  const dbPath = typeof flags.db === 'string' ? flags.db : DEFAULT_DB;
  const pretty = Boolean(flags.pretty);

  const db = openDb(dbPath);
  const service = new LifeService(db);

  let keepOpen = false;
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;

      case 'serve': {
        const requested = flags.port ? Number(flags.port) : await findFreePort();
        if (!Number.isInteger(requested)) throw new ValidationError('INVALID_PORT', '端口必须为整数');
        const server = createApp(service);
        await new Promise<void>((res) => server.listen(requested, '127.0.0.1', res));
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : requested;
        keepOpen = true;
        process.stdout.write(`生命游戏后端已启动: http://127.0.0.1:${port}  (数据库: ${dbPath})\n`);
        process.on('SIGINT', () => {
          db.close();
          process.exit(0);
        });
        break;
      }

      case 'create': {
        const width = Number(flags.width);
        const height = Number(flags.height);
        const boundary = String(flags.boundary ?? 'fixed') as Boundary;
        const alive = parseCells(typeof flags.alive === 'string' ? flags.alive : undefined);
        const result = service.createBoard({ name: flags.name as string, width, height, boundary, alive });
        jsonOut(result, pretty);
        break;
      }

      case 'list':
        jsonOut(service.listBoards(), pretty);
        break;

      case 'show': {
        if (!positional[1]) throw new ValidationError('INVALID_ARGS', '用法: show <boardId>');
        jsonOut(service.getBoard(Number(positional[1])), pretty);
        break;
      }

      case 'edit': {
        if (!positional[1]) throw new ValidationError('INVALID_ARGS', '用法: edit <boardId> --alive ...');
        const result = service.editBoard(Number(positional[1]), parseCells(flags.alive as string));
        jsonOut(result, pretty);
        break;
      }

      case 'run': {
        if (!positional[1]) throw new ValidationError('INVALID_ARGS', '用法: run <boardId> --steps N [--version V]');
        const steps = Number(flags.steps ?? 0);
        const version = flags.version ? Number(flags.version) : undefined;
        jsonOut(service.runEvolution(Number(positional[1]), steps, version), pretty);
        break;
      }

      case 'runs': {
        const boardId = flags.board ? Number(flags.board) : undefined;
        jsonOut(service.listRuns(boardId), pretty);
        break;
      }

      case 'gen': {
        if (!positional[1] || !positional[2]) {
          throw new ValidationError('INVALID_ARGS', '用法: gen <runId> <generation>');
        }
        jsonOut(service.getGeneration(Number(positional[1]), Number(positional[2])), pretty);
        break;
      }

      case 'history': {
        if (!positional[1]) throw new ValidationError('INVALID_ARGS', '用法: history <runId>');
        jsonOut(service.listGenerations(Number(positional[1])), pretty);
        break;
      }

      case 'render': {
        if (!positional[1] || !positional[2]) {
          throw new ValidationError('INVALID_ARGS', '用法: render <runId> <generation>');
        }
        process.stdout.write(service.renderGeneration(Number(positional[1]), Number(positional[2])) + '\n');
        break;
      }

      case 'limits':
        jsonOut({ minSide: 3, maxArea: 10_000, maxSteps: MAX_STEPS, maxSnapshots: MAX_SNAPSHOTS }, pretty);
        break;

      default:
        throw new ValidationError('INVALID_ARGS', `未知命令: ${command}（运行 golife help 查看用法）`);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`错误 [${err.code}]: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    if (!keepOpen) db.close();
  }
}

function printHelp() {
  process.stdout.write(
    [
      'golife — Conway 生命游戏离线演化后端',
      '',
      '用法: golife <命令> [参数] [--db data/golife.db] [--pretty]',
      '',
      '命令:',
      '  serve [--port P]                 启动 HTTP API（默认选择空闲端口）',
      '  create --width W --height H --boundary fixed|torus --alive JSON [--name N]',
      '  list                             列出全部棋盘',
      '  show <boardId>                   查看棋盘与全部版本',
      '  edit <boardId> --alive JSON      编辑初始棋盘（产生新版本）',
      '  run <boardId> --steps N [--version V]   批量演化并保存运行',
      '  runs [--board <boardId>]         列出运行',
      '  gen <runId> <generation>         查询某代活点、人口与差异',
      '  history <runId>                  列出各代人口',
      '  render <runId> <generation>      导出字符棋盘（# 活 / . 死）',
      '  limits                           查看资源限制',
      '',
      'alive JSON 形如 [{"x":0,"y":0},{"x":1,"y":0}]，原点 (0,0) 在左上角。',
      '',
    ].join('\n'),
  );
}

main();
