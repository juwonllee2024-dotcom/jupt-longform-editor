import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../atomic-json.mjs';
import { resolveInside, toJobRelative } from '../paths.mjs';

const execFileAsync = promisify(execFile);
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const JOB_ID = /^[a-z][a-z0-9_-]{2,63}$/;

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return digest.digest('hex');
}

async function probeVideo(filePath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  let probe;
  try {
    probe = JSON.parse(stdout);
  } catch {
    throw new Error('source ffprobe returned invalid JSON');
  }
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const durationSeconds = Number(probe.format?.duration ?? video?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('source video duration is missing or zero');
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('source video dimensions are missing');
  }
  return { durationSeconds, width, height };
}

async function readProvenance(inputDir) {
  const warnings = [];
  let raw = null;
  try {
    raw = JSON.parse(await readFile(path.join(inputDir, 'sources.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('sources.json is not valid JSON');
    warnings.push('RIGHTS_METADATA_MISSING');
  }
  const rights = raw?.rights && typeof raw.rights === 'object'
    ? {
      status: String(raw.rights.status || 'unknown'),
      note: String(raw.rights.note || '').slice(0, 500),
      ...(raw.rights.permission && typeof raw.rights.permission === 'object'
        ? {
          permission: {
            ...(typeof raw.rights.permission.type === 'string'
              ? { type: raw.rights.permission.type.slice(0, 80) }
              : {}),
            ...(raw.rights.permission.assertedByUser === true
              ? { assertedByUser: true }
              : {}),
            ...(typeof raw.rights.permission.evidence === 'string'
              ? { evidence: raw.rights.permission.evidence.slice(0, 120) }
              : {}),
          },
        }
        : {}),
    }
    : { status: 'unknown', note: '' };
  if (!['owned', 'licensed', 'commentary', 'unknown'].includes(rights.status)) {
    rights.status = 'unknown';
    warnings.push('RIGHTS_STATUS_UNKNOWN');
  }
  if (rights.status === 'unknown') warnings.push('RIGHTS_REVIEW_REQUIRED');
  return { rights, warnings, sourceMetadata: raw || {} };
}

export async function ingestLongformSource({
  jobId,
  jobDir,
  ffprobePath = 'ffprobe',
}) {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error('invalid job id');
  const inputDir = await resolveInside(jobDir, 'input');
  const workDir = await resolveInside(jobDir, 'work', { mustExist: false });
  await mkdir(workDir, { recursive: true });
  let sourcePath;
  try {
    sourcePath = await resolveInside(inputDir, 'source/main.mp4');
  } catch {
    throw new Error('source video is required at input/source/main.mp4');
  }
  const extension = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported source extension: ${extension}`);
  }
  const metadata = await stat(sourcePath);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error('source video is empty');
  const [probe, sourceSha256, provenance] = await Promise.all([
    probeVideo(sourcePath, ffprobePath),
    sha256File(sourcePath),
    readProvenance(inputDir),
  ]);
  const metadataHash = createHash('sha256')
    .update(JSON.stringify(provenance.sourceMetadata))
    .digest('hex');
  const inputHash = createHash('sha256')
    .update('longform-condense\0')
    .update(sourceSha256)
    .update('\0')
    .update(metadataHash)
    .digest('hex');
  const manifest = {
    version: 1,
    mode: 'longform-condense',
    jobId,
    inputHash,
    source: {
      id: 'source_main',
      path: toJobRelative(jobDir, sourcePath),
      sha256: sourceSha256,
      ...probe,
      durationFrames: Math.max(1, Math.round(probe.durationSeconds * 30)),
    },
    rights: provenance.rights,
    warnings: [...new Set(provenance.warnings)],
  };
  await writeJsonAtomic(path.join(workDir, 'source-ingest-manifest.json'), manifest);
  return manifest;
}
