import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCondenseClips } from '../src/condense/selector.mjs';

const fixtureChapters = [
  ['chapter_001', 0, 45, 'hook', 'hook', 1.0],
  ['chapter_002', 60, 105, 'context', 'context', 0.9],
  ['chapter_003', 120, 165, 'idea-a', 'idea-a', 0.95],
  ['chapter_004', 180, 225, 'idea-a-repeat', 'idea-a', 0.7],
  ['chapter_005', 240, 285, 'idea-b', 'idea-b', 0.9],
  ['chapter_006', 300, 345, 'evidence', 'evidence', 0.95],
  ['chapter_007', 360, 405, 'example', 'example', 0.85],
  ['chapter_008', 420, 465, 'conclusion', 'conclusion', 0.95],
  ['chapter_009', 480, 525, 'extra', 'extra', 0.2],
].map(([id, start, end, text, topic, importance]) => ({
  id,
  start,
  end,
  text,
  topic,
  topicGroup: topic === 'idea-a' ? 'idea-a' : topic,
  role: topic,
  importance,
  confidence: importance,
  summary: text,
}));

const options = {
  targetDurationSec: 390,
  sourceHash: 'a'.repeat(64),
  requiredTopics: ['hook', 'context', 'evidence', 'conclusion'],
};

test('selects chronological non-duplicate chapters within target range and preserves required coverage', () => {
  const result = selectCondenseClips(fixtureChapters, options);
  const total = result.clips.reduce((sum, clip) => sum + clip.durationSec, 0);
  assert.ok(total >= 300);
  assert.ok(total <= 480);
  assert.deepEqual(
    result.clips.map((clip) => clip.sourceStartSec),
    [...result.clips].map((clip) => clip.sourceStartSec).sort((a, b) => a - b),
  );
  assert.equal(new Set(result.clips.map((clip) => clip.topicGroup)).size, result.clips.length);
  for (const topic of options.requiredTopics) {
    assert.ok(result.coverage.some((entry) => entry.idea === topic && entry.clipIds.length > 0));
  }
});

test('same source and configuration produce the same selection and explain dropped chapters', () => {
  const first = selectCondenseClips(fixtureChapters, options);
  const second = selectCondenseClips(fixtureChapters, options);
  assert.deepEqual(first, second);
  assert.ok(first.dropped.some((entry) => entry.reason.includes('duplicate topic')));
});

test('uses conservative structural slots when chapters have no topic labels', () => {
  const chapters = Array.from({ length: 12 }, (_, index) => ({
    id: `plain_${String(index + 1).padStart(3, '0')}`,
    start: index * 100,
    end: index * 100 + 40,
    text: `A complete thought ${index + 1}.`,
  }));
  const result = selectCondenseClips(chapters, {
    targetDurationSec: 300,
    requiredTopics: ['hook', 'context', 'evidence', 'conclusion'],
  });
  for (const topic of ['hook', 'context', 'evidence', 'conclusion']) {
    assert.ok(result.coverage.some((entry) => entry.idea === topic && entry.clipIds.length > 0));
  }
  assert.ok(result.clips.some((clip) => clip.sourceStartSec === 0));
  assert.ok(result.clips.some((clip) => clip.sourceStartSec === 1100));
});

test('bounds long chapter summaries to the plan contract limit', () => {
  const result = selectCondenseClips([
    {
      id: 'chapter_long',
      start: 0,
      end: 90,
      text: 'x'.repeat(2_000),
      summary: 'x'.repeat(2_000),
      topic: 'hook',
      topicGroup: 'hook',
    },
  ], {
    targetDurationSec: 390,
    requiredTopics: [],
  });
  assert.equal(result.clips[0].summary.length, 1_000);
});
