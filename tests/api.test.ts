import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createApp, listenOnFreePort } from '../src/server.js';

async function call(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('API 全流程：建模、批量演化、历史查询、ASCII 导出、错误码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gol-api-'));
  const app = createApp(join(dir, 'api.sqlite'));
  const port = await listenOnFreePort(app.server);

  try {
    const limits = await call(port, 'GET', '/api/limits');
    assert.equal(limits.status, 200);
    assert.equal(limits.json.data.maxArea, 10000);

    const created = await call(port, 'POST', '/api/boards', {
      width: 5,
      height: 5,
      boundary: 'dead',
      alive: [
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 3, y: 2 },
      ],
    });
    assert.equal(created.status, 200);
    const boardId = created.json.data.boardId;

    const ran = await call(port, 'POST', `/api/boards/${boardId}/run`, { targetGen: 4, mode: 'batch' });
    assert.equal(ran.status, 200);
    assert.equal(ran.json.data.gen, 4);
    assert.equal(ran.json.data.cycle.period, 2);
    const runId = ran.json.data.runId;

    const gen3 = await call(port, 'GET', `/api/runs/${runId}/generations/3`);
    assert.equal(gen3.status, 200);
    assert.equal(gen3.json.data.population, 3);

    const ascii = await call(port, 'GET', `/api/runs/${runId}/generations/0/ascii`);
    assert.match(ascii.json.data.ascii, /第 0 代/);

    // 校验错误：越界坐标
    const bad = await call(port, 'POST', '/api/boards', {
      width: 3,
      height: 3,
      boundary: 'dead',
      alive: [{ x: 9, y: 9 }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION_ERROR');

    // 非法 JSON
    const res = await fetch(`http://127.0.0.1:${port}/api/boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'INVALID_JSON');

    // 404
    const nf = await call(port, 'GET', '/api/boards/9999');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'NOT_FOUND');
  } finally {
    app.close();
  }
});
