import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createVideoEditorServer } from '../src/web/server.mjs';

async function jsonRequest(app, method, route, body) {
  const address = app.address;
  return new Promise((resolve, reject) => {
    const req = request({
      host: address.address,
      port: address.port,
      path: route,
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function startTestServer(runner, options = {}) {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), 'juwon-web-server-'));
  return createVideoEditorServer({
    jobsRoot,
    runner,
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
}

test('creates one queued job and exposes redacted persisted status', async () => {
  const calls = [];
  const runner = {
    run: async (input) => {
      calls.push(input);
      return {
        jobId: input.jobId,
        state: 'ready-for-review',
        version: 'v001',
        outputSha256: 'a'.repeat(64),
        warnings: [],
      };
    },
    status: async () => ({
      state: 'ready-for-review',
      version: 'v001',
      outputSha256: 'a'.repeat(64),
      secret: 'hide-me',
      history: [{ state: 'ready-for-review', detail: { version: 'v001', outputSha256: 'a'.repeat(64) } }],
    }),
  };
  const app = await startTestServer(runner);
  const created = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY',
    targetDurationSec: 390,
    personalPermission: true,
    permissionNote: 'email permission confirmed',
  });
  assert.equal(created.status, 202);
  assert.match(created.body.jobId, /^web_/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceUrl, 'https://www.youtube.com/watch?v=abc123_XY');
  assert.equal(calls[0].personalPermission, true);
  assert.equal(calls[0].permissionNote, 'email permission confirmed');
  const status = await jsonRequest(app, 'GET', `/api/jobs/${created.body.jobId}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'ready-for-review');
  assert.equal(status.body.previewUrl, `/api/jobs/${created.body.jobId}/preview`);
  assert.equal('secret' in status.body, false);
  await app.close();
});

test('queues a second job and exposes the visible queue', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runner = {
    run: async () => pending,
    status: async () => ({ state: 'queued', history: [] }),
  };
  const app = await startTestServer(runner);
  const invalid = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://example.com/not-youtube',
    targetDurationSec: 390,
  });
  assert.equal(invalid.status, 400);
  const first = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY',
    targetDurationSec: 390,
  });
  assert.equal(first.status, 202);
  const second = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=def456_XY',
    targetDurationSec: 390,
  });
  assert.equal(second.status, 202);
  assert.equal(second.body.queuePosition, 1);
  const queue = await jsonRequest(app, 'GET', '/api/jobs');
  assert.equal(queue.status, 200);
  assert.equal(queue.body.activeCount, 1);
  assert.equal(queue.body.queuedCount, 1);
  assert.equal(queue.body.jobs.length, 2);
  assert.equal(queue.body.jobs.find((job) => job.jobId === second.body.jobId).queuePosition, 1);
  release({ state: 'blocked', jobId: first.body.jobId });
  await app.close();
});

test('exposes the blocked stage and saved failure reason', async () => {
  const runner = {
    run: async () => ({ state: 'blocked' }),
    status: async () => ({
      state: 'blocked',
      history: [{
        state: 'blocked',
        detail: {
          stage: 'queued',
          reason: 'LONGFORM_STAGE_FAILED',
          errorCode: 'YT_DLP_FAILED',
          message: 'YouTube source download failed',
        },
      }],
    }),
  };
  const app = await startTestServer(runner);
  const created = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY',
    targetDurationSec: 390,
  });
  const status = await jsonRequest(app, 'GET', `/api/jobs/${created.body.jobId}`);
  assert.equal(status.body.state, 'blocked');
  assert.deepEqual(status.body.blocked, {
    stage: 'queued',
    reason: 'LONGFORM_STAGE_FAILED',
    errorCode: 'YT_DLP_FAILED',
    message: 'YouTube source download failed',
    critical: [],
  });
  await app.close();
});

test('hides blocked jobs from the visible queue without deleting their state', async () => {
  const runner = {
    run: async () => ({ state: 'blocked' }),
    status: async () => ({
      state: 'blocked',
      history: [{ state: 'blocked', detail: { stage: 'queued', reason: 'LONGFORM_STAGE_FAILED' } }],
    }),
  };
  const app = await startTestServer(runner);
  await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY',
    targetDurationSec: 390,
  });
  const queue = await jsonRequest(app, 'GET', '/api/jobs');
  assert.equal(queue.status, 200);
  assert.equal(queue.body.jobs.length, 0);
  assert.equal(queue.body.blockedCount, 1);
  await app.close();
});

test('passes approval and revision requests to the existing runner', async () => {
  const calls = [];
  const runner = {
    run: async () => ({ state: 'ready-for-review' }),
    status: async () => ({ state: 'ready-for-review', history: [] }),
    approve: async (input) => { calls.push({ kind: 'approve', input }); return { state: 'approved' }; },
    revise: async (input) => { calls.push({ kind: 'revise', input }); return { state: 'revision-requested' }; },
  };
  const app = await startTestServer(runner);
  const created = await jsonRequest(app, 'POST', '/api/jobs', {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY',
    targetDurationSec: 390,
  });
  const jobId = created.body.jobId;
  const approved = await jsonRequest(app, 'POST', `/api/jobs/${jobId}/approve`, {
    version: 'v001',
    outputSha256: 'a'.repeat(64),
  });
  assert.equal(approved.status, 200);
  const revised = await jsonRequest(app, 'POST', `/api/jobs/${jobId}/revise`, {
    from: 'planning',
    note: 'Keep the complete product demonstration.',
  });
  assert.equal(revised.status, 200);
  assert.equal(calls[0].input.jobDir, path.join(app.jobsRoot, jobId));
  await app.close();
});
