import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { transcribeFacecam } from '../src/transcript/openai-whisper.mjs';
import { createFixtureJob } from './fixtures/generate-media.mjs';

test('requests whisper-1 verbose JSON with Korean word timestamps', async () => {
  const fixture = await createFixtureJob();
  const responseBody = JSON.parse(await readFile(
    new URL('./fixtures/whisper-valid.json', import.meta.url),
    'utf8',
  ));
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const transcript = await transcribeFacecam({
    facecamPath: fixture.facecamPath,
    workDir: fixture.workDir,
    apiKey: 'test-secret-value',
    ffmpegPath: 'ffmpeg',
    fetchImpl,
  });

  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.init.body.get('model'), 'whisper-1');
  assert.equal(request.init.body.get('language'), 'ko');
  assert.equal(request.init.body.get('response_format'), 'verbose_json');
  assert.deepEqual(
    request.init.body.getAll('timestamp_granularities[]'),
    ['word', 'segment'],
  );
  assert.match(request.init.headers.Authorization, /^Bearer /);
  assert.equal(transcript.language, 'ko');
  assert.ok(transcript.words.length > 0);
  assert.equal(JSON.stringify(transcript).includes('test-secret-value'), false);
});

test('redacts API failure bodies and does not write a transcript', async () => {
  const fixture = await createFixtureJob();
  const fetchImpl = async () => new Response(
    'Bearer test-secret-value',
    { status: 401 },
  );

  await assert.rejects(
    () => transcribeFacecam({
      facecamPath: fixture.facecamPath,
      workDir: fixture.workDir,
      apiKey: 'test-secret-value',
      ffmpegPath: 'ffmpeg',
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.message, 'transcription request failed: 401');
      assert.equal(error.message.includes('test-secret-value'), false);
      return true;
    },
  );
  await assert.rejects(
    () => access(path.join(fixture.workDir, 'transcript.json')),
    /ENOENT/,
  );
});
