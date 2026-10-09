import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createVideoEditorServer } from '../src/web/server.mjs';

async function textRequest(app, route) {
  return new Promise((resolve, reject) => {
    const req = request({ host: app.address.address, port: app.address.port, path: route }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves local editor page with YouTube input and review-only copy', async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), 'juwon-web-static-'));
  const app = await createVideoEditorServer({
    jobsRoot,
    runner: { status: async () => ({ state: 'queued', history: [] }) },
    host: '127.0.0.1',
    port: 0,
  });
  const page = await textRequest(app, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /YouTube URL/);
  assert.match(page.body, /longform[\s·-]+condense/i);
  assert.match(page.body, /검토/);
  assert.match(page.body, /class="app-header"/);
  assert.match(page.body, /class="workspace-grid"/);
  assert.match(page.body, /class="[^"]*\bworkflow-card\b/);
  assert.match(page.body, /id="queue-panel"/);
  assert.match(page.body, /id="queue-list"/);
  assert.match(page.body, /id="blocked-reason"/);
  assert.match(page.body, /<select id="ollama-model"/);
  assert.match(page.body, /qwen3:4b/);
  assert.match(page.body, /custom-ollama-model/);
  assert.match(page.body, /id="personal-permission"/);
  assert.match(page.body, /개인 이메일로 사용 허가/);
  assert.match(page.body, /id="permission-note"/);
  assert.doesNotMatch(page.body, /upload/i);
  await app.close();
});
