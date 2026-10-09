import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcribeSource } from '../src/condense/source-transcript.mjs';
import { transcribeSourceWithOpenAI } from '../src/condense/source-transcript.mjs';
import { createFixtureJob } from './fixtures/generate-media.mjs';

const transcript = {
  version: 1,
  language: 'en',
  durationSeconds: 600,
  segments: [{
    id: 'segment_001',
    start: 0,
    end: 4,
    text: 'A complete source sentence.',
    speaker: 'guest',
    words: [
      { word: 'A', start: 0, end: 0.4 },
      { word: 'complete', start: 0.4, end: 1.2 },
    ],
  }],
};

test('validates supplied English transcript, flattens words, and persists it', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'juwon-source-transcript-'));
  const result = await transcribeSource({
    sourcePath: 'C:\\fixture\\source.mp4',
    workDir,
    suppliedTranscript: transcript,
  });
  assert.equal(result.language, 'en');
  assert.equal(result.words.length, 2);
  assert.deepEqual(JSON.parse(await readFile(
    path.join(workDir, 'source-transcript.en.json'),
    'utf8',
  )), result);
});

test('reports provider failure without pretending a transcript exists', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'juwon-source-transcript-fail-'));
  await assert.rejects(
    () => transcribeSource({
      sourcePath: 'C:\\fixture\\source.mp4',
      workDir,
      provider: async () => { throw new Error('provider unavailable'); },
    }),
    /source transcription failed/,
  );
});

test('auto-discovers input/source/transcript.en.json when no provider is passed', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-source-transcript-discover-'));
  const sourceDir = path.join(jobDir, 'input', 'source');
  const workDir = path.join(jobDir, 'work');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'transcript.en.json'), JSON.stringify(transcript), 'utf8');
  const result = await transcribeSource({
    sourcePath: path.join(sourceDir, 'main.mp4'),
    workDir,
  });
  assert.equal(result.language, 'en');
  assert.equal(result.words.length, 2);
});

test('optional OpenAI source adapter requests English word and segment timestamps', async () => {
  const fixture = await createFixtureJob();
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      duration: 2,
      segments: [{ id: 0, start: 0, end: 2, text: 'A complete thought.' }],
      words: [
        { word: 'A', start: 0, end: 0.4 },
        { word: 'complete', start: 0.4, end: 1.2 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await transcribeSourceWithOpenAI({
    sourcePath: fixture.facecamPath,
    workDir: fixture.workDir,
    apiKey: 'test-secret-value',
    ffmpegPath: 'ffmpeg',
    fetchImpl,
  });
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.init.body.get('language'), 'en');
  assert.deepEqual(request.init.body.getAll('timestamp_granularities[]'), ['word', 'segment']);
  assert.equal(result.language, 'en');
  assert.equal(result.segments[0].id, 'segment_001');
  assert.equal(JSON.stringify(result).includes('test-secret-value'), false);
});
