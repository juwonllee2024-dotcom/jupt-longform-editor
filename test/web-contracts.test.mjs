import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebJobId,
  isSafeWebJobId,
  parseCreateRequest,
} from '../src/web/contracts.mjs';

test('accepts a YouTube URL and allows only the 300–480 second range', () => {
  const request = parseCreateRequest({
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY&si=tracking',
    targetDurationSec: 390,
  });
  assert.equal(request.youtubeUrl, 'https://www.youtube.com/watch?v=abc123_XY');
  assert.equal(request.targetDurationSec, 390);
  assert.equal(request.useOllama, false);
  assert.equal(request.ollamaModel, 'qwen3:8b');
  assert.throws(
    () => parseCreateRequest({ youtubeUrl: 'https://example.com/x', targetDurationSec: 390 }),
    /YouTube/,
  );
  assert.throws(
    () => parseCreateRequest({ youtubeUrl: 'https://www.youtube.com/watch?v=abc123_XY', targetDurationSec: 299 }),
    /300/,
  );
});

test('normalizes optional local Ollama settings without accepting arbitrary values', () => {
  const request = parseCreateRequest({
    youtubeUrl: 'https://youtu.be/abc123_XY',
    targetDurationSec: 480,
    useOllama: true,
    ollamaModel: 'qwen3:8b',
  });
  assert.equal(request.youtubeUrl, 'https://www.youtube.com/watch?v=abc123_XY');
  assert.equal(request.useOllama, true);
  assert.equal(request.ollamaModel, 'qwen3:8b');
  assert.throws(
    () => parseCreateRequest({ youtubeUrl: 'https://youtu.be/abc123_XY', targetDurationSec: 390, useOllama: 'yes' }),
    /useOllama/,
  );
});

test('accepts a user-asserted personal email permission without storing the email', () => {
  const request = parseCreateRequest({
    youtubeUrl: 'https://youtu.be/abc123_XY',
    targetDurationSec: 390,
    personalPermission: true,
    permissionNote: '허가 메일 확인 완료',
  });
  assert.equal(request.personalPermission, true);
  assert.equal(request.permissionNote, '허가 메일 확인 완료');
  assert.throws(
    () => parseCreateRequest({
      youtubeUrl: 'https://youtu.be/abc123_XY',
      targetDurationSec: 390,
      personalPermission: 'yes',
    }),
    /personalPermission/,
  );
  assert.throws(
    () => parseCreateRequest({
      youtubeUrl: 'https://youtu.be/abc123_XY',
      targetDurationSec: 390,
      permissionNote: 'x'.repeat(501),
    }),
    /permissionNote/,
  );
});

test('generates and validates safe web job IDs', () => {
  const id = createWebJobId(new Date('2026-08-30T12:34:56.000Z'), 'AbC-123');
  assert.equal(id, 'web_20260830_123456_abc-123');
  assert.equal(isSafeWebJobId(id), true);
  assert.equal(isSafeWebJobId('../escape'), false);
  assert.equal(isSafeWebJobId('web_OK'), false);
});
