import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import {
  mkdir,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnerForMode } from '../runner-factory.mjs';
import { createOllamaTranslator } from '../condense/translation-provider.mjs';
import {
  createWebJobId,
  isSafeWebJobId,
  parseCreateRequest,
} from './contracts.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const BODY_LIMIT_BYTES = 64 * 1024;
const SAFE_VERSION = /^v\d{3}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonError(status, code, message) {
  return new HttpError(status, code, message);
}

function safeErrorMessage(error) {
  const message = String(error?.message || 'request failed')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z]:\\[^ ]*/g, '[path]')
    .slice(0, 240);
  return message || 'request failed';
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', body.length);
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      throw jsonError(413, 'BODY_TOO_LARGE', 'request body exceeds 64 KiB');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw jsonError(400, 'JSON_INVALID', 'request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw jsonError(400, 'JSON_INVALID', 'request body must be an object');
  }
  return value;
}

function pathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw jsonError(400, 'PATH_INVALID', 'path is invalid');
  }
}

function statusDetail(status) {
  if (!Array.isArray(status?.history)) return {};
  const state = status.state;
  return [...status.history].reverse().find((item) => item?.state === state)?.detail || {};
}

function publicStatus(jobId, status, snapshot, error) {
  const detail = statusDetail(status);
  const state = typeof status?.state === 'string' ? status.state : 'unknown';
  const version = snapshot?.version || status?.version || detail.version || null;
  const outputSha256 = snapshot?.outputSha256 || status?.outputSha256 || detail.outputSha256 || null;
  const ready = state === 'ready-for-review' || state === 'approved';
  const warnings = Array.isArray(snapshot?.warnings)
    ? snapshot.warnings.filter((item) => typeof item === 'string').slice(0, 20)
    : [];
  const blocked = state === 'blocked' ? {
    stage: typeof detail.stage === 'string' ? detail.stage : null,
    reason: typeof detail.reason === 'string' ? detail.reason : null,
    errorCode: typeof detail.errorCode === 'string' ? detail.errorCode : null,
    message: typeof detail.message === 'string'
      ? safeErrorMessage({ message: detail.message })
      : '이 실행은 원문 오류가 저장되지 않은 이전 실행이라 정확한 원인을 복구할 수 없어.',
    critical: Array.isArray(detail.critical)
      ? detail.critical.filter((item) => typeof item === 'string').slice(0, 20)
      : [],
  } : null;
  const errorMessage = error ? safeErrorMessage(error) : null;
  const visibleError = errorMessage === 'longform condense blocked' && blocked?.message
    ? blocked.message
    : errorMessage;
  return {
    jobId,
    state,
    version,
    outputSha256: typeof outputSha256 === 'string' ? outputSha256 : null,
    previewUrl: ready && version ? `/api/jobs/${jobId}/preview` : null,
    warnings,
    ...(visibleError ? { error: visibleError } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function existingFile(filePath) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && metadata.size > 0 ? metadata : null;
  } catch {
    return null;
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.html'
    ? 'text/html; charset=utf-8'
    : extension === '.js'
      ? 'text/javascript; charset=utf-8'
      : extension === '.css'
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  }
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    relative = decodeURIComponent(relative);
  } catch {
    throw jsonError(400, 'PATH_INVALID', 'path is invalid');
  }
  const candidate = path.resolve(PUBLIC_DIR, relative);
  if (!inside(PUBLIC_DIR, candidate)) throw jsonError(404, 'NOT_FOUND', 'resource not found');
  const metadata = await existingFile(candidate);
  if (!metadata) throw jsonError(404, 'NOT_FOUND', 'resource not found');
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType(candidate));
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Content-Length', metadata.size);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(candidate).pipe(response);
}

async function servePreview(request, response, { jobsRoot, jobId, runner, snapshots, errors }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  }
  if (!isSafeWebJobId(jobId)) throw jsonError(400, 'JOB_ID_INVALID', 'job id is invalid');
  let status;
  try {
    status = await runner.status({ jobDir: path.join(jobsRoot, jobId) });
  } catch {
    throw jsonError(404, 'JOB_NOT_FOUND', 'job not found');
  }
  const publicSnapshot = publicStatus(jobId, status, snapshots.get(jobId), errors.get(jobId));
  if (publicSnapshot.state !== 'ready-for-review' && publicSnapshot.state !== 'approved') {
    throw jsonError(404, 'PREVIEW_NOT_READY', 'preview is not ready');
  }
  if (!SAFE_VERSION.test(String(publicSnapshot.version || ''))) {
    throw jsonError(404, 'PREVIEW_NOT_READY', 'preview version is unavailable');
  }
  const jobRoot = path.resolve(jobsRoot, jobId);
  const previewPath = path.resolve(jobRoot, 'output', publicSnapshot.version, 'preview.mp4');
  if (!inside(jobRoot, previewPath)) throw jsonError(404, 'NOT_FOUND', 'preview not found');
  const metadata = await existingFile(previewPath);
  if (!metadata) throw jsonError(404, 'PREVIEW_NOT_FOUND', 'preview not found');
  const range = parseRange(request.headers.range, metadata.size);
  if (range?.invalid) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${metadata.size}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? metadata.size - 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader('Content-Type', 'video/mp4');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Length', end - start + 1);
  if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(previewPath, { start, end }).on('error', () => response.destroy()).pipe(response);
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean).map(pathSegment);
}

