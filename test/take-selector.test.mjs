import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTakes } from '../src/transcript/take-selector.mjs';

test('keeps latest complete repeated sentence and rejects earlier attempt', () => {
  const transcript = {
    version: 1,
    language: 'ko',
    text: '오늘 소식은 오늘 소식은 중요합니다',
    words: [
      { word: '오늘', start: 0, end: 0.3 },
      { word: '소식은', start: 0.3, end: 0.7 },
      { word: '오늘', start: 1.2, end: 1.5 },
      { word: '소식은', start: 1.5, end: 1.9 },
      { word: '중요합니다', start: 1.9, end: 2.5 },
    ],
  };

  const result = selectTakes({
    script: '오늘 소식은 중요합니다',
    transcript,
  });

  assert.equal(
    result.ranges.some((range) => !range.accepted && range.reason === 'repeat'),
    true,
  );
  assert.equal(
    result.ranges.some((range) => range.accepted && range.text.includes('중요합니다')),
    true,
  );
});

test('keeps natural sentence handles and does not cut every short pause', () => {
  const transcript = {
    version: 1,
    language: 'ko',
    text: '한 문장 입니다',
    words: [
      { word: '한', start: 1, end: 1.2 },
      { word: '문장', start: 1.4, end: 1.8 },
      { word: '입니다', start: 2.1, end: 2.5 },
    ],
  };

  const result = selectTakes({
    script: '한 문장 입니다',
    transcript,
  });
  const accepted = result.ranges.find((range) => range.accepted);

  assert.ok(accepted.start <= 0.92);
  assert.ok(accepted.end >= 2.58);
  assert.equal(result.ranges.filter((range) => range.accepted).length, 1);
});

test('blocks planning when script coverage is below seventy percent', () => {
  const transcript = {
    version: 1,
    language: 'ko',
    text: '전혀 다른 말',
    words: [
      { word: '전혀', start: 0, end: 0.3 },
      { word: '다른', start: 0.3, end: 0.6 },
      { word: '말', start: 0.6, end: 0.9 },
    ],
  };

  assert.throws(
    () => selectTakes({
      script: '오늘 중요한 인공지능 뉴스를 설명합니다',
      transcript,
    }),
    /alignment below 0.70/,
  );
});
