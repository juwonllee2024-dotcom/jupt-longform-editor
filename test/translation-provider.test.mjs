import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaTranslator } from '../src/condense/translation-provider.mjs';

test('Ollama translator returns timestamped Korean segment cues without streaming', async () => {
  let request;
  const translator = createOllamaTranslator({
    endpoint: 'http://127.0.0.1:11434/api/chat',
    model: 'qwen3:8b',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            segments: [{ start: 10, end: 12, text: '완전한 생각.' }],
          }),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const words = await translator({
    segments: [{ start: 10, end: 12, text: 'A complete source thought.' }],
  });
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'qwen3:8b');
  assert.equal(body.stream, false);
  assert.match(body.messages.at(-1).content, /A complete source thought/);
  assert.deepEqual(words, [{ word: '완전한 생각.', start: 10, end: 12 }]);
});
