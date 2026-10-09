import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJobStore } from '../src/job-store.mjs';

test('rejects illegal transitions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-state-'));
  const store = createJobStore(root);
  await store.initialize('video_state_001');
  await assert.rejects(
    () => store.transition('approved', { reason: 'skip review' }),
    /illegal transition/,
  );
  assert.equal((await store.status()).state, 'queued');
});

test('allows only one active job lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-lock-'));
  const store = createJobStore(root);
  await store.initialize('video_lock_001');

  let release;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const first = store.withLock(() => new Promise((resolve) => {
    release = resolve;
    markEntered();
  }));
  await entered;

  await assert.rejects(
    () => store.withLock(async () => {}),
    /job already running/,
  );
  release();
  await first;
  await assert.doesNotReject(() => store.withLock(async () => {}));
});

test('reuses only matching fingerprints with existing outputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-cache-'));
  const workDir = path.join(root, 'work');
  await mkdir(workDir);
  await writeFile(path.join(workDir, 'ingest-manifest.json'), '{}\n');

  const store = createJobStore(root);
  await store.initialize('video_cache_001');
  await store.recordStage(
    'ingest',
    'a'.repeat(64),
    ['work/ingest-manifest.json'],
  );

  assert.equal(await store.stageFresh('ingest', 'a'.repeat(64)), true);
  assert.equal(await store.stageFresh('ingest', 'b'.repeat(64)), false);
  assert.equal(await store.stageFresh('unknown', 'a'.repeat(64)), false);
});

test('invalidates a requested stage and every downstream cache entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-invalidate-'));
  const workDir = path.join(root, 'work');
  await mkdir(workDir);
  await writeFile(path.join(workDir, 'stage.json'), '{}\n');
  const store = createJobStore(root);
  await store.initialize('video_invalidate_001');
  for (const [index, stage] of ['ingest', 'transcript', 'plan', 'match', 'render', 'qa'].entries()) {
    await store.recordStage(stage, String(index + 1).repeat(64), ['work/stage.json']);
  }

  await store.invalidateFrom('plan');

  assert.equal(await store.stageFresh('ingest', '1'.repeat(64)), true);
  assert.equal(await store.stageFresh('transcript', '2'.repeat(64)), true);
  assert.equal(await store.stageFresh('plan', '3'.repeat(64)), false);
  assert.equal(await store.stageFresh('qa', '6'.repeat(64)), false);
});
