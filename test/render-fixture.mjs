import path from 'node:path';
import { analyzeAnchorSafety } from '../src/render/anchor-analysis.mjs';
import { renderVideo } from '../src/render/renderer.mjs';
import { runQa } from '../src/qa/checks.mjs';
import { writeReviewPackage } from '../src/review-package.mjs';

const jobDirIndex = process.argv.indexOf('--job-dir');
if (jobDirIndex < 0 || !process.argv[jobDirIndex + 1]) {
  throw new Error('usage: node test/render-fixture.mjs --job-dir <fixture-job>');
}

const jobDir = path.resolve(process.argv[jobDirIndex + 1]);
const inputDir = path.join(jobDir, 'input');
const workDir = path.join(jobDir, 'work');
const facecamPath = path.join(inputDir, 'facecam', 'main.mp4');
const plan = {
  version: 1,
  jobId: 'video_fixture_001',
  fps: 30,
  durationFrames: 60,
  segments: [{
    id: 'segment_001',
    startFrame: 0,
    endFrame: 60,
    spokenText: 'AI 영상 편집 테스트입니다.',
    layout: 'face-full',
    primaryAssetId: 'facecam_main',
    sourceId: null,
    captionStyle: 'hook',
    confidence: 1,
    reason: 'fixture opening',
  }],
  warnings: [],
};
const transcript = {
  version: 1,
  language: 'ko',
  text: 'AI 영상 편집 테스트입니다.',
  words: [
    { word: 'AI', start: 0.1, end: 0.4 },
    { word: '영상', start: 0.4, end: 0.8 },
    { word: '편집', start: 0.8, end: 1.2 },
    { word: '테스트입니다.', start: 1.2, end: 1.9 },
  ],
};
const media = {
  facecam_main: {
    kind: 'video',
    staticPath: 'facecam/main.mp4',
    absolutePath: facecamPath,
  },
};
const anchorMeasurements = await analyzeAnchorSafety({
  segments: plan.segments,
  media,
  fps: plan.fps,
});
const render = await renderVideo({
  plan,
  transcript,
  media,
  anchorMeasurements,
  workDir,
  publicDir: inputDir,
});
const qa = await runQa({
  videoPath: render.reviewPath,
  plan,
  media,
  sources: [],
  anchorMeasurements,
  renderedSegmentIds: render.renderedSegmentIds,
});
if (!qa.passed) throw new Error(`fixture QA blocked: ${qa.critical.join(', ')}`);
const review = await writeReviewPackage({
  jobDir,
  version: 'v001',
  reviewPath: render.reviewPath,
  plan,
  qa,
  sources: [],
  renderManifest: {
    renderer: 'remotion-4.0.498',
    durationInFrames: render.composition.durationInFrames,
  },
});

process.stdout.write(`${JSON.stringify({
  previewPath: review.previewPath,
  qa,
}, null, 2)}\n`);
