import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';

test('bundles the JuwonAiNews Remotion composition', async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const entryPoint = path.join(
    testDir,
    '..',
    'src',
    'composition',
    'index.jsx',
  );
  const serveUrl = await bundle({
    entryPoint,
    onProgress: () => {},
  });
  assert.equal(typeof serveUrl, 'string');
  assert.ok(serveUrl.length > 0);
});
