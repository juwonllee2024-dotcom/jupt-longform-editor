import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVideoEditorAdapter } = require('../../lib/video-editor-adapter.js');

test('adapter permits only job directories inside configured root', async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), 'juwon-jobs-root-'));
  const inside = path.join(jobsRoot, 'video_safe_001');
  const outside = await mkdtemp(path.join(tmpdir(), 'juwon-jobs-outside-'));
  await mkdir(inside);
  const calls = [];
  const adapter = createVideoEditorAdapter({
    appRoot: path.resolve('..'),
    jobsRoot,
    getOpenAIKey: async () => 'not-used',
    planWithNim: async () => 'not-used',
    runnerFactory: async () => ({
      run: async (input) => {
        calls.push(input);
        return { state: 'queued' };
      },
    }),
  });

  await adapter.createAndRun({
    jobId: 'video_safe_001',
    jobDirectory: inside,
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => adapter.createAndRun({
      jobId: 'video_escape_001',
      jobDirectory: outside,
    }),
    /outside configured root/,
  );
});
