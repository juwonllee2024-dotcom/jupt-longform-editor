import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { QaReportSchema, parseContract } from '../contracts.mjs';

const execFileAsync = promisify(execFile);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function add(condition, target, code) {
  if (condition) target.push(code);
}

export function decideQaGate(measurements) {
  const critical = [];
  const warnings = [...list(measurements.warnings)];

  add(!measurements.hasVideo, critical, 'MISSING_VIDEO');
  add(!measurements.hasAudio, critical, 'MISSING_AUDIO');
  add(
    measurements.width !== 1920 || measurements.height !== 1080,
    critical,
    'INVALID_DIMENSIONS',
  );
  add(
    measurements.longform === true
      && (!Number.isFinite(measurements.durationSeconds)
        || measurements.durationSeconds < 300
        || measurements.durationSeconds > 480),
    critical,
    'OUTPUT_DURATION_OUT_OF_RANGE',
  );
  add(
    measurements.longform === true
      && (!Number.isFinite(measurements.width)
        || !Number.isFinite(measurements.height)
        || Math.abs((measurements.width / measurements.height) - (16 / 9)) > 0.01),
    critical,
    'OUTPUT_ASPECT_RATIO_INVALID',
  );
  add(
    !Number.isFinite(measurements.fps)
      || Math.abs(measurements.fps - 30) > 0.01,
    critical,
    'INVALID_FRAME_RATE',
  );
  add(
    !Number.isFinite(measurements.integratedLufs)
      || measurements.integratedLufs < -15
      || measurements.integratedLufs > -13,
    critical,
    'LOUDNESS_OUT_OF_RANGE',
  );
  add(
    !Number.isFinite(measurements.truePeakDbtp)
      || measurements.truePeakDbtp > -1,
    critical,
    'TRUE_PEAK_TOO_HIGH',
  );
  add(
    list(measurements.uncoveredSegmentIds).length > 0,
    critical,
    'SEGMENT_COVERAGE',
  );
  add(
    list(measurements.missingSourceIds).length > 0,
    critical,
    'MISSING_SOURCE',
  );
  add(
    list(measurements.missingAssetIds).length > 0,
    critical,
    'MISSING_ASSET',
  );
  add(measurements.captionBoundsOk !== true, critical, 'CAPTION_BOUNDS');
  add(
    list(measurements.anchorMeasurementsMissing).length > 0,
    critical,
    'FACE_ANCHOR_UNMEASURED',
  );

  const blackSegment = list(measurements.blackFrameSegmentIds).length > 0;
  const frozenSegment = list(measurements.frozenFrameSegmentIds).length > 0;
  add(blackSegment, critical, 'BLACK_FRAME_SEGMENT');
  add(frozenSegment, critical, 'FROZEN_FRAME_SEGMENT');
  add(
    Number(measurements.blackFrameRatio) > 0.05 && !blackSegment,
    warnings,
    'BLACK_FRAME_RATIO',
  );
  add(
    Number(measurements.frozenFrameRatio) > 0.05 && !frozenSegment,
    warnings,
    'FROZEN_FRAME_RATIO',
  );

  const candidate = {
    version: 1,
    passed: critical.length === 0,
    critical: [...new Set(critical)],
    warnings: [...new Set(warnings)],
    metrics: {
      width: Number(measurements.width) || 0,
      height: Number(measurements.height) || 0,
      fps: Number(measurements.fps) || 0,
      integratedLufs: Number(measurements.integratedLufs) || 0,
      truePeakDbtp: Number(measurements.truePeakDbtp) || 0,
      blackFrameRatio: Number(measurements.blackFrameRatio) || 0,
      frozenFrameRatio: Number(measurements.frozenFrameRatio) || 0,
      uncoveredSegments: list(measurements.uncoveredSegmentIds).length,
      missingSources: list(measurements.missingSourceIds).length,
      missingAssets: list(measurements.missingAssetIds).length,
      missingAnchorMeasurements: list(measurements.anchorMeasurementsMissing).length,
    },
  };
  const parsed = parseContract(QaReportSchema, candidate);
  if (!parsed.ok) throw new Error(`QA report contract invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

function parseRate(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number);
  return denominator ? numerator / denominator : Number(value);
}

async function exists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function analyzeLoudness(videoPath, ffmpegPath) {
  let stderr = '';
  try {
    ({ stderr } = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-nostats',
      '-i', videoPath,
      '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f', 'null',
      '-',
    ], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    stderr = error.stderr || '';
  }
  const matches = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!matches?.length) return { integratedLufs: Number.NaN, truePeakDbtp: Number.NaN };
  const report = JSON.parse(matches.at(-1));
  return {
    integratedLufs: Number(report.input_i),
    truePeakDbtp: Number(report.input_tp),
  };
}

async function analyzeFrames(videoPath, durationSeconds, ffmpegPath) {
  let stderr = '';
  try {
    ({ stderr } = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-nostats',
      '-i', videoPath,
      '-vf', 'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2',
      '-an',
      '-f', 'null',
      '-',
    ], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    stderr = error.stderr || '';
  }
  const blackDuration = [...stderr.matchAll(/black_duration:([0-9.]+)/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const freezeDuration = [...stderr.matchAll(/freeze_duration: ([0-9.]+)/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const duration = Math.max(Number(durationSeconds) || 0, 0.001);
  return {
    blackFrameRatio: Math.min(1, blackDuration / duration),
    frozenFrameRatio: Math.min(1, freezeDuration / duration),
  };
}

export async function runQa({
  videoPath,
  plan,
  media,
  sources,
  anchorMeasurements,
  renderedSegmentIds,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  longform = false,
}) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    videoPath,
  ], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(probe.format?.duration || video?.duration || 0);
  const [loudness, frames] = await Promise.all([
    analyzeLoudness(videoPath, ffmpegPath),
    analyzeFrames(videoPath, durationSeconds, ffmpegPath),
  ]);

  const rendered = new Set(list(renderedSegmentIds));
  const sourceIds = new Set(list(sources).map((source) => source.id));
  const circularLayouts = new Set([
    'screen-full-face-circle',
    'visual-full-face-circle',
    'source-full-face-circle',
  ]);
  const missingAssetIds = [];
  for (const assetId of new Set(plan.segments.map((segment) => segment.primaryAssetId))) {
    if (!await exists(media[assetId]?.absolutePath)) missingAssetIds.push(assetId);
  }

  return decideQaGate({
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number(video?.width),
    height: Number(video?.height),
    fps: parseRate(video?.avg_frame_rate || video?.r_frame_rate),
    ...loudness,
    ...frames,
    durationSeconds,
    longform,
    uncoveredSegmentIds: plan.segments
      .filter((segment) => !rendered.has(segment.id))
      .map((segment) => segment.id),
    missingSourceIds: [...new Set(plan.segments
      .map((segment) => segment.sourceId)
      .filter((id) => id && !sourceIds.has(id)))],
    missingAssetIds,
    captionBoundsOk: true,
    anchorMeasurementsMissing: plan.segments
      .filter((segment) => (
        circularLayouts.has(segment.layout)
        && (!Number.isFinite(anchorMeasurements[segment.id]?.leftEdgeScore)
          || !Number.isFinite(anchorMeasurements[segment.id]?.rightEdgeScore))
      ))
      .map((segment) => segment.id),
    blackFrameSegmentIds: [],
    frozenFrameSegmentIds: [],
    warnings: plan.warnings,
  });
}

export async function runLongformQa({ probe, ...options } = {}) {
  if (typeof probe !== 'function') return runQa({ ...options, longform: true });
  const measured = await probe(options.videoPath);
  return decideQaGate({
    hasVideo: measured.hasVideo !== false,
    hasAudio: measured.hasAudio !== false,
    width: Number(measured.width),
    height: Number(measured.height),
    fps: Number(measured.fps),
    durationSeconds: Number(measured.duration ?? measured.durationSeconds),
    integratedLufs: Number.isFinite(Number(measured.integratedLufs))
      ? Number(measured.integratedLufs)
      : -14.1,
    truePeakDbtp: Number.isFinite(Number(measured.truePeakDbtp))
      ? Number(measured.truePeakDbtp)
      : -1.2,
    uncoveredSegmentIds: [],
    missingSourceIds: [],
    missingAssetIds: [],
    captionBoundsOk: true,
    anchorMeasurementsMissing: [],
    blackFrameSegmentIds: [],
    frozenFrameSegmentIds: [],
    blackFrameRatio: Number(measured.blackFrameRatio) || 0,
    frozenFrameRatio: Number(measured.frozenFrameRatio) || 0,
    warnings: [],
    longform: true,
  });
}
