import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remapWordTimestamps,
  translateSelected,
  wordsToSrt,
} from '../src/condense/translate.mjs';

const sourceWords = [
  { word: 'Hello', start: 0, end: 0.5 },
  { word: 'world', start: 0.5, end: 1 },
];

test('uses an injected translator and returns validated Korean word timestamps', async () => {
  const result = await translateSelected({
    sourceWords,
    selectedSegments: [{ sourceStartSec: 0, sourceEndSec: 2 }],
    provider: async ({ words }) => words.map((word) => ({
      word: word.word === 'Hello' ? '안녕' : '세계',
      start: word.start,
      end: word.end,
    })),
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.koreanWords.map((word) => word.word), ['안녕', '세계']);
});

test('passes selected source segment text to a translator without word timestamps', async () => {
  let received;
  const result = await translateSelected({
    sourceWords: [],
    sourceSegments: [{ start: 10, end: 12, text: 'A complete source thought.' }],
    selectedSegments: [{ sourceStartSec: 10, sourceEndSec: 12 }],
    provider: async (input) => {
      received = input;
      return [{ word: '완전한', start: 10, end: 11 }];
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(received.segments[0].text, 'A complete source thought.');
});

test('returns review-required instead of fabricating Korean subtitles without a provider', async () => {
  const result = await translateSelected({ sourceWords, selectedSegments: [] });
  assert.equal(result.status, 'review-required');
  assert.deepEqual(result.koreanWords, []);
  assert.equal(result.warning, 'KOREAN_SUBTITLES_REVIEW_REQUIRED');
});

test('writes deterministic SRT timestamps for Korean words', () => {
  assert.equal(
    wordsToSrt([{ word: '안녕', start: 0, end: 1.25 }]),
    '1\n00:00:00,000 --> 00:00:01,250\n안녕\n',
  );
});

test('groups adjacent Korean words into readable subtitle cues', () => {
  assert.equal(
    wordsToSrt([
      { word: '안녕', start: 0, end: 0.4 },
      { word: '세계', start: 0.4, end: 0.8 },
    ]),
    '1\n00:00:00,000 --> 00:00:00,800\n안녕 세계\n',
  );
});

test('remaps Korean word timestamps across removed source gaps', () => {
  const mapped = remapWordTimestamps(
    [{ word: '두번째', start: 120, end: 121 }],
    [{ sourceStartSec: 120, sourceEndSec: 150, outputStartFrame: 600 }],
    30,
  );
  assert.deepEqual(mapped, [{ word: '두번째', start: 20, end: 21 }]);
});
