import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { JobStateSchema } from './contracts.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';
import { resolveInside } from './paths.mjs';

const FINGERPRINT = /^[a-f0-9]{64}$/;
const STALE_LOCK_MS = 4 * 60 * 60 * 1000;
const STAGES = new Set([
  'ingest',
  'transcript',
  'take-map',
  'plan',
  'match',
  'render',
  'qa',
]);
const STAGE_ORDER = Object.freeze([
  'ingest',
  'transcript',
  'take-map',
  'plan',
  'match',
  'render',
  'qa',
]);

const NEXT = Object.freeze({
  queued: ['validating', 'blocked'],
  validating: ['transcribing', 'blocked'],
  transcribing: ['planning', 'blocked'],
  planning: ['matching', 'blocked'],
  matching: ['rendering', 'blocked'],
  rendering: ['checking', 'blocked'],
  checking: ['ready-for-review', 'blocked'],
  'ready-for-review': ['revision-requested', 'approved'],
  'revision-requested': [
    'validating',
    'transcribing',
    'planning',
    'matching',
    'rendering',
  ],
  approved: [],
  blocked: ['validating'],
});

async function readObject(filePath, fallback = null) {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) {
      throw new Error('job metadata exceeds limit');
    }
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('job metadata must be an object');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

function assertJobId(jobId) {
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(jobId)) {
    throw new Error('invalid job id');
  }
}

function assertFingerprint(fingerprint) {
  if (!FINGERPRINT.test(fingerprint)) {
    throw new Error('stage fingerprint must be SHA-256');
  }
}

export function createJobStore(jobDir) {
  const root = path.resolve(jobDir);
  const workDir = path.join(root, 'work');
  const statePath = path.join(workDir, 'job-state.json');
  const stagesPath = path.join(workDir, 'stages.json');
  const lockPath = path.join(workDir, 'job.lock');

  async function initialize(jobId) {
    assertJobId(jobId);
    await mkdir(workDir, { recursive: true });
    const existing = await readObject(statePath, {});
    if (existing.jobId) {
      if (existing.jobId !== jobId) throw new Error('job id does not match existing state');
      JobStateSchema.parse(existing.state);
      return existing;
    }
    const now = new Date().toISOString();
    const initial = {
      version: 1,
      jobId,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      history: [{ state: 'queued', at: now, detail: {} }],
    };
    await writeJsonAtomic(statePath, initial);
    await writeJsonAtomic(stagesPath, { version: 1, stages: {} });
    return initial;
  }

  async function status() {
    const current = await readObject(statePath);
    JobStateSchema.parse(current.state);
    return current;
  }

  async function transition(nextState, detail = {}) {
    JobStateSchema.parse(nextState);
    const current = await status();
    if (!NEXT[current.state]?.includes(nextState)) {
      throw new Error(`illegal transition: ${current.state} -> ${nextState}`);
    }
    const now = new Date().toISOString();
    const next = {
      ...current,
      state: nextState,
      updatedAt: now,
      history: [
        ...(Array.isArray(current.history) ? current.history : []),
        { state: nextState, at: now, detail },
      ].slice(-500),
    };
    await writeJsonAtomic(statePath, next);
    return next;
  }

  async function acquireLock({ clearStaleLock = false } = {}) {
    await mkdir(workDir, { recursive: true });
    const token = randomBytes(16).toString('hex');
    const payload = {
      version: 1,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lockMetadata = await stat(lockPath);
      const stale = Date.now() - lockMetadata.mtimeMs > STALE_LOCK_MS;
      if (!stale || !clearStaleLock) throw new Error('job already running');
      await unlink(lockPath);
      return acquireLock({ clearStaleLock: false });
    }
  }

  async function releaseLock(token) {
    let lock;
    try {
      lock = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (lock.token !== token) throw new Error('job lock ownership changed');
    await unlink(lockPath);
  }

  async function withLock(action, options = {}) {
    const token = await acquireLock(options);
    try {
      return await action();
    } finally {
      await releaseLock(token);
    }
  }

  async function stageFresh(stage, fingerprint) {
    if (!STAGES.has(stage) || !FINGERPRINT.test(fingerprint)) return false;
    const cache = await readObject(stagesPath, { version: 1, stages: {} });
    const record = cache.stages?.[stage];
    if (!record || record.fingerprint !== fingerprint || !Array.isArray(record.outputs)) {
      return false;
    }
    for (const output of record.outputs) {
      try {
        await resolveInside(root, output);
      } catch {
        return false;
      }
    }
    return true;
  }

  async function recordStage(stage, fingerprint, outputs) {
    if (!STAGES.has(stage)) throw new Error(`unknown stage: ${stage}`);
    assertFingerprint(fingerprint);
    if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > 50) {
      throw new Error('stage outputs must contain 1 to 50 paths');
    }
    for (const output of outputs) await resolveInside(root, output);

    const cache = await readObject(stagesPath, { version: 1, stages: {} });
    const next = {
      version: 1,
      stages: {
        ...(cache.stages || {}),
        [stage]: {
          fingerprint,
          outputs: [...outputs],
          completedAt: new Date().toISOString(),
        },
      },
    };
    await writeJsonAtomic(stagesPath, next);
    return next.stages[stage];
  }

  async function invalidateFrom(stage) {
    const start = STAGE_ORDER.indexOf(stage);
    if (start < 0) throw new Error(`unknown stage: ${stage}`);
    const cache = await readObject(stagesPath, { version: 1, stages: {} });
    const stages = { ...(cache.stages || {}) };
    for (const candidate of STAGE_ORDER.slice(start)) delete stages[candidate];
    await writeJsonAtomic(stagesPath, { version: 1, stages });
  }

  return Object.freeze({
    initialize,
    status,
    transition,
    withLock,
    stageFresh,
    recordStage,
    invalidateFrom,
  });
}
