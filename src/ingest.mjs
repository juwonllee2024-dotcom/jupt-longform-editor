import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  readdirSync,
} from 'node:fs';
import {
  mkdir,
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  IngestManifestSchema,
  SourcesSchema,
  parseContract,
} from './contracts.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';
import { resolveInside, toJobRelative } from './paths.mjs';

const execFileAsync = promisify(execFile);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp3',
  '.wav',
  '.m4a',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a']);

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

function hashRecords(records) {
  const digest = createHash('sha256');
  for (const record of [...records].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(record.path);
    digest.update('\0');
    digest.update(record.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
}

async function validateMediaFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`unsupported media extension: ${extension}`);
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error('media file is empty or not a file');
  if (metadata.size > MAX_MEDIA_BYTES) throw new Error('media file exceeds 20 GiB');
  return extension;
}

async function probeVideo(filePath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath,
  ], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  let probe;
  try {
    probe = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const durationSeconds = Number(probe.format?.duration ?? video?.duration);
  if (!video) throw new Error('media has no video stream');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('media duration is missing or zero');
  }
  return {
    durationSeconds,
    width: Number(video.width),
    height: Number(video.height),
  };
}

async function readScript(scriptPath) {
  const metadata = await stat(scriptPath);
  if (!metadata.isFile() || metadata.size > 80_000) throw new Error('script.md exceeds input limit');
  const script = await readFile(scriptPath, 'utf8');
  if (script.length < 1 || script.length > 20_000 || script.includes('\0')) {
    throw new Error('script.md must contain 1 to 20000 UTF-8 characters');
  }
  return script;
}

async function readSources(sourcesPath) {
  const metadata = await stat(sourcesPath);
  if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) {
    throw new Error('sources.json exceeds input limit');
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(sourcesPath, 'utf8'));
  } catch {
    throw new Error('sources.json is not valid JSON');
  }
  const parsed = parseContract(SourcesSchema, raw);
  if (!parsed.ok) throw new Error(`sources contract invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

async function makeAsset({
  id,
  inputDir,
  jobDir,
  relativePath,
  kind,
  ffprobePath,
}) {
  const absolutePath = await resolveInside(inputDir, relativePath);
  const extension = await validateMediaFile(absolutePath);
  if (kind === 'screen' || !IMAGE_EXTENSIONS.has(extension) && !AUDIO_EXTENSIONS.has(extension)) {
    await probeVideo(absolutePath, ffprobePath);
  }
  return {
    id,
    path: toJobRelative(jobDir, absolutePath),
    sha256: await sha256File(absolutePath),
    kind,
  };
}

function firstOptionalMusic(inputDir) {
  const musicDir = path.join(inputDir, 'music');
  let names = [];
  try {
    names = readdirSync(musicDir).sort();
  } catch {
    return null;
  }
  const name = names.find((candidate) => AUDIO_EXTENSIONS.has(path.extname(candidate).toLowerCase()));
  return name ? `music/${name}` : null;
}

export async function ingestJob({
  jobId,
  jobDir,
  ffprobePath = 'ffprobe',
}) {
  const inputDir = await resolveInside(jobDir, 'input');
  const workDir = await resolveInside(jobDir, 'work');
  await mkdir(workDir, { recursive: true });

  const scriptPath = await resolveInside(inputDir, 'script.md');
  const sourcesPath = await resolveInside(inputDir, 'sources.json');
  const facecamPath = await resolveInside(inputDir, 'facecam/main.mp4');
  const [script, sources] = await Promise.all([
    readScript(scriptPath),
    readSources(sourcesPath),
  ]);

  await validateMediaFile(facecamPath);
  const facecamProbe = await probeVideo(facecamPath, ffprobePath);
  const facecam = {
    id: 'facecam_main',
    path: toJobRelative(jobDir, facecamPath),
    sha256: await sha256File(facecamPath),
    ...facecamProbe,
  };

  const assetIds = new Set();
  const assets = [];
  for (const screen of sources.screenClips) {
    if (assetIds.has(screen.id)) throw new Error(`duplicate asset id: ${screen.id}`);
    assetIds.add(screen.id);
    assets.push(await makeAsset({
      id: screen.id,
      inputDir,
      jobDir,
      relativePath: screen.path,
      kind: 'screen',
      ffprobePath,
    }));
  }
  for (const source of sources.sources) {
    if (assetIds.has(source.id)) throw new Error(`duplicate asset id: ${source.id}`);
    assetIds.add(source.id);
    assets.push(await makeAsset({
      id: source.id,
      inputDir,
      jobDir,
      relativePath: source.localAsset,
      kind: 'image',
      ffprobePath,
    }));
  }

  const musicPath = firstOptionalMusic(inputDir);
  if (musicPath) {
    assets.push(await makeAsset({
      id: 'music_background',
      inputDir,
      jobDir,
      relativePath: musicPath,
      kind: 'music',
      ffprobePath,
    }));
  }

  const records = [
    { path: facecam.path, sha256: facecam.sha256 },
    ...assets.map(({ path: assetPath, sha256 }) => ({ path: assetPath, sha256 })),
    {
      path: 'input/script.md',
      sha256: createHash('sha256').update(script).digest('hex'),
    },
    {
      path: 'input/sources.json',
      sha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
    },
  ];
  const manifest = {
    version: 1,
    jobId,
    inputHash: hashRecords(records),
    facecam,
    assets,
  };
  const parsed = parseContract(IngestManifestSchema, manifest);
  if (!parsed.ok) throw new Error(`ingest manifest invalid: ${parsed.errors.join('; ')}`);
  await writeJsonAtomic(path.join(workDir, 'ingest-manifest.json'), parsed.value);
  return parsed.value;
}
