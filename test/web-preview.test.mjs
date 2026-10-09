import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createVideoEditorServer } from '../src/web/server.mjs';

async function rawRequest(app, method, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: app.address.address,
      port: app.address.port,
      path: route,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('streams ready preview and honors a byte range', async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), 'juwon-web-preview-'));
  const jobId = 'web_fixture';
  const outputDir = path.join(jobsRoot, jobId, 'output', 'v001');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'preview.mp4'), Buffer.from('preview'));
  const runner = {
    status: async () => ({
      state: 'ready-for-review',
      history: [{ state: 'ready-for-review', detail: { version: 'v001', outputSha256: 'a'.repeat(64) } }],
    }),
  };
  const app = await createVideoEditorServer({ jobsRoot, runner, host: '127.0.0.1', port: 0 });
  const response = await rawRequest(app, 'GET', `/api/jobs/${jobId}/preview`, { range: 'bytes=1-3' });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 1-3/7');
  assert.equal(response.body.toString(), 'rev');
  assert.equal(response.headers['accept-ranges'], 'bytes');
  await app.close();
});

test('does not serve preview before review readiness or for traversal IDs', async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), 'juwon-web-preview-blocked-'));
  const runner = { status: async () => ({ state: 'rendering', history: [] }) };
  const app = await createVideoEditorServer({ jobsRoot, runner, host: '127.0.0.1', port: 0 });
  const notReady = await rawRequest(app, 'GET', '/api/jobs/web_fixture/preview');
  assert.equal(notReady.status, 404);
  const traversal = await rawRequest(app, 'GET', '/api/jobs/%252e%252e/preview');
  assert.equal(traversal.status, 400);
  await app.close();
});
