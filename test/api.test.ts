import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { openDb } from '../src/db';
import { LifeService } from '../src/service';
import { createApp } from '../src/api';
import { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

let dir: string;
let server: Server;
let base: string;
let db: DatabaseSync;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'golife-api-'));
  db = openDb(join(dir, 'api.db'));
  server = createApp(new LifeService(db));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('健康检查与限制', async () => {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.data.status, 'ok');
  const limits = await call('GET', '/api/limits');
  assert.equal(limits.json.data.maxArea, 10_000);
});

test('建模、演化、查询、渲染全流程', async () => {
  const created = await call('POST', '/api/boards', {
    width: 5,
    height: 5,
    boundary: 'fixed',
    alive: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
  });
  assert.equal(created.status, 200);
  const boardId = created.json.data.id;

  const run = await call('POST', `/api/boards/${boardId}/run`, { targetGeneration: 4 });
  assert.equal(run.status, 200);
  assert.deepEqual(run.json.data.cycle, { firstSeen: 0, period: 2 });
  const runId = run.json.data.id;

  const gen = await call('GET', `/api/runs/${runId}/generations/1`);
  assert.equal(gen.json.data.population, 3);

  const rendered = await call('GET', `/api/runs/${runId}/generations/1/render`);
  assert.match(rendered.json.data.board, /#/);

  const history = await call('GET', `/api/runs/${runId}/generations`);
  assert.equal(history.json.data.length, 5);
});

test('重复坐标返回提示，越界与错误代数返回错误码', async () => {
  const dup = await call('POST', '/api/boards', {
    width: 3,
    height: 3,
    boundary: 'fixed',
    alive: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
  });
  assert.equal(dup.json.data.versions[0].duplicates, 1);
  assert.equal(dup.json.data.versions[0].alive.length, 1);

  const oob = await call('POST', '/api/boards', {
    width: 3, height: 3, boundary: 'fixed', alive: [{ x: 9, y: 0 }],
  });
  assert.equal(oob.status, 400);
  assert.equal(oob.json.error.code, 'OUT_OF_BOUNDS');

  const missing = await call('GET', '/api/runs/99999/generations/0');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  const unknown = await call('GET', '/nope');
  assert.equal(unknown.status, 404);
});

