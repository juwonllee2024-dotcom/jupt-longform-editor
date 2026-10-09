import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decideQaGate, runQa } from '../src/qa/checks.mjs';
import { buildInputProps, renderVideo } from '../src/render/renderer.mjs';
import { analyzeAnchorSafety } from '../src/render/anchor-analysis.mjs';
import { writeReviewPackage } from '../src/review-package.mjs';
import { createFixtureJob } from './fixtures/generate-media.mjs';

function compliant(overrides = {}) {
  return {
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: 30,
    integratedLufs: -14.1,
    truePeakDbtp: -1.2,
    blackFrameRatio: 0.001,
    frozenFrameRatio: 0.01,
    uncoveredSegmentIds: [],
    missingSourceIds: [],
    missingAssetIds: [],
    captionBoundsOk: true,
    anchorMeasurementsMissing: [],
    warnings: [],
    ...overrides,
  };
}

test('passes source transcript and mode into the Remotion composition', () => {
  const sourceTranscript = { version: 1, language: 'en', words: [] };
  const props = buildInputProps({
    plan: { mode: 'longform-condense' },
    transcript: null,
    sourceTranscript,
    media: { source_main: { kind: 'video' } },
    anchorMeasurements: {},
    mode: 'longform-condense',
  });
  assert.equal(props.mode, 'longform-condense');
  assert.equal(props.sourceTranscript, sourceTranscript);
  assert.equal(props.media.source_main.kind, 'video');
});

test('creates a fixture at an explicit safe test directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'juwon-fixture-root-'));
  const requested = path.join(root, 'fixture-job');
  const fixture = await createFixtureJob({ jobDir: requested });
  assert.equal(fixture.jobDir, requested);
  assert.ok((await stat(fixture.facecamPath)).size > 0);
});

test('writes long-form condense review artifacts when supplied', async () => {
  const fixture = await createFixtureJob();
  const plan = {
    version: 1,
    jobId: 'video_longform_artifacts',
    fps: 30,
    durationFrames: 60,
    segments: [{
      id: 'segment_001',
      startFrame: 0,
      endFrame: 60,
      sourceStartFrame: 0,
      sourceEndFrame: 60,
      outputStartFrame: 0,
      outputEndFrame: 60,
      durationInFrames: 60,
      spokenText: 'source',
      layout: 'source-full',
      primaryAssetId: 'source_main',
      sourceId: null,
      captionStyle: 'normal',
      confidence: 1,
      reason: 'source',
    }],
    warnings: [],
  };
  const qa = { passed: true, critical: [], warnings: [], metrics: {} };
  const packageResult = await writeReviewPackage({
    jobDir: fixture.jobDir,
    version: 'v001',
    reviewPath: fixture.facecamPath,
    plan,
    qa,
    sources: [],
    renderManifest: {},
    longformArtifacts: {
      condensePlan: { version: 1, mode: 'longform-condense' },
      chapters: '# Chapters\n',
      subtitles: '1\n00:00:00,000 --> 00:00:01,000\nSource\n',
      citations: { version: 1, sources: [] },
    },
  });
  assert.deepEqual((await readdir(packageResult.outputDir)).sort(), [
    'chapters.md',
    'condense-plan.json',
    'edit-report.json',
    'korean-subtitles.srt',
    'preview.mp4',
    'render-manifest.json',
    'source-citations.json',
    'source-list.md',
    'warnings.json',
  ]);
});

test('blocks missing audio, loudness violations, and uncovered segments', () => {
  const report = decideQaGate(compliant({
    hasAudio: false,
    integratedLufs: -8,
    truePeakDbtp: 0.2,
    uncoveredSegmentIds: ['segment_002'],
  }));

  assert.equal(report.passed, false);
  assert.ok(report.critical.includes('MISSING_AUDIO'));
  assert.ok(report.critical.includes('LOUDNESS_OUT_OF_RANGE'));
  assert.ok(report.critical.includes('TRUE_PEAK_TOO_HIGH'));
  assert.ok(report.critical.includes('SEGMENT_COVERAGE'));
});

test('passes compliant media while preserving warnings', () => {
  const report = decideQaGate(compliant({
    warnings: ['DEGRADED_EDIT_PLAN'],
  }));

  assert.equal(report.passed, true);
  assert.deepEqual(report.warnings, ['DEGRADED_EDIT_PLAN']);
});

test('blocks a circular face segment without measured anchor scores', () => {
  const report = decideQaGate(compliant({
    anchorMeasurementsMissing: ['segment_003'],
  }));

  assert.equal(report.passed, false);
  assert.ok(report.critical.includes('FACE_ANCHOR_UNMEASURED'));
});

test('escalates black or frozen frames only when they consume a segment', () => {
  const warning = decideQaGate(compliant({
    blackFrameRatio: 0.08,
    frozenFrameRatio: 0.07,
  }));
  assert.equal(warning.passed, true);
  assert.ok(warning.warnings.includes('BLACK_FRAME_RATIO'));
  assert.ok(warning.warnings.includes('FROZEN_FRAME_RATIO'));

  const critical = decideQaGate(compliant({
    blackFrameRatio: 0.08,
    blackFrameSegmentIds: ['segment_001'],
  }));
  assert.equal(critical.passed, false);
  assert.ok(critical.critical.includes('BLACK_FRAME_SEGMENT'));
});

