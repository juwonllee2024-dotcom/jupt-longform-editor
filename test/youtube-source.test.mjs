import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadYoutubeSource,
  parseYoutubeUrl,
  parseYoutubeJson3Transcript,
} from '../src/condense/youtube-source.mjs';

test('normalizes supported YouTube video URLs and strips tracking parameters', () => {
  assert.deepEqual(
    parseYoutubeUrl('https://www.youtube.com/watch?v=abc123_XY&si=tracking'),
    {
      id: 'abc123_XY',
      url: 'https://www.youtube.com/watch?v=abc123_XY',
    },
  );
  assert.deepEqual(
    parseYoutubeUrl('https://youtu.be/abc123_XY?t=22'),
    {
      id: 'abc123_XY',
      url: 'https://www.youtube.com/watch?v=abc123_XY',
    },
  );
});

test('rejects non-YouTube URLs and playlist-only URLs before invoking yt-dlp', () => {
  assert.throws(
    () => parseYoutubeUrl('https://example.com/watch?v=abc123_XY'),
    /YouTube URL is not supported/,
  );
  assert.throws(
    () => parseYoutubeUrl('https://www.youtube.com/playlist?list=PL123456'),
    /YouTube video URL is required/,
  );
});

test('converts yt-dlp JSON3 captions into the English transcript contract', () => {
  const transcript = parseYoutubeJson3Transcript({
    events: [
      { tStartMs: 0, dDurationMs: 1_200, segs: [{ utf8: 'First thought. ' }] },
      { tStartMs: 1_500, dDurationMs: 1_000, segs: [{ utf8: 'Second thought.' }] },
    ],
  });
  assert.equal(transcript.language, 'en');
  assert.equal(transcript.durationSeconds, 2.5);
  assert.deepEqual(transcript.segments, [
    { id: 'segment_001', start: 0, end: 1.2, text: 'First thought.' },
    { id: 'segment_002', start: 1.5, end: 2.5, text: 'Second thought.' },
  ]);
});

test('normalizes overlapping YouTube caption windows before downstream validation', () => {
  const transcript = parseYoutubeJson3Transcript({
    events: [
      { tStartMs: 0, dDurationMs: 4_000, segs: [{ utf8: 'First line.' }] },
      { tStartMs: 0, dDurationMs: 2_000, segs: [{ utf8: 'First continuation.' }] },
      { tStartMs: 1_600, dDurationMs: 5_000, segs: [{ utf8: 'Second line.' }] },
      { tStartMs: 4_000, dDurationMs: 2_000, segs: [{ utf8: 'Third line.' }] },
    ],
  });
  assert.deepEqual(transcript.segments, [
    { id: 'segment_001', start: 0, end: 1.6, text: 'First line. First continuation.' },
    { id: 'segment_002', start: 1.6, end: 4, text: 'Second line.' },
    { id: 'segment_003', start: 4, end: 6, text: 'Third line.' },
  ]);
});

test('downloads one YouTube URL into input/source/main.mp4 and records provenance', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-youtube-source-'));
  const commands = [];
  const execFileAsync = async (file, args) => {
    commands.push({ file, args });
    const outputTemplate = args[args.indexOf('--output') + 1];
    const outputPath = outputTemplate.replace('%(ext)s', args.includes('--skip-download') ? 'en.json3' : 'mp4');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      args.includes('--skip-download')
        ? JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: 'Hello.' }] }] })
        : Buffer.from('downloaded-mp4'),
    );
    return { stdout: `${outputPath}\n`, stderr: '' };
  };

  const result = await downloadYoutubeSource({
    jobDir,
    url: 'https://www.youtube.com/watch?v=abc123_XY&si=tracking',
    ytDlpPath: 'yt-dlp-test',
    execFileAsync,
  });

  assert.equal(commands[0].file, 'yt-dlp-test');
  assert.ok(commands[0].args.includes('--no-playlist'));
  assert.ok(commands[0].args.includes('--ignore-config'));
  assert.ok(commands[0].args.includes('--remux-video'));
  assert.equal(commands[0].args[commands[0].args.indexOf('--js-runtimes') + 1], 'node');
  assert.equal(commands[0].args[commands[0].args.indexOf('--extractor-args') + 1], 'youtube:player_client=android');
  assert.equal(commands[0].args[commands[0].args.indexOf('--format') + 1], 'bv*[height<=1080]+ba/b[height<=1080]');
  assert.equal(commands[0].args.at(-1), 'https://www.youtube.com/watch?v=abc123_XY');
  assert.ok(commands[1].args.includes('--skip-download'));
  assert.equal(result.cached, false);
  assert.equal(result.videoId, 'abc123_XY');
  assert.equal(result.transcriptPath, 'input/source/transcript.en.json');
  assert.equal(await readFile(path.join(jobDir, 'input', 'source', 'main.mp4'), 'utf8'), 'downloaded-mp4');
  const transcript = JSON.parse(await readFile(path.join(jobDir, 'input', 'source', 'transcript.en.json'), 'utf8'));
  assert.equal(transcript.segments[0].text, 'Hello.');
  const manifest = JSON.parse(await readFile(path.join(jobDir, 'work', 'youtube-download-manifest.json'), 'utf8'));
  assert.equal(manifest.url, 'https://www.youtube.com/watch?v=abc123_XY');
  assert.equal(manifest.outputPath, 'input/source/main.mp4');
  assert.equal(manifest.transcriptPath, 'input/source/transcript.en.json');
  assert.equal(manifest.rights.status, 'unknown');
  assert.equal((await stat(path.join(jobDir, 'input', 'sources.json'))).isFile(), true);
});

