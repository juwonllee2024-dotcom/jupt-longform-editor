import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../atomic-json.mjs';
import { toJobRelative } from '../paths.mjs';

const execFileDefault = promisify(execFile);
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;
const MP4_EXTENSION = '.mp4';
const JSON3_EXTENSION = '.json3';

function errorWithCode(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function fileExists(filePath) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

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

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function videoIdFromUrl(parsed, host) {
  if (host === 'youtu.be') {
    return parsed.pathname.split('/').filter(Boolean)[0];
  }
  if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1];
  return null;
}

export function parseYoutubeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw errorWithCode('YOUTUBE_URL_REQUIRED', 'YouTube video URL is required');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw errorWithCode('YOUTUBE_URL_INVALID', 'YouTube URL is invalid', error);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol !== 'https:') {
    throw errorWithCode('YOUTUBE_URL_INVALID', 'YouTube URL must use https');
  }
  if (!YOUTUBE_HOSTS.has(host)) {
    throw errorWithCode('YOUTUBE_URL_UNSUPPORTED', 'YouTube URL is not supported');
  }
  const id = videoIdFromUrl(parsed, host);
  if (!VIDEO_ID.test(String(id || ''))) {
    throw errorWithCode('YOUTUBE_VIDEO_REQUIRED', 'YouTube video URL is required');
  }
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

export function parseYoutubeJson3Transcript(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) {
    throw errorWithCode('YOUTUBE_SUBTITLES_INVALID', 'YouTube JSON3 subtitles are invalid.');
  }
  const events = value.events;
  const rawSegments = [];
  for (const event of events) {
    const start = Number(event?.tStartMs) / 1_000;
    if (!Number.isFinite(start) || start < 0) continue;
    const text = Array.isArray(event?.segs)
      ? event.segs.map((segment) => String(segment?.utf8 || '')).join('').replace(/\s+/g, ' ').trim()
      : '';
    if (!text) continue;
    const duration = Number(event?.dDurationMs) / 1_000;
    rawSegments.push({
      start,
      end: Number.isFinite(duration) && duration > 0 ? start + duration : start + 1,
      text,
    });
  }
  rawSegments.sort((left, right) => left.start - right.start);
  for (let index = rawSegments.length - 1; index > 0; index -= 1) {
    const current = rawSegments[index];
    const previous = rawSegments[index - 1];
    if (current.start !== previous.start) continue;
    previous.end = Math.max(previous.end, current.end);
    previous.text = `${previous.text} ${current.text}`.replace(/\s+/g, ' ').trim();
    rawSegments.splice(index, 1);
  }
  const segments = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const event = rawSegments[index];
    const start = event.start;
    const nextStart = rawSegments[index + 1]?.start;
    // YouTube captions often keep two adjacent display windows alive at once.
    // Use the next caption start as the boundary when windows overlap so the
    // transcript remains ordered and non-overlapping for downstream stages.
    const end = Number.isFinite(nextStart) && nextStart > start
      ? Math.min(event.end, nextStart)
      : event.end;
    if (end <= start) continue;
    segments.push({
      id: `segment_${String(segments.length + 1).padStart(3, '0')}`,
      start,
      end,
      text: event.text,
    });
  }
  if (segments.length === 0) {
    throw errorWithCode('YOUTUBE_SUBTITLES_EMPTY', 'YouTube JSON3 subtitles contain no dialogue.');
  }
  return {
    version: 1,
    language: 'en',
    durationSeconds: Math.max(...segments.map((segment) => segment.end)),
    segments,
  };
}

function outputCandidates(stdout) {
  return [
    ...String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && path.extname(line).toLowerCase() === MP4_EXTENSION)
      .map((line) => path.resolve(line)),
  ];
}

async function findDownloadedFile(stdout, tempDir) {
  const printed = outputCandidates(stdout);
  for (const candidate of printed) {
    if (await fileExists(candidate)) return candidate;
  }
  let entries = [];
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const local = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === MP4_EXTENSION)
    .map((entry) => path.join(tempDir, entry.name));
  for (const candidate of local) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function findJson3Subtitle(tempDir) {
  let entries;
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === JSON3_EXTENSION)
    .map((entry) => path.join(tempDir, entry.name))
    .sort()[0] || null;
}

function cleanPermissionNote(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
}

function personalPermissionRights(personalPermission, permissionNote) {
  if (personalPermission !== true) return null;
  const note = cleanPermissionNote(permissionNote);
  return {
    status: 'licensed',
    note: note || '사용자가 개인 이메일 허가를 받았다고 표시함. 증빙 이메일은 로컬에 보관.',
    permission: {
      type: 'personal-email',
      assertedByUser: true,
      evidence: 'local-email-not-uploaded',
    },
  };
}

