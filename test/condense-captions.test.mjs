import test from 'node:test';
import assert from 'node:assert/strict';
import { remapCaptionEvents } from '../src/condense/captions.mjs';

test('remaps captions from a removed source gap to compact output time', () => {
  const events = remapCaptionEvents([
    { word: 'first', start: 10, end: 11 },
    { word: 'removed', start: 60, end: 61 },
    { word: 'second', start: 120, end: 121 },
  ], [
    { sourceStartSec: 10, sourceEndSec: 30, outputStartFrame: 0 },
    { sourceStartSec: 120, sourceEndSec: 150, outputStartFrame: 600 },
  ], 30);
  assert.deepEqual(events.map((event) => event.startFrame), [0, 600]);
  assert.deepEqual(events.map((event) => event.text), ['first', 'second']);
});

test('returns no captions for missing words or invalid segments', () => {
  assert.deepEqual(remapCaptionEvents([], [], 30), []);
  assert.deepEqual(remapCaptionEvents([
    { word: 'bad', start: 2, end: 1 },
  ], [{ sourceStartSec: 0, sourceEndSec: 3, outputStartFrame: 0 }], 30), []);
});
