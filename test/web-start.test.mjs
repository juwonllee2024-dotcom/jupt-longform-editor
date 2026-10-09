import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultWebServerConfig, isMainModule } from '../src/web/start.mjs';

test('uses loopback and port 12345 defaults', () => {
  assert.deepEqual(defaultWebServerConfig({}), { host: '127.0.0.1', port: 12345 });
});

test('recognizes Windows file paths when starting the server entrypoint', () => {
  assert.equal(
    isMainModule(
      'C:\\work\\video-editor\\src\\web\\start.mjs',
      'file:///C:/work/video-editor/src/web/start.mjs',
    ),
    true,
  );
  assert.equal(
    isMainModule(
      'C:\\work\\video-editor\\src\\web\\other.mjs',
      'file:///C:/work/video-editor/src/web/start.mjs',
    ),
    false,
  );
  const physicalPath = fileURLToPath(import.meta.url);
  const aliasedPath = physicalPath.replace(/OneDrive - Burnaby/i, 'OneDrive');
  assert.equal(isMainModule(aliasedPath, pathToFileURL(physicalPath).href), true);
});

test('accepts explicit local host and port values', () => {
  assert.deepEqual(defaultWebServerConfig({ HOST: '127.0.0.1', PORT: '12346' }), {
    host: '127.0.0.1',
    port: 12346,
  });
});