export async function createVideoEditorServer({
  jobsRoot = path.join(process.cwd(), 'video-jobs'),
  runner: injectedRunner,
  runnerFactory = createRunnerForMode,
  host = '127.0.0.1',
  port = 12345,
  maxActiveJobs = 1,
  now = () => new Date(),
  random = () => undefined,
} = {}) {
  const root = path.resolve(jobsRoot);
  await mkdir(root, { recursive: true });
  const runner = injectedRunner || runnerFactory({ mode: 'longform-condense' });
  const activeJobs = new Map();
  const queue = [];
  const records = new Map();
  const snapshots = new Map();
  const errors = new Map();
  const activeLimit = Number.isInteger(maxActiveJobs) && maxActiveJobs > 0 ? maxActiveJobs : 1;

  function jobDir(jobId) {
    if (!isSafeWebJobId(jobId)) throw jsonError(400, 'JOB_ID_INVALID', 'job id is invalid');
    return path.join(root, jobId);
  }

  function queuePosition(jobId) {
    const index = queue.findIndex((record) => record.jobId === jobId);
    return index === -1 ? null : index + 1;
  }

  function withRecordMetadata(record, status) {
    return {
      ...publicStatus(record.jobId, status, snapshots.get(record.jobId), errors.get(record.jobId)),
      statusUrl: `/api/jobs/${record.jobId}`,
      createdAt: record.createdAt || null,
      startedAt: record.startedAt || null,
      completedAt: record.completedAt || null,
      queuePosition: queuePosition(record.jobId),
      active: activeJobs.has(record.jobId),
    };
  }

  async function statusForRecord(record) {
    let status;
    try {
      status = await runner.status({ jobDir: record.jobDir });
    } catch (error) {
      if (error?.code !== 'ENOENT' || !record.state) throw error;
      status = {
        state: record.state,
        history: [{ state: record.state, detail: {} }],
      };
    }
    if (typeof status?.state === 'string') record.state = status.state;
    return withRecordMetadata(record, status);
  }

  async function discoverPersistedRecords() {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeWebJobId(entry.name) || records.has(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const stateFile = path.join(directory, 'work', 'job-state.json');
      if (!(await existingFile(stateFile))) continue;
      let metadata;
      try {
        metadata = await stat(directory);
      } catch {
        continue;
      }
      records.set(entry.name, {
        jobId: entry.name,
        jobDir: directory,
        createdAt: timestamp(metadata.birthtime),
        startedAt: null,
        completedAt: null,
        state: null,
        runInput: null,
      });
    }
  }

  function pumpQueue() {
    while (activeJobs.size < activeLimit && queue.length > 0) {
      const record = queue.shift();
      record.startedAt = timestamp(typeof now === 'function' ? now() : now);
      record.state = 'queued';
      const promise = Promise.resolve().then(() => runner.run(record.runInput));
      activeJobs.set(record.jobId, promise);
      promise
        .then((result) => {
          snapshots.set(record.jobId, result || {});
          if (typeof result?.state === 'string') record.state = result.state;
        })
        .catch((error) => {
          errors.set(record.jobId, error);
          record.state = 'blocked';
        })
        .finally(() => {
          activeJobs.delete(record.jobId);
          record.completedAt = timestamp(typeof now === 'function' ? now() : now);
          pumpQueue();
        });
    }
  }

  async function createJob(request, response) {
    if (request.method !== 'POST') throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    let input;
    try {
      input = parseCreateRequest(await readJsonBody(request));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = /^[A-Z0-9_]+$/.test(String(error?.code || ''))
        ? error.code
        : 'WEB_REQUEST_INVALID';
      throw jsonError(400, code, safeErrorMessage(error));
    }
    const jobId = createWebJobId(
      typeof now === 'function' ? now() : now,
      typeof random === 'function' ? random() : random,
    );
    const directory = jobDir(jobId);
    await mkdir(directory, { recursive: true });
    const runInput = {
      jobId,
      jobDir: directory,
      sourceUrl: input.youtubeUrl,
      targetDurationSec: input.targetDurationSec,
      personalPermission: input.personalPermission,
      permissionNote: input.permissionNote,
      ...(input.useOllama
        ? { subtitleProvider: createOllamaTranslator({ model: input.ollamaModel }) }
        : {}),
    };
    const record = {
      jobId,
      jobDir: directory,
      createdAt: timestamp(typeof now === 'function' ? now() : now),
      startedAt: null,
      completedAt: null,
      state: 'queued',
      runInput,
    };
    records.set(jobId, record);
    queue.push(record);
    const position = queuePosition(jobId);
    pumpQueue();
    sendJson(response, 202, {
      jobId,
      state: 'queued',
      statusUrl: `/api/jobs/${jobId}`,
      queuePosition: position,
      createdAt: record.createdAt,
    });
  }

  async function listJobs(request, response) {
    if (request.method !== 'GET') throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    await discoverPersistedRecords();
    const jobs = (await Promise.all([...records.values()].map(async (record) => {
      try {
        return await statusForRecord(record);
      } catch {
        return null;
      }
    }))).filter(Boolean);
    jobs.sort((left, right) => {
      const leftPosition = left.queuePosition || Number.MAX_SAFE_INTEGER;
      const rightPosition = right.queuePosition || Number.MAX_SAFE_INTEGER;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });
    const blockedCount = jobs.filter((job) => job.state === 'blocked').length;
    sendJson(response, 200, {
      jobs: jobs.filter((job) => job.state !== 'blocked'),
      blockedCount,
      activeCount: activeJobs.size,
      queuedCount: queue.length,
      maxActiveJobs: activeLimit,
    });
  }

  async function getStatus(request, response, jobId) {
    if (request.method !== 'GET') throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    await discoverPersistedRecords();
    const record = records.get(jobId);
    let status;
    try {
      status = await runner.status({ jobDir: jobDir(jobId) });
    } catch (error) {
      if (error?.code === 'ENOENT' && record?.state) {
        status = { state: record.state, history: [{ state: record.state, detail: {} }] };
      } else if (error?.code === 'ENOENT') {
        throw jsonError(404, 'JOB_NOT_FOUND', 'job not found');
      } else {
        throw error;
      }
    }
    if (record && typeof status?.state === 'string') record.state = status.state;
    sendJson(response, 200, record
      ? withRecordMetadata(record, status)
      : publicStatus(jobId, status, snapshots.get(jobId), errors.get(jobId)));
  }

  async function approve(request, response, jobId) {
    if (request.method !== 'POST') throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    if (typeof runner.approve !== 'function') throw jsonError(501, 'APPROVE_UNAVAILABLE', 'approval is unavailable');
    const body = await readJsonBody(request);
    try {
      const result = await runner.approve({
        jobDir: jobDir(jobId),
        version: body.version,
        outputSha256: body.outputSha256,
      });
      snapshots.set(jobId, { ...(snapshots.get(jobId) || {}), ...(result || {}) });
      sendJson(response, 200, publicStatus(jobId, result, snapshots.get(jobId), null));
    } catch {
      throw jsonError(409, 'APPROVE_FAILED', 'approval could not be completed');
    }
  }

  async function revise(request, response, jobId) {
    if (request.method !== 'POST') throw jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    if (typeof runner.revise !== 'function') throw jsonError(501, 'REVISE_UNAVAILABLE', 'revision is unavailable');
    const body = await readJsonBody(request);
    try {
      const result = await runner.revise({
        jobDir: jobDir(jobId),
        fromStage: body.from,
        note: body.note,
      });
      snapshots.set(jobId, { ...(snapshots.get(jobId) || {}), ...(result || {}) });
      sendJson(response, 200, publicStatus(jobId, result, snapshots.get(jobId), null));
    } catch {
      throw jsonError(409, 'REVISE_FAILED', 'revision could not be completed');
    }
  }

  const server = createServer((request, response) => {
    Promise.resolve().then(async () => {
      const parsed = new URL(request.url || '/', `http://${host}`);
      if (parsed.pathname === '/api/jobs') {
        if (request.method === 'GET') await listJobs(request, response);
        else await createJob(request, response);
        return;
      }
      const parts = routeParts(parsed.pathname);
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
        const jobId = parts[2];
        if (parts.length === 3) {
          await getStatus(request, response, jobId);
          return;
        }
        if (parts.length === 4 && parts[3] === 'preview') {
          await servePreview(request, response, { jobsRoot: root, jobId, runner, snapshots, errors });
          return;
        }
        if (parts.length === 4 && parts[3] === 'approve') {
          await approve(request, response, jobId);
          return;
        }
        if (parts.length === 4 && parts[3] === 'revise') {
          await revise(request, response, jobId);
          return;
        }
        throw jsonError(404, 'NOT_FOUND', 'route not found');
      }
      if (parsed.pathname.startsWith('/api/')) throw jsonError(404, 'NOT_FOUND', 'route not found');
      await serveStatic(request, response, parsed.pathname);
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SERVER_ERROR';
      const message = status >= 500 ? 'internal server error' : safeErrorMessage(error);
      sendJson(response, status, { error: code, message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  return {
    server,
    address,
    jobsRoot: root,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export {
  BODY_LIMIT_BYTES,
  HttpError,
  parseRange,
};
