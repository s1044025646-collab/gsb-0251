import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import { LifeService } from './service';
import { ValidationError } from './core';

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
  });
}

type Handler = (params: Record<string, string>, body: any, url: URL) => any | Promise<any>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (params: Record<string, string>, body: any, url: URL) => any;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([^/]+)/g, (_m, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler: (params, body, url) => handler(params, body, url) };
}

export function createApp(service: LifeService) {
  const routes: Route[] = [
    route('GET', '/api/health', () => ({ status: 'ok' })),
    route('GET', '/api/limits', () => ({
      minSide: 3,
      maxArea: 10_000,
      maxSteps: 2_000,
      maxSnapshots: 2_000,
    })),
    route('POST', '/api/boards', (_p, b) => service.createBoard(b)),
    route('GET', '/api/boards', () => service.listBoards()),
    route('GET', '/api/boards/:id', (p) => service.getBoard(Number(p.id))),
    route('PUT', '/api/boards/:id', (p, b) => service.editBoard(Number(p.id), b.alive)),
    route('POST', '/api/boards/:id/run', (p, b) =>
      service.runEvolution(Number(p.id), Number(b.targetGeneration), b.version)),
    route('GET', '/api/runs', (_p, _b, url) => {
      const boardId = url.searchParams.get('boardId');
      return service.listRuns(boardId ? Number(boardId) : undefined);
    }),
    route('GET', '/api/runs/:id', (p) => service.getRun(Number(p.id))),
    route('GET', '/api/runs/:id/generations', (p) => service.listGenerations(Number(p.id))),
    route('GET', '/api/runs/:id/generations/:gen', (p) =>
      service.getGeneration(Number(p.id), Number(p.gen))),
    route('GET', '/api/runs/:id/generations/:gen/render', (p) => ({
      board: service.renderGeneration(Number(p.id), Number(p.gen)),
    })),
  ];

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const body = await readBody(req);

      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const result = await r.handler(params, body, url);
        return sendJson(res, 200, { ok: true, data: result });
      }
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知接口' } });
    } catch (err) {
      if (err instanceof ValidationError) {
        const status =
          err.code === 'NOT_FOUND' || err.code === 'GENERATION_NOT_FOUND'
            ? 404
            : err.code === 'LIMIT_EXCEEDED'
              ? 422
              : 400;
        return sendJson(res, status, { ok: false, error: { code: err.code, message: err.message } });
      }
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message } });
    }
  });

  return server;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}
