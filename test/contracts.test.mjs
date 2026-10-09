import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EditPlanSchema,
  JobStateSchema,
  SourcesSchema,
  parseContract,
} from '../src/contracts.mjs';

test('accepts only declared job states', () => {
  assert.equal(JobStateSchema.parse('queued'), 'queued');
  assert.throws(() => JobStateSchema.parse('published'));
});

test('rejects overlapping edit segments and unknown layouts', () => {
  const plan = {
    version: 1,
    jobId: 'video_20260723_001',
    durationFrames: 300,
    fps: 30,
    segments: [
      {
        id: 'segment_a',
        startFrame: 0,
        endFrame: 180,
        spokenText: '안녕',
        layout: 'face-full',
        primaryAssetId: 'facecam_main',
        sourceId: null,
        captionStyle: 'hook',
        confidence: 1,
        reason: 'hook',
      },
      {
        id: 'segment_b',
        startFrame: 150,
        endFrame: 300,
        spokenText: '설명',
        layout: 'random-layout',
        primaryAssetId: 'facecam_main',
        sourceId: null,
        captionStyle: 'normal',
        confidence: 1,
        reason: 'body',
      },
    ],
    warnings: [],
  };
  assert.equal(EditPlanSchema.safeParse(plan).success, false);
});

test('rejects absolute and traversal paths in source metadata', () => {
  for (const localAsset of ['C:\\secret.txt', '/etc/passwd', '../outside.png']) {
    const result = SourcesSchema.safeParse({
      version: 1,
      sources: [{
        id: 'source_a',
        title: 'A',
        url: 'https://example.com/a',
        publisher: 'Example',
        publishedAt: '2026-07-22',
        usage: 'commentary-screenshot',
        localAsset,
      }],
      screenClips: [],
    });
    assert.equal(result.success, false);
  }
});

test('returns bounded contract errors without echoing secret values', () => {
  const result = parseContract(SourcesSchema, { secret: 'sk-proj-not-for-logs' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('sk-proj-not-for-logs'), false);
});
