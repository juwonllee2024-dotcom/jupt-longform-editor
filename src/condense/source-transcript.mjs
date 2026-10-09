import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../atomic-json.mjs';
import { SourceTranscriptSchema } from './contracts.mjs';

const execFileAsync = promisify(execFile);
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function flattenWords(segments) {
  return segments
    .flatMap((segment) => Array.isArray(segment.words) ? segment.words : [])
    .map((word) => ({
      word: String(word.word || '').trim(),
      start: Number(word.start),
      end: Number(word.end),
    }))
    .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeTranscript(value) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
  if (!candidate) throw new Error('source transcription response is not an object');
  const parsed = SourceTranscriptSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('source transcription contract invalid');
  const words = Array.isArray(parsed.data.words) && parsed.data.words.length > 0
    ? parsed.data.words
    : flattenWords(parsed.data.segments);
  return {
    ...parsed.data,
    words,
  };
}

function validateApiKey(apiKey) {
  if (
    typeof apiKey !== 'string'
    || apiKey.length < 10
    || apiKey.length > 500
    || /\s/.test(apiKey)
  ) {
    throw new Error('OpenAI API key is unavailable');
  }
}

function normalizeOpenAIResponse(payload) {
  const rawSegments = Array.isArray(payload?.segments) ? payload.segments : [];
  const rawWords = Array.isArray(payload?.words) ? payload.words : [];
  const words = rawWords
    .map((word) => ({
      word: typeof word?.word === 'string' ? word.word.trim() : '',
      start: Number(word?.start),
      end: Number(word?.end),
    }))
    .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const segments = rawSegments
    .map((segment, index) => {
      const segmentWords = Array.isArray(segment?.words)
        ? segment.words
          .map((word) => ({
            word: typeof word?.word === 'string' ? word.word.trim() : '',
            start: Number(word?.start),
            end: Number(word?.end),
          }))
          .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
        : undefined;
      return {
        id: `segment_${String(index + 1).padStart(3, '0')}`,
        start: Number(segment?.start),
        end: Number(segment?.end),
        text: typeof segment?.text === 'string' ? segment.text.trim() : '',
        ...(segmentWords?.length ? { words: segmentWords } : {}),
      };
    })
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
  const normalizedWords = words.length > 0
    ? words
    : segments.flatMap((segment) => segment.words || []);
  const maxEnd = Math.max(
    0,
    ...segments.map((segment) => segment.end),
    ...normalizedWords.map((word) => word.end),
  );
  const durationSeconds = Math.max(Number(payload?.duration) || 0, maxEnd);
  if (segments.length === 0 && normalizedWords.length > 0) {
    segments.push({
      id: 'segment_001',
      start: normalizedWords[0].start,
      end: normalizedWords.at(-1).end,
      text: normalizedWords.map((word) => word.word).join(' '),
    });
  }
  return normalizeTranscript({
    version: 1,
    language: 'en',
    durationSeconds,
    segments,
    words: normalizedWords,
  });
}

export async function transcribeSource({
  sourcePath,
  workDir,
  suppliedTranscript,
  provider,
}) {
  await mkdir(workDir, { recursive: true });
  let providerResult;
  try {
    if (typeof suppliedTranscript === 'string') {
      providerResult = JSON.parse(await readFile(suppliedTranscript, 'utf8'));
    } else if (suppliedTranscript) {
      providerResult = suppliedTranscript;
    } else if (typeof provider === 'function') {
      providerResult = await provider({ sourcePath, workDir });
    } else {
      const discoveredPath = path.join(path.dirname(sourcePath), 'transcript.en.json');
      try {
        providerResult = JSON.parse(await readFile(discoveredPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('source transcription provider required');
        throw error;
      }
    }
  } catch (error) {
    if (error?.message === 'source transcription provider required') throw error;
    throw new Error('source transcription failed');
  }
  let transcript;
  try {
    transcript = normalizeTranscript(providerResult);
  } catch (error) {
    if (error?.message === 'source transcription failed') throw error;
    throw new Error('source transcription failed');
  }
  await writeJsonAtomic(path.join(workDir, 'source-transcript.en.json'), transcript);
  return transcript;
}

export async function transcribeSourceWithOpenAI({
  sourcePath,
  workDir,
  apiKey,
  ffmpegPath = 'ffmpeg',
  fetchImpl = fetch,
}) {
  validateApiKey(apiKey);
  await mkdir(workDir, { recursive: true });
  const audioPath = path.join(workDir, 'source-transcription-input.mp3');
  await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '32k',
    audioPath,
  ], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const audioMetadata = await stat(audioPath);
  if (!audioMetadata.isFile() || audioMetadata.size <= 0 || audioMetadata.size > MAX_AUDIO_BYTES) {
    throw new Error('source transcription audio exceeds request limit');
  }

  const form = new FormData();
  form.set(
    'file',
    new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }),
    'source.mp3',
  );
  form.set('model', 'whisper-1');
  form.set('language', 'en');
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
    throw new Error(`source transcription request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new Error(`source transcription request failed: ${Number(response?.status) || 500}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('source transcription response exceeds 5 MiB');
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('source transcription response is not valid JSON');
  }
  const transcript = normalizeOpenAIResponse(payload);
  await writeJsonAtomic(path.join(workDir, 'source-transcript.en.json'), transcript);
  return transcript;
}

export { normalizeTranscript };
