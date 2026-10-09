import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRunner,
  createRunnerWithDefaults,
} from '../src/runner.mjs';

function createMemoryStore(initial = 'queued') {
  let state = initial;
  const fingerprints = new Map();
  let invalidatedFrom = null;
  const recordedStages = [];
  return {
    withLock: async (action) => action(),
    stageFresh: async (stage, fingerprint) => fingerprints.get(stage) === fingerprint,
    recordStage: async (stage, fingerprint) => {
      recordedStages.push(stage);
      fingerprints.set(stage, fingerprint);
    },
    transition: async (next) => {
      state = next;
    },
    invalidateFrom: async (stage) => {
      invalidatedFrom = stage;
    },
    invalidatedFrom: () => invalidatedFrom,
    recordedStages: () => [...recordedStages],
    status: async () => state,
  };
}

test('reuses unchanged stages and invalidates only downstream stages', async () => {
  const calls = [];
  const stage = (name, output) => async () => {
    calls.push(name);
    return output;
  };
  const store = createMemoryStore();
  const runner = createRunner({
    store,
    ingest: stage('ingest', { inputHash: 'a'.repeat(64) }),
    transcribe: stage('transcribe', { transcriptHash: 'b'.repeat(64) }),
    selectTakes: stage('takes', { takeHash: 'c'.repeat(64) }),
    plan: stage('plan', { planHash: 'd'.repeat(64) }),
    match: stage('match', { matchHash: 'e'.repeat(64) }),
    render: stage('render', { renderHash: 'f'.repeat(64) }),
    qa: stage('qa', { passed: true }),
  });

  await runner.run({
    jobId: 'video_runner_001',
    jobDir: 'C:\\fixture\\job',
  });
  await runner.run({
    jobId: 'video_runner_001',
    jobDir: 'C:\\fixture\\job',
  });

  assert.deepEqual(calls, [
    'ingest',
    'transcribe',
    'takes',
    'plan',
    'match',
    'render',
    'qa',
  ]);
  assert.deepEqual(store.recordedStages(), [
    'ingest',
    'transcript',
    'take-map',
    'plan',
    'match',
    'render',
    'qa',
  ]);
});

test('never marks failed QA ready for review', async () => {
  const store = createMemoryStore('checking');
  const runner = createRunner({
    store,
    qa: async () => ({
      passed: false,
      critical: ['MISSING_AUDIO'],
    }),
  });

  await assert.rejects(
    () => runner.runFrom('checking', {
      jobId: 'video_runner_002',
      jobDir: 'C:\\fixture\\job',
    }),
    /QA blocked/,
  );
  assert.notEqual(
    await runner.status({
      jobId: 'video_runner_002',
      jobDir: 'C:\\fixture\\job',
    }),
    'ready-for-review',
  );
});

test('records bounded revisions and invalidates downstream stages', async () => {
  const store = createMemoryStore('ready-for-review');
  const runner = createRunner({ store });
  await runner.revise({
    fromStage: 'matching',
    note: 'Use the real screen demonstration.',
  });
  assert.equal(store.invalidatedFrom(), 'match');
  assert.equal(await runner.status(), 'revision-requested');
  await assert.rejects(
    () => runner.revise({ fromStage: 'unknown', note: 'x' }),
    /invalid revision stage/,
  );
});

test('approval requires ready-for-review and verified output', async () => {
  const blockedStore = createMemoryStore('checking');
  const blockedRunner = createRunner({ store: blockedStore });
  await assert.rejects(
    () => blockedRunner.approve({
      version: 'v001',
      outputSha256: 'a'.repeat(64),
    }),
    /not ready for review/,
  );

  const readyStore = createMemoryStore('ready-for-review');
  const readyRunner = createRunner({
    store: readyStore,
    verifyApproval: async () => true,
  });
  await readyRunner.approve({
    version: 'v001',
    outputSha256: 'a'.repeat(64),
  });
  assert.equal(await readyRunner.status(), 'approved');
});

test('default runner records missing inputs as an honest blocked job', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-runner-missing-'));
  const runner = createRunnerWithDefaults({
    getOpenAIKey: async () => {
      throw new Error('key must not be requested before ingest');
    },
    planWithNim: async () => {
      throw new Error('planner must not run before ingest');
    },
  });

  await assert.rejects(
    () => runner.run({
      jobId: 'video_missing_001',
      jobDir,
    }),
    /video editor blocked/,
  );
  const status = await runner.status({
    jobId: 'video_missing_001',
    jobDir,
  });
  assert.equal(status.state, 'blocked');
  assert.equal(JSON.stringify(status).includes(jobDir), false);
});
