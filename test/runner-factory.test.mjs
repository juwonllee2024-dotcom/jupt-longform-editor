import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerForMode } from '../src/runner-factory.mjs';

test('creates long-form runner only for explicit longform-condense mode', async () => {
  const store = { status: async () => ({ state: 'queued' }) };
  const runner = createRunnerForMode({ mode: 'longform-condense', store });
  assert.equal((await runner.status()).state, 'queued');
  assert.throws(
    () => createRunnerForMode({ mode: 'unknown', store }),
    /unknown video editor mode/,
  );
});