test('records a user-asserted personal email permission in local provenance', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-youtube-permission-'));
  const execFileAsync = async (file, args) => {
    const outputTemplate = args[args.indexOf('--output') + 1];
    const outputPath = outputTemplate.replace('%(ext)s', args.includes('--skip-download') ? 'en.json3' : 'mp4');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      args.includes('--skip-download')
        ? JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: 'Hello.' }] }] })
        : Buffer.from('permissioned-mp4'),
    );
    return { stdout: `${outputPath}\n`, stderr: '' };
  };

  const result = await downloadYoutubeSource({
    jobDir,
    url: 'https://www.youtube.com/watch?v=abc123_XY',
    ytDlpPath: 'yt-dlp-test',
    execFileAsync,
    personalPermission: true,
    permissionNote: 'creator email permission confirmed',
  });

  assert.equal(result.rights.status, 'licensed');
  assert.equal(result.rights.note, 'creator email permission confirmed');
  assert.deepEqual(result.rights.permission, {
    type: 'personal-email',
    assertedByUser: true,
    evidence: 'local-email-not-uploaded',
  });
  const sources = JSON.parse(await readFile(path.join(jobDir, 'input', 'sources.json'), 'utf8'));
  assert.equal(sources.rights.permission.type, 'personal-email');
  assert.equal(sources.rights.permission.assertedByUser, true);
});

test('reuses a completed same-URL download without invoking yt-dlp again', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-youtube-cache-'));
  let calls = 0;
  const execFileAsync = async () => {
    calls += 1;
    throw new Error('should not be called for cached source');
  };
  const first = await downloadYoutubeSource({
    jobDir,
    url: 'https://youtu.be/abc123_XY',
    execFileAsync: async (file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      const outputPath = outputTemplate.replace('%(ext)s', 'mp4');
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from('cached-mp4'));
      return { stdout: `${outputPath}\n`, stderr: '' };
    },
  });
  const second = await downloadYoutubeSource({
    jobDir,
    url: 'https://www.youtube.com/watch?v=abc123_XY',
    execFileAsync,
  });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 0);
});

test('falls back to a progressive MP4 when adaptive YouTube media is forbidden', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-youtube-fallback-'));
  const formats = [];
  const execFileAsync = async (file, args) => {
    if (args.includes('--skip-download')) {
      const outputTemplate = args[args.indexOf('--output') + 1];
      const outputPath = outputTemplate.replace('%(ext)s', 'en.json3');
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: 'Hello.' }] }] }));
      return { stdout: '', stderr: '' };
    }
    const format = args[args.indexOf('--format') + 1];
    formats.push(format);
    if (format !== '18') {
      throw Object.assign(new Error('download failed'), { stderr: 'ERROR: HTTP Error 403: Forbidden' });
    }
    const outputTemplate = args[args.indexOf('--output') + 1];
    const outputPath = outputTemplate.replace('%(ext)s', 'mp4');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from('progressive-mp4'));
    return { stdout: `${outputPath}\n`, stderr: '' };
  };

  const result = await downloadYoutubeSource({
    jobDir,
    url: 'https://www.youtube.com/watch?v=abc123_XY',
    ytDlpPath: 'yt-dlp-test',
    execFileAsync,
  });
  assert.deepEqual(formats, ['bv*[height<=1080]+ba/b[height<=1080]', '18']);
  assert.equal(result.videoId, 'abc123_XY');
  assert.equal(await readFile(path.join(jobDir, 'input', 'source', 'main.mp4'), 'utf8'), 'progressive-mp4');
});

test('returns actionable error when yt-dlp executable is missing', async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'juwon-youtube-missing-'));
  const missing = Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
  await assert.rejects(
    () => downloadYoutubeSource({
      jobDir,
      url: 'https://www.youtube.com/watch?v=abc123_XY',
      execFileAsync: async () => { throw missing; },
    }),
    (error) => error.code === 'YTDLP_NOT_FOUND' && /yt-dlp/.test(error.message),
  );
});