async function persistYoutubeSubtitle(tempDir, sourceDir) {
  const subtitlePath = await findJson3Subtitle(tempDir);
  if (!subtitlePath) return null;
  let raw;
  try {
    raw = JSON.parse(await readFile(subtitlePath, 'utf8'));
  } catch (error) {
    throw errorWithCode('YOUTUBE_SUBTITLES_INVALID', 'YouTube subtitle file is not valid JSON.', error);
  }
  const transcript = parseYoutubeJson3Transcript(raw);
  const outputPath = path.join(sourceDir, 'transcript.en.json');
  await writeJsonAtomic(outputPath, transcript);
  return outputPath;
}

function executableMissing(error) {
  return error?.code === 'ENOENT' || /No module named ['\"]?yt_dlp/i.test(String(error?.stderr || error?.message || ''));
}

function retryableMediaResponse(error) {
  const details = `${error?.stderr || ''} ${error?.message || ''} ${error?.cause?.stderr || ''}`;
  return /\b403\b|forbidden|requested format is not available|sign in to confirm|precondition check failed/i.test(details);
}

async function runYtDlp({ ytDlpPath, args, execFileAsync, options }) {
  try {
    return {
      result: await execFileAsync(ytDlpPath, args, options),
      command: ytDlpPath,
    };
  } catch (error) {
    if (ytDlpPath !== 'yt-dlp' || !executableMissing(error)) throw error;
    const candidates = [
      process.env.YTDLP_PYTHON ? { file: process.env.YTDLP_PYTHON, prefix: [] } : null,
      { file: 'python', prefix: ['-m', 'yt_dlp'] },
      { file: 'py', prefix: ['-3', '-m', 'yt_dlp'] },
    ].filter(Boolean);
    let lastError = error;
    for (const candidate of candidates) {
      try {
        return {
          result: await execFileAsync(candidate.file, [...candidate.prefix, ...args], options),
          command: candidate.prefix.length
            ? `${candidate.file} ${candidate.prefix.join(' ')}`
            : candidate.file,
        };
      } catch (fallbackError) {
        lastError = fallbackError;
        if (!executableMissing(fallbackError)) throw fallbackError;
      }
    }
    throw lastError;
  }
}

async function ensureProvenance(inputDir, source, requestedRights = null) {
  const sourcesPath = path.join(inputDir, 'sources.json');
  const existing = await readJsonIfPresent(sourcesPath);
  if (existing) {
    if (!requestedRights) return existing;
    const updated = {
      ...existing,
      rights: {
        ...(existing.rights && typeof existing.rights === 'object' ? existing.rights : {}),
        ...requestedRights,
      },
    };
    await writeJsonAtomic(sourcesPath, updated);
    return updated;
  }
  const created = {
    version: 1,
    rights: requestedRights || {
      status: 'unknown',
      note: 'YouTube source downloaded automatically. Verify permission before publishing.',
    },
    source: {
      kind: 'youtube',
      url: source.url,
      videoId: source.videoId,
    },
  };
  await writeJsonAtomic(sourcesPath, created);
  return created;
}

export async function downloadYoutubeSource({
  jobDir,
  url,
  ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp',
  execFileAsync = execFileDefault,
  force = false,
  personalPermission = false,
  permissionNote = '',
  timeoutMs = 15 * 60_000,
} = {}) {
  if (!jobDir) throw errorWithCode('JOB_DIRECTORY_REQUIRED', 'job directory required');
  const source = parseYoutubeUrl(url);
  const jobRoot = path.resolve(jobDir);
  const inputDir = path.join(jobRoot, 'input');
  const sourceDir = path.join(inputDir, 'source');
  const workDir = path.join(jobRoot, 'work');
  const tempDir = path.join(workDir, `youtube-download-${source.id}`);
  const outputPath = path.join(sourceDir, 'main.mp4');
  const manifestPath = path.join(workDir, 'youtube-download-manifest.json');
  const requestedRights = personalPermissionRights(personalPermission, permissionNote);
  await mkdir(sourceDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const previous = await readJsonIfPresent(manifestPath);
  if (!force && previous?.url === source.url && await fileExists(outputPath)) {
    if (requestedRights) {
      const provenance = await ensureProvenance(inputDir, source, requestedRights);
      const cachedManifest = { ...previous, rights: provenance.rights || requestedRights };
      await writeJsonAtomic(manifestPath, cachedManifest);
      return { ...cachedManifest, cached: true };
    }
    return { ...previous, cached: true };
  }

  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  const outputTemplate = path.join(tempDir, 'main.%(ext)s');
  const adaptiveArgs = [
    '--no-playlist',
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--newline',
    '--js-runtimes', 'node',
    '--force-ipv4',
    '--retries', '3',
    '--fragment-retries', '3',
    '--restrict-filenames',
    '--format', 'bv*[height<=1080]+ba/b[height<=1080]',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--output', outputTemplate,
    '--print', 'after_move:filepath',
    source.url,
  ];
  const subtitleArgs = [
    '--no-playlist',
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--newline',
    '--js-runtimes', 'node',
    '--force-ipv4',
    '--extractor-args', 'youtube:player_client=android',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'json3',
    '--skip-download',
    '--output', outputTemplate,
    source.url,
  ];
  let result;
  let commandUsed = ytDlpPath;
  try {
    // YouTube's default client can return media URLs that are rejected with
    // HTTP 403 on some networks. Android's client still exposes a stable
    // progressive MP4, so try it first, then fall back through other clients.
    const profiles = [
      { format: 'bv*[height<=1080]+ba/b[height<=1080]', playerClient: 'android' },
      { format: '18', playerClient: 'android' },
      { format: 'bv*[height<=1080]+ba/b[height<=1080]', playerClient: 'android_vr' },
      { format: '18', playerClient: 'android_vr' },
      { format: '18', playerClient: 'tv_embedded' },
      { format: '18', playerClient: 'web' },
    ];
    let lastError;
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      const args = [...adaptiveArgs];
      args[args.indexOf('--format') + 1] = profile.format;
      args.splice(-1, 0, '--extractor-args', `youtube:player_client=${profile.playerClient}`);
      try {
        const executed = await runYtDlp({
          ytDlpPath,
          args,
          execFileAsync,
          options: {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        });
        result = executed.result;
        commandUsed = executed.command;
        break;
      } catch (error) {
        lastError = error;
        if (index === profiles.length - 1 || !retryableMediaResponse(error)) throw error;
        await rm(tempDir, { recursive: true, force: true });
        await mkdir(tempDir, { recursive: true });
      }
    }
    if (!result && lastError) throw lastError;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    if (executableMissing(error)) {
      throw errorWithCode(
        'YTDLP_NOT_FOUND',
        'yt-dlp executable or Python module not found. Install yt-dlp or set YT_DLP_PATH.',
        error,
      );
    }
    const details = `${error.stderr || ''} ${error.message || ''}`;
    const code = /429|too many requests/i.test(details)
      ? 'YTDLP_RATE_LIMITED'
      : 'YTDLP_DOWNLOAD_FAILED';
    throw errorWithCode(code, 'YouTube download failed.', error);
  }

  const downloadedPath = await findDownloadedFile(result?.stdout, tempDir);
  if (!downloadedPath) {
    await rm(tempDir, { recursive: true, force: true });
    throw errorWithCode('YTDLP_NO_MP4', 'yt-dlp did not produce an MP4 file.');
  }
  if (path.resolve(downloadedPath) !== path.resolve(outputPath)) {
    if (await fileExists(outputPath)) await rm(outputPath, { force: true });
    await rename(downloadedPath, outputPath);
  }
  const metadata = await stat(outputPath);
  if (!metadata.isFile() || metadata.size <= 0) {
    await rm(tempDir, { recursive: true, force: true });
    throw errorWithCode('YTDLP_EMPTY_MP4', 'downloaded MP4 is empty.');
  }
  const subtitleWarnings = [];
  let transcriptPath;
  try {
    await runYtDlp({
      ytDlpPath,
      args: subtitleArgs,
      execFileAsync,
      options: {
        windowsHide: true,
        timeout: Math.min(timeoutMs, 180_000),
        maxBuffer: 4 * 1024 * 1024,
      },
    });
    transcriptPath = await persistYoutubeSubtitle(tempDir, sourceDir);
    if (!transcriptPath) subtitleWarnings.push('YOUTUBE_SUBTITLES_UNAVAILABLE');
  } catch {
    subtitleWarnings.push('YOUTUBE_SUBTITLES_UNAVAILABLE');
  }
  const provenance = await ensureProvenance(inputDir, source, requestedRights);
  const manifest = {
    version: 1,
    provider: 'yt-dlp',
    url: source.url,
    videoId: source.id,
    outputPath: toJobRelative(jobRoot, outputPath),
    bytes: metadata.size,
    sha256: await sha256File(outputPath),
    ytDlpPath: commandUsed,
    downloadedAt: new Date().toISOString(),
    cached: false,
    rights: provenance.rights || requestedRights || { status: 'unknown' },
    ...(transcriptPath ? { transcriptPath: toJobRelative(jobRoot, transcriptPath) } : {}),
    subtitleStatus: transcriptPath ? 'ready' : 'unavailable',
    warnings: subtitleWarnings,
  };
  await writeJsonAtomic(manifestPath, manifest);
  await rm(tempDir, { recursive: true, force: true });
  return manifest;
}
