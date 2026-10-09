import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEditPlan } from '../src/planner/nim-edit-planner.mjs';

const base = {
  jobId: 'video_plan_001',
  fps: 30,
  durationFrames: 300,
  script: '안녕하세요',
  transcript: {
    version: 1,
    language: 'ko',
    text: '안녕하세요',
    words: [{ word: '안녕하세요', start: 0, end: 10 }],
  },
  takeMap: {
    version: 1,
    ranges: [{
      start: 0,
      end: 10,
      text: '안녕하세요',
      accepted: true,
      reason: 'complete',
    }],
  },
  assets: [{
    id: 'facecam_main',
    description: 'Juwon face camera',
    sourceId: null,
  }],
  sources: [],
};

test('accepts valid JSON inside one optional Markdown fence', async () => {
  const valid = JSON.parse(await readFile(
    new URL('./fixtures/planner-valid.json', import.meta.url),
    'utf8',
  ));
  const result = await createEditPlan({
    ...base,
    planWithNim: async () => `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
  });

  assert.equal(result.degraded, false);
  assert.equal(result.plan.segments[0].layout, 'face-full');
});

test('uses labeled face-only fallback for invalid provider results', async () => {
  const invalidResults = [
    new Error('timeout'),
    '{bad',
    JSON.stringify({
      version: 1,
      jobId: 'video_plan_001',
      fps: 30,
      durationFrames: 300,
      segments: [{
        id: 'segment_001',
        startFrame: 0,
        endFrame: 300,
        spokenText: '안녕하세요',
        layout: 'visual-full',
        primaryAssetId: 'missing_asset',
        sourceId: null,
        captionStyle: 'normal',
        confidence: 1,
        reason: 'bad',
      }],
      warnings: [],
    }),
  ];

  for (const output of invalidResults) {
    const result = await createEditPlan({
      ...base,
      planWithNim: async () => {
        if (output instanceof Error) throw output;
        return output;
      },
    });
    assert.equal(result.degraded, true);
    assert.equal(
      result.plan.segments.every((segment) => segment.layout === 'face-full'),
      true,
    );
    assert.ok(result.warnings.includes('DEGRADED_EDIT_PLAN'));
  }
});

test('falls back when any visual confidence is below 0.60', async () => {
  const lowConfidence = {
    version: 1,
    jobId: 'video_plan_001',
    fps: 30,
    durationFrames: 300,
    segments: [{
      id: 'segment_001',
      startFrame: 0,
      endFrame: 300,
      spokenText: '안녕하세요',
      layout: 'face-full',
      primaryAssetId: 'facecam_main',
      sourceId: null,
      captionStyle: 'normal',
      confidence: 0.59,
      reason: 'uncertain',
    }],
    warnings: [],
  };
  const result = await createEditPlan({
    ...base,
    planWithNim: async () => JSON.stringify(lowConfidence),
  });
  assert.equal(result.degraded, true);
});
