import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CondensePlanSchema,
  SourceTranscriptSchema,
  validateCondensePlan,
} from '../src/condense/contracts.mjs';
import { LAYOUTS } from '../src/contracts.mjs';

const clips = [0, 120, 240, 360, 480].map((start, index) => ({
  id: `clip_${index + 1}`,
  sourceStartSec: start,
  sourceEndSec: start + 78,
  topic: `topic-${index + 1}`,
  summary: `factual block ${index + 1}`,
  whyKept: index === 0 ? 'opening hook' : 'covers a distinct idea',
  confidence: 0.9,
  sourceRef: 'sources.json#interview',
}));

function validPlan(overrides = {}) {
  return {
    version: 1,
    mode: 'longform-condense',
    targetDurationSec: 390,
    sourceDurationSec: 1200,
    clips,
    coverage: [{ idea: 'hook', clipIds: ['clip_1'] }],
    dropped: [],
    warnings: [],
    ...overrides,
  };
}

test('accepts a 390-second plan and rejects a plan outside 300–480 seconds', () => {
  assert.equal(validateCondensePlan(validPlan()).ok, true);
  assert.equal(validateCondensePlan(validPlan({ targetDurationSec: 299 })).ok, false);
  assert.equal(validateCondensePlan(validPlan({ targetDurationSec: 481 })).ok, false);
});

test('accepts English source transcript with optional word timestamps', () => {
  const result = SourceTranscriptSchema.safeParse({
    version: 1,
    language: 'en',
    durationSeconds: 1200,
    segments: [{
      id: 'segment_1',
      start: 0,
      end: 3.2,
      text: 'A complete sentence.',
      speaker: 'host',
      words: [{ word: 'A', start: 0, end: 0.3 }],
    }],
  });
  assert.equal(result.success, true);
});

test('rejects reversed top-level word timestamps', () => {
  const result = SourceTranscriptSchema.safeParse({
    version: 1,
    language: 'en',
    durationSeconds: 1200,
    segments: [{ id: 'segment_1', start: 0, end: 3.2, text: 'A sentence.' }],
    words: [{ word: 'broken', start: 2, end: 1 }],
  });
  assert.equal(result.success, false);
});

test('declares source-full layouts for long-form output', () => {
  assert.ok(LAYOUTS.includes('source-full'));
  assert.ok(LAYOUTS.includes('source-full-face-circle'));
});

test('rejects overlapping source clips and does not echo secret values in errors', () => {
  const result = validateCondensePlan(validPlan({
    clips: [
      clips[0],
      { ...clips[1], sourceStartSec: 70, summary: 'sk-proj-not-for-logs' },
    ],
  }));
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('sk-proj-not-for-logs'), false);
});

test('rejects a clip whose declared duration disagrees with its source range', () => {
  const result = validateCondensePlan(validPlan({
    clips: clips.map((clip, index) => index === 0
      ? { ...clip, durationSec: 12 }
      : clip),
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('durationSec')));
});
