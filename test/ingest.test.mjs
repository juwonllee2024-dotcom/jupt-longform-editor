import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureJob } from './fixtures/generate-media.mjs';
import { ingestJob } from '../src/ingest.mjs';

test('creates stable hashes and probes facecam without changing input', async () => {
  const fixture = await createFixtureJob();
  const originalHash = await fixture.facecamHash();

  const first = await ingestJob({
    jobId: 'video_fixture_001',
    jobDir: fixture.jobDir,
    ffprobePath: 'ffprobe',
  });
  const second = await ingestJob({
    jobId: 'video_fixture_001',
    jobDir: fixture.jobDir,
    ffprobePath: 'ffprobe',
  });

  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.facecam.width, 640);
  assert.equal(first.facecam.height, 360);
  assert.equal(first.assets.some((asset) => asset.id === 'screen_demo'), true);
  assert.equal(await fixture.facecamHash(), originalHash);
  assert.equal(first.facecam.sha256, originalHash);
});

test('rejects a source path that escapes the input directory', async () => {
  const fixture = await createFixtureJob();
  const sourcesPath = new URL(`file:///${fixture.inputDir.replaceAll('\\', '/')}/sources.json`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(sourcesPath, JSON.stringify({
    version: 1,
    sources: [],
    screenClips: [{
      id: 'screen_escape',
      path: '../outside.mp4',
      description: 'unsafe',
      scriptHints: [],
    }],
  }));

  await assert.rejects(
    () => ingestJob({
      jobId: 'video_fixture_002',
      jobDir: fixture.jobDir,
      ffprobePath: 'ffprobe',
    }),
    /sources contract invalid/,
  );
});
