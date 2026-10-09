import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureJob } from './fixtures/generate-media.mjs';
import { ingestLongformSource } from '../src/condense/source-ingest.mjs';

test('ingests source video with stable hash and provenance metadata', async () => {
  const fixture = await createFixtureJob();
  await copyFile(fixture.facecamPath, path.join(fixture.inputDir, 'source', 'main.mp4'))
    .catch(async (error) => {
      if (error.code !== 'ENOENT') throw error;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(fixture.inputDir, 'source'), { recursive: true });
      await copyFile(fixture.facecamPath, path.join(fixture.inputDir, 'source', 'main.mp4'));
    });
  await writeFile(path.join(fixture.inputDir, 'sources.json'), JSON.stringify({
    version: 1,
    rights: {
      status: 'licensed',
      note: 'fixture',
      permission: { type: 'personal-email', assertedByUser: true, evidence: 'local-email-not-uploaded' },
    },
    sources: [],
    screenClips: [],
  }));

  const first = await ingestLongformSource({
    jobId: 'video_source_001',
    jobDir: fixture.jobDir,
    ffprobePath: 'ffprobe',
  });
  const second = await ingestLongformSource({
    jobId: 'video_source_001',
    jobDir: fixture.jobDir,
    ffprobePath: 'ffprobe',
  });
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.source.width, 640);
  assert.equal(first.source.height, 360);
  assert.equal(first.rights.status, 'licensed');
  assert.equal(first.rights.permission.type, 'personal-email');
  assert.equal(first.rights.permission.assertedByUser, true);
  assert.deepEqual(JSON.parse(await readFile(
    path.join(fixture.workDir, 'source-ingest-manifest.json'),
    'utf8',
  )), first);
});

test('blocks when long-form source video is missing', async () => {
  const fixture = await createFixtureJob();
  await assert.rejects(
    () => ingestLongformSource({
      jobId: 'video_source_002',
      jobDir: fixture.jobDir,
      ffprobePath: 'ffprobe',
    }),
    /source video is required/,
  );
});
