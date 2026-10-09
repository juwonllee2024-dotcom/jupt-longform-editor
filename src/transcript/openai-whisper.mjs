import { execFile } from 'node:child_process';
import {
  mkdir,
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { TranscriptSchema, parseContract } from '../contracts.mjs';
import { writeJsonAtomic } from '../atomic-json.mjs';

const execFileAsync = promisify(execFile);
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function validateKey(apiKey) {
  if (
    typeof apiKey !== 'string'
    || apiKey.length < 10
    || apiKey.length > 500
    || /\s/.test(apiKey)
  ) {
    throw new Error('OpenAI API key is unavailable');
  }
}

function normalizeTranscript(providerResult) {
  if (
    !providerResult
    || typeof providerResult !== 'object'
    || typeof providerResult.text !== 'string'
    || !Array.isArray(providerResult.words)
  ) {
    throw new Error('transcription response missing word timestamps');
  }
  const words = providerResult.words.map((item) => ({
    word: typeof item?.word === 'string' ? item.word.trim() : '',
    start: Number(item?.start),
    end: Number(item?.end),
  }));
  let previousStart = 0;
  for (const word of words) {
    if (
      !word.word
      || !Number.isFinite(word.start)
      || !Number.isFinite(word.end)
      || word.start < previousStart
      || word.end <= word.start
    ) {
      throw new Error('transcription response contains invalid word timestamps');
    }
    previousStart = word.start;
  }
  const transcript = {
    version: 1,
    language: 'ko',
    text: providerResult.text,
    words,
  };
  const parsed = parseContract(TranscriptSchema, transcript);
  if (!parsed.ok) throw new Error(`transcript contract invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

export async function transcribeFacecam({
  facecamPath,
  workDir,
  apiKey,
  ffmpegPath = 'ffmpeg',
  fetchImpl = fetch,
}) {
  validateKey(apiKey);
  await mkdir(workDir, { recursive: true });
  const audioPath = path.join(workDir, 'transcription-input.mp3');
  await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', facecamPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    audioPath,
  ], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const audioMetadata = await stat(audioPath);
  if (!audioMetadata.isFile() || audioMetadata.size <= 0 || audioMetadata.size > MAX_AUDIO_BYTES) {
    throw new Error('transcription audio exceeds request limit');
  }

  const form = new FormData();
  form.set(
    'file',
    new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }),
    'facecam.mp3',
  );
  form.set('model', 'whisper-1');
  form.set('language', 'ko');
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.set('temperature', '0');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let response;
  try {
    response = await fetchImpl(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'network';
    throw new Error(`transcription request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    throw new Error(`transcription request failed: ${Number(response?.status) || 500}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('transcription response exceeds 5 MiB');
  }
  let providerResult;
  try {
    providerResult = JSON.parse(text);
  } catch {
    throw new Error('transcription response is not valid JSON');
  }
  const transcript = normalizeTranscript(providerResult);
  await writeJsonAtomic(path.join(workDir, 'transcript.json'), transcript);
  return transcript;
}
