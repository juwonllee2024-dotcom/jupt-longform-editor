import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterizeTranscript } from '../src/condense/chapterizer.mjs';

const fixtureTranscript = {
  version: 1,
  language: 'en',
  durationSeconds: 120,
  segments: [
    { id: 'segment_1', start: 0, end: 10, text: 'First thought.', speaker: 'host' },
    { id: 'segment_2', start: 10, end: 20, text: 'More context.', speaker: 'host' },
    { id: 'segment_3', start: 20, end: 35, text: 'Key point one.', speaker: 'guest' },
    { id: 'segment_4', start: 35, end: 55, text: 'Evidence follows.', speaker: 'guest' },
    { id: 'segment_5', start: 55, end: 70, text: 'Another point.', speaker: 'guest' },
    { id: 'segment_6', start: 70, end: 95, text: 'Conclusion starts.', speaker: 'host' },
    { id: 'segment_7', start: 95, end: 110, text: 'Final thought.', speaker: 'host' },
  ],
};

test('splits only at sentence or speaker boundaries and never cuts inside a sentence', () => {
  const chapters = chapterizeTranscript(fixtureTranscript, {
    minSeconds: 20,
    maxSeconds: 90,
  });
  assert.ok(chapters.length >= 2);
  assert.equal(
    chapters.map((chapter) => chapter.text).join(' '),
    fixtureTranscript.segments.map((segment) => segment.text).join(' '),
  );
  const boundaries = new Set(fixtureTranscript.segments.flatMap((segment) => [segment.start, segment.end]));
  for (const chapter of chapters) {
    assert.equal(boundaries.has(chapter.start), true);
    assert.equal(boundaries.has(chapter.end), true);
    assert.equal(chapter.end > chapter.start, true);
  }
});

test('keeps speaker changes visible in chapter metadata', () => {
  const chapters = chapterizeTranscript(fixtureTranscript, {
    minSeconds: 20,
    maxSeconds: 90,
  });
  assert.ok(chapters.some((chapter) => chapter.speaker === 'guest'));
  assert.ok(chapters.some((chapter) => chapter.speaker === 'host'));
});