test('averages three obstruction samples for each approved anchor', async () => {
  const measurements = await analyzeAnchorSafety({
    segments: [{
      id: 'segment_circle',
      startFrame: 0,
      endFrame: 90,
      layout: 'screen-full-face-circle',
      primaryAssetId: 'screen_demo',
    }],
    media: {
      screen_demo: {
        absolutePath: 'C:\\fixture\\screen.mp4',
      },
    },
    fps: 30,
    measureRegion: async ({ anchor, fraction }) => (
      anchor === 'middle-left' ? 0.6 + fraction : 0.1 + fraction
    ),
  });

  assert.equal(measurements.segment_circle.leftEdgeScore, 1.1);
  assert.equal(measurements.segment_circle.rightEdgeScore, 0.6);
});

test('measures real obstruction scores from a supplied screen recording', {
  timeout: 60_000,
}, async () => {
  const fixture = await createFixtureJob();
  const measurements = await analyzeAnchorSafety({
    segments: [{
      id: 'segment_screen',
      startFrame: 0,
      endFrame: 60,
      layout: 'screen-full-face-circle',
      primaryAssetId: 'screen_demo',
    }],
    media: {
      screen_demo: {
        absolutePath: fixture.screenPath,
      },
    },
    fps: 30,
    ffmpegPath: 'ffmpeg',
  });

  assert.equal(Number.isFinite(measurements.segment_screen.leftEdgeScore), true);
  assert.equal(Number.isFinite(measurements.segment_screen.rightEdgeScore), true);
});

test('renders and normalizes a real two-second facecam fixture', {
  timeout: 180_000,
}, async () => {
  const fixture = await createFixtureJob();
  const plan = {
    version: 1,
    jobId: 'video_render_001',
    fps: 30,
    durationFrames: 60,
    segments: [{
      id: 'segment_001',
      startFrame: 0,
      endFrame: 60,
      spokenText: '오늘 꼭 알아야 할 AI 소식입니다.',
      layout: 'face-full',
      primaryAssetId: 'facecam_main',
      sourceId: null,
      captionStyle: 'hook',
      confidence: 1,
      reason: 'opening',
    }],
    warnings: [],
  };
  const transcript = {
    version: 1,
    language: 'ko',
    text: '오늘 꼭 알아야 할 AI 소식입니다.',
    words: [
      { word: '오늘', start: 0.1, end: 0.4 },
      { word: '꼭', start: 0.4, end: 0.6 },
      { word: '알아야', start: 0.6, end: 1 },
      { word: '할', start: 1, end: 1.15 },
      { word: 'AI', start: 1.15, end: 1.4 },
      { word: '소식입니다.', start: 1.4, end: 1.9 },
    ],
  };

  const result = await renderVideo({
    plan,
    transcript,
    workDir: fixture.workDir,
    publicDir: fixture.inputDir,
    media: {
      facecam_main: {
        kind: 'video',
        staticPath: 'facecam/main.mp4',
      },
    },
    anchorMeasurements: {},
    ffmpegPath: 'ffmpeg',
  });

  assert.ok((await stat(result.reviewPath)).size > 0);
  assert.ok((await stat(result.mezzaninePath)).size > 0);

  const qa = await runQa({
    videoPath: result.reviewPath,
    plan,
    media: {
      facecam_main: {
        absolutePath: fixture.facecamPath,
      },
    },
    sources: [],
    anchorMeasurements: {},
    renderedSegmentIds: result.renderedSegmentIds,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });
  assert.equal(qa.metrics.width, 1920);
  assert.equal(qa.metrics.height, 1080);

  const reviewPackage = await writeReviewPackage({
    jobDir: fixture.jobDir,
    version: 'v001',
    reviewPath: result.reviewPath,
    plan,
    qa,
    sources: [],
    renderManifest: {
      renderer: 'remotion-4.0.498',
      durationInFrames: result.composition.durationInFrames,
    },
  });
  assert.deepEqual((await readdir(reviewPackage.outputDir)).sort(), [
    'edit-report.json',
    'preview.mp4',
    'render-manifest.json',
    'source-list.md',
    'warnings.json',
  ]);
});

test('renders a source-full long-form segment with compacted source range', {
  timeout: 180_000,
}, async () => {
  const fixture = await createFixtureJob();
  const plan = {
    version: 1,
    jobId: 'video_render_source_001',
    mode: 'longform-condense',
    fps: 30,
    durationFrames: 30,
    segments: [{
      id: 'source_segment_001',
      sourceStartFrame: 30,
      sourceEndFrame: 60,
      outputStartFrame: 0,
      outputEndFrame: 30,
      durationInFrames: 30,
      startFrame: 0,
      endFrame: 30,
      spokenText: 'source',
      layout: 'source-full',
      primaryAssetId: 'source_main',
      sourceId: null,
      captionStyle: 'none',
      confidence: 1,
      reason: 'source',
    }],
    warnings: [],
  };
  const result = await renderVideo({
    plan,
    transcript: null,
    sourceTranscript: {
      version: 1,
      language: 'en',
      durationSeconds: 2,
      segments: [{ id: 'segment_001', start: 0, end: 2, text: 'source' }],
      words: [],
      koreanWords: [],
    },
    mode: 'longform-condense',
    workDir: fixture.workDir,
    publicDir: fixture.inputDir,
    media: {
      source_main: {
        kind: 'video',
        staticPath: 'facecam/main.mp4',
        durationFrames: 60,
      },
    },
    anchorMeasurements: {},
    ffmpegPath: 'ffmpeg',
  });
  assert.ok((await stat(result.reviewPath)).size > 0);
  assert.deepEqual(result.renderedSegmentIds, ['source_segment_001']);
});
