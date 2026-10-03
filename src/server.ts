import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError, HTTP_STATUS, type ErrorCode } from './errors.js';
import { limitsView } from './limits.js';
import { Store } from './db.js';
import { GameService } from './service.js';

interface Context {
  service: GameService;
}

type Handler = (ctx: Context, body: any, params: Record<string, string>, url: URL) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route('GET', '/api/limits', (ctx) => limitsView()),
  route('POST', '/api/boards', (ctx, body) => ctx.service.createBoard(body)),
  route('GET', '/api/boards', (ctx) => ctx.service.listBoards()),
  route('GET', '/api/boards/:id', (ctx, _b, p) => ctx.service.getBoard(Number(p.id))),
  route('PUT', '/api/boards/:id', (ctx, body, p) =>
    ctx.service.editBoard(Number(p.id), body.alive, body.note),
  ),
  route('GET', '/api/boards/:id/versions', (ctx, _b, p) => ctx.service.listVersions(Number(p.id))),
  route('POST', '/api/boards/:id/run', (ctx, body, p) =>
    ctx.service.run(
      Number(p.id),
      Number(body.targetGen ?? body.gen ?? 1),
      body.mode === 'single' ? 'single' : 'batch',
      body.version === undefined ? 'latest' : Number(body.version),
    ),
  ),
  route('GET', '/api/boards/:id/runs', (ctx, _b, p) => ctx.service.listRuns(Number(p.id))),
  route('GET', '/api/runs', (ctx) => ctx.service.listRuns()),
  route('GET', '/api/runs/:id', (ctx, _b, p) => ctx.service.getRun(Number(p.id))),
  route('GET', '/api/runs/:id/generations/:gen', (ctx, _b, p) =>
    ctx.service.queryRunGen(Number(p.id), Number(p.gen)),
  ),
  route('GET', '/api/runs/:id/generations/:gen/ascii', (ctx, _b, p) => ({
    ascii: ctx.service.renderAscii(ctx.service.queryRunGen(Number(p.id), Number(p.gen))),
  })),
];

function send(res: ServerResponse, status: number, payload: unknown): void {
  const isAscii = typeof payload === 'object' && payload !== null && 'ascii' in (payload as object);
  res.writeHead(status, {
    'Content-Type': isAscii ? 'application/json; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

export function createApp(dbPath: string): { server: Server; service: GameService; close: () => void } {
  const store = new Store(dbPath);
  const service = new GameService(store);
  const ctx: Context = { service };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        let body: any = {};
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req);
          if (raw.length > 5_000_000) {
            throw new AppError('PAYLOAD_TOO_LARGE', '请求体过大');
          }
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              throw new AppError('INVALID_JSON', '请求体不是合法 JSON');
            }
          }
        }

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(pathname);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => (params[k] = m[i + 1]!));
          const result = await r.handler(ctx, body, params, url);
          send(res, 200, { ok: true, data: result });
          return;
        }

        const anyMatch = routes.some((r) => r.pattern.test(pathname));
        if (anyMatch) throw new AppError('METHOD_NOT_ALLOWED', '方法不被允许');
        throw new AppError('NOT_FOUND', `路径 ${pathname} 不存在`);
      } catch (err) {
        if (err instanceof AppError) {
          send(res, HTTP_STATUS[err.code], {
            ok: false,
            error: { code: err.code, message: err.message, details: err.details ?? null },
          });
        } else {
          send(res, 500, {
            ok: false,
            error: { code: 'INTERNAL_ERROR' as ErrorCode, message: (err as Error).message },
          });
        }
      }
    })();
  });

  return {
    server,
    service,
    close: () => {
      server.close();
      store.close();
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function listenOnFreePort(server: Server, preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && (preferred === undefined || preferred === 0)) {
          tryListen(0);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(preferred ?? 0);
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const dbPath = process.env.GOL_DB || join(process.cwd(), 'data', 'gol.sqlite');
  const app = createApp(dbPath);
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  listenOnFreePort(app.server, preferred)
    .then((port) => {
      console.log(`生命游戏后端已启动: http://127.0.0.1:${port}`);
      console.log(`数据库: ${dbPath}`);
      console.log('提示: 用 --port 或环境变量 PORT 指定端口；默认自动选择空闲端口。');
    })
    .catch((err) => {
      console.error('启动失败', err);
      process.exit(1);
    });
}
