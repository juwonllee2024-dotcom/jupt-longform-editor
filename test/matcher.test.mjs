import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAssets } from '../src/assets/matcher.mjs';

function planFor({
  jobId,
  spokenText,
  confidence = 1,
}) {
  return {
    version: 1,
    jobId,
    fps: 30,
    durationFrames: 300,
    segments: [{
      id: 'segment_001',
      startFrame: 0,
      endFrame: 300,
      spokenText,
      layout: 'face-full',
      primaryAssetId: 'facecam_main',
      sourceId: null,
      captionStyle: 'normal',
      confidence,
      reason: 'product demonstration',
    }],
    warnings: [],
  };
}

test('prefers matching real screen recording over article capture', () => {
  const plan = planFor({
    jobId: 'video_match_001',
    spokenText: '직접 사용해 보면 로그인 화면이 나옵니다',
  });
  const original = structuredClone(plan);

  const result = matchAssets({
    plan,
    assets: [
      {
        id: 'screen_login',
        kind: 'screen',
        description: '직접 사용 로그인 화면',
        scriptHints: ['직접 사용해 보면'],
        sourceId: null,
      },
      {
        id: 'article_login',
        kind: 'image',
        description: '로그인 기능 기사',
        scriptHints: [],
        sourceId: 'source_login',
      },
    ],
    sources: [{ id: 'source_login' }],
  });

  assert.equal(result.plan.segments[0].primaryAssetId, 'screen_login');
  assert.equal(result.plan.segments[0].layout, 'screen-full-face-circle');
  assert.deepEqual(plan, original);
});

test('falls back to face when score is below threshold', () => {
  const result = matchAssets({
    plan: planFor({
      jobId: 'video_match_002',
      spokenText: '완전히 다른 내용',
      confidence: 0.4,
    }),
    assets: [{
      id: 'screen_login',
      kind: 'screen',
      description: '로그인',
      scriptHints: [],
      sourceId: null,
    }],
    sources: [],
  });

  assert.equal(result.plan.segments[0].layout, 'face-full');
  assert.equal(result.plan.segments[0].primaryAssetId, 'facecam_main');
  assert.match(result.warnings[0], /LOW_CONFIDENCE_VISUAL/);
});

test('does not use an image whose source is missing', () => {
  const result = matchAssets({
    plan: planFor({
      jobId: 'video_match_003',
      spokenText: '공식 발표 내용을 확인합니다',
    }),
    assets: [{
      id: 'official_release',
      kind: 'image',
      description: '공식 발표 내용',
      scriptHints: ['공식 발표'],
      sourceId: 'source_missing',
    }],
    sources: [],
  });

  assert.equal(result.plan.segments[0].layout, 'face-full');
});
