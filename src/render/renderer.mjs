import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundle } from '@remotion/bundler';
import {
  renderMedia,
  selectComposition,
} from '@remotion/renderer';

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(moduleDir, '..', 'composition', 'index.jsx');

export function buildInputProps({
  plan,
  transcript,
  sourceTranscript,
  media,
  anchorMeasurements,
  mode,
} = {}) {
  return {
    plan,
    transcript,
    sourceTranscript,
    media,
    anchorMeasurements,
    mode: mode || plan?.mode || 'facecam',
  };
}

function defaultBrowserExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function renderVideo({
  plan,
  transcript,
  sourceTranscript,
  media,
  anchorMeasurements,
  mode,
  workDir,
  publicDir,
  ffmpegPath = 'ffmpeg',
  browserExecutable = defaultBrowserExecutable(),
}) {
  await mkdir(workDir, { recursive: true });
  const mezzaninePath = path.join(workDir, 'render-mezzanine.mp4');
  const reviewPath = path.join(workDir, 'review.mp4');
  const inputProps = buildInputProps({
    plan,
    transcript,
    sourceTranscript,
    media,
    anchorMeasurements,
    mode,
  });
  const serveUrl = await bundle({
    entryPoint,
    publicDir,
    onProgress: () => {},
  });
  const browserOptions = {
    browserExecutable: browserExecutable || undefined,
    chromiumOptions: {
      headless: true,
      ignoreCertificateErrors: false,
      disableWebSecurity: false,
    },
    logLevel: 'error',
  };
  const composition = await selectComposition({
    serveUrl,
    id: 'JuwonAiNews',
    inputProps,
    ...browserOptions,
  });
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: 'h264',
    audioCodec: 'aac',
    audioBitrate: '192k',
    crf: 18,
    pixelFormat: 'yuv420p',
    outputLocation: mezzaninePath,
    overwrite: true,
    concurrency: 2,
    enforceAudioTrack: true,
    ...browserOptions,
  });
  await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', mezzaninePath,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    reviewPath,
  ], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    mezzaninePath,
    reviewPath,
    renderedSegmentIds: plan.segments.map((segment) => segment.id),
    composition: {
      id: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
    },
  };
}
