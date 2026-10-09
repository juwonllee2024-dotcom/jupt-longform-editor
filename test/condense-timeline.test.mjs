import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCondenseTimeline } from '../src/condense/timeline.mjs';

test('compacts source ranges while retaining source frame bounds', () => {
  const result = mapCondenseTimeline({ clips: [
    { id: 'clip_a', sourceStartSec: 10, sourceEndSec: 30 },
    { id: 'clip_b', sourceStartSec: 120, sourceEndSec: 150 },
  ] }, 30);
  assert.deepEqual(
    result.segments.map(({ sourceStartFrame, sourceEndFrame }) => [sourceStartFrame, sourceEndFrame]),
    [[300, 900], [3600, 4500]],
  );
  assert.deepEqual(
    result.segments.map(({ outputStartFrame, outputEndFrame }) => [outputStartFrame, outputEndFrame]),
    [[0, 600], [600, 1500]],
  );
  assert.equal(result.durationFrames, 1500);
});

test('rejects overlapping or reversed source ranges', () => {
  assert.throws(
    () => mapCondenseTimeline({ clips: [
      { id: 'clip_a', sourceStartSec: 10, sourceEndSec: 30 },
      { id: 'clip_b', sourceStartSec: 25, sourceEndSec: 40 },
    ] }, 30),
    /ordered and non-overlapping/,
  );
});
