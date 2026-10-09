import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CIRCLE_LAYOUTS = new Set([
  'screen-full-face-circle',
  'visual-full-face-circle',
]);
const SAMPLE_FRACTIONS = Object.freeze([0.25, 0.5, 0.75]);

function average(values) {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

async function defaultMeasureRegion({
  mediaPath,
  anchor,
  timestampSeconds,
  ffmpegPath,
}) {
  const x = anchor === 'middle-left' ? 44 : 1616;
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', timestampSeconds.toFixed(3),
    '-i', mediaPath,
    '-frames:v', '1',
    '-vf', `scale=1920:1080,crop=260:260:${x}:410,format=gray,sobel,signalstats,metadata=print:file=-`,
    '-f', 'null',
    '-',
  ], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const matches = [...stdout.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)];
  if (matches.length === 0) throw new Error('anchor obstruction measurement unavailable');
  return Number(matches.at(-1)[1]);
}

export async function analyzeAnchorSafety({
  segments,
  media,
  fps = 30,
  ffmpegPath = 'ffmpeg',
  measureRegion = defaultMeasureRegion,
}) {
  const measurements = {};
  for (const segment of segments) {
    if (!CIRCLE_LAYOUTS.has(segment.layout)) continue;
    const asset = media[segment.primaryAssetId];
    if (!asset?.absolutePath) continue;
    const durationFrames = segment.endFrame - segment.startFrame;
    const scores = {};
    for (const anchor of ['middle-left', 'middle-right']) {
      const samples = [];
      for (const fraction of SAMPLE_FRACTIONS) {
        const frame = segment.startFrame + (durationFrames * fraction);
        samples.push(await measureRegion({
          anchor,
          fraction,
          mediaPath: asset.absolutePath,
          timestampSeconds: frame / fps,
          ffmpegPath,
        }));
      }
      scores[anchor] = average(samples);
    }
    measurements[segment.id] = {
      leftEdgeScore: scores['middle-left'],
      rightEdgeScore: scores['middle-right'],
    };
  }
  return measurements;
}
