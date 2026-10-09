import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../atomic-json.mjs';
import { createJobStore } from '../job-store.mjs';
import { writeReviewPackage } from '../review-package.mjs';
import { runQa } from '../qa/checks.mjs';
import { renderVideo } from '../render/renderer.mjs';
import { chapterizeTranscript } from './chapterizer.mjs';
import {
  remapWordTimestamps,
  translateSelected,
  wordsToSrt,
} from './translate.mjs';
import { mapCondenseTimeline } from './timeline.mjs';
import { ingestLongformSource } from './source-ingest.mjs';
import { transcribeSource } from './source-transcript.mjs';
import { downloadYoutubeSource } from './youtube-source.mjs';
import { selectCondenseClips } from './selector.mjs';
import { validateCondensePlan } from './contracts.mjs';

const DEFAULT_REQUIRED_TOPICS = Object.freeze(['hook', 'context', 'evidence', 'conclusion']);
const REVISION_STAGES = Object.freeze({
  validating: 'ingest',
  transcribing: 'transcript',
  planning: 'plan',
  rendering: 'render',
});
const SHA256 = /^[a-f0-9]{64}$/;
const TRANSCRIPT_OVERRUN_TOLERANCE_SEC = 5;

function stateName(value) {
  return typeof value === 'string' ? value : value?.state;
}

function failureMessage(error) {
  const causeDetails = String(error?.cause?.stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  const message = [String(error?.message || error || 'unknown failure'), causeDetails]
    .filter(Boolean)
    .join(' — ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z]:\\[^ ]*/g, '[path]')
    .slice(0, 240);
  return message || 'unknown failure';
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clipWord(word, startLimit, endLimit) {
  if (!word || typeof word !== 'object') return null;
  const start = Number(word.start);
  const end = Number(word.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return word;
  const clippedStart = Math.max(startLimit, start);
  const clippedEnd = Math.min(endLimit, end);
  if (clippedEnd <= clippedStart) return null;
  return { ...word, start: clippedStart, end: clippedEnd };
}

function clipSegment(segment, sourceDuration) {
  if (!segment || typeof segment !== 'object') return null;
  const start = Number(segment.start);
  const end = Number(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return segment;
  const clippedStart = Math.max(0, start);
  const clippedEnd = Math.min(sourceDuration, end);
  if (clippedEnd <= clippedStart) return null;
  return {
    ...segment,
    start: clippedStart,
    end: clippedEnd,
    ...(Array.isArray(segment.words)
      ? {
        words: segment.words
          .map((word) => clipWord(word, clippedStart, clippedEnd))
          .filter(Boolean),
      }
      : {}),
  };
}

function normalizeTranscriptToSourceDuration(transcript, sourceDuration) {
  const ends = [
    transcript.durationSeconds,
    ...(transcript.segments || []).map((segment) => segment.end),
    ...(transcript.words || []).map((word) => word.end),
    ...(transcript.koreanWords || []).map((word) => word.end),
  ].map(Number).filter(Number.isFinite);
  const maxEnd = ends.length > 0 ? Math.max(...ends) : 0;
  const overrun = maxEnd - sourceDuration;
  if (overrun <= 0.25) {
    return { transcript, warnings: [] };
  }
  if (overrun > TRANSCRIPT_OVERRUN_TOLERANCE_SEC) {
    throw new Error('source transcript exceeds source duration');
  }
  const clippedSegments = (transcript.segments || [])
    .map((segment) => clipSegment(segment, sourceDuration))
    .filter(Boolean);
  if (clippedSegments.length === 0) {
    throw new Error('source transcript contains no usable segments');
  }
  const clipped = {
    ...transcript,
    durationSeconds: Math.min(sourceDuration, Number(transcript.durationSeconds) || sourceDuration),
    segments: clippedSegments,
    ...(Array.isArray(transcript.words)
      ? {
        words: transcript.words
          .map((word) => clipWord(word, 0, sourceDuration))
          .filter(Boolean),
      }
      : {}),
    ...(Array.isArray(transcript.koreanWords)
      ? {
        koreanWords: transcript.koreanWords
          .map((word) => clipWord(word, 0, sourceDuration))
          .filter(Boolean),
      }
      : {}),
  };
  return {
    transcript: clipped,
    warnings: ['SOURCE_TRANSCRIPT_CLIPPED_TO_SOURCE_DURATION'],
  };
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return digest.digest('hex');
}

function compositionPlan(jobId, selection, timeline) {
  return {
    version: 1,
    jobId,
    mode: 'longform-condense',
    fps: 30,
    durationFrames: timeline.durationFrames,
    segments: timeline.segments.map((segment) => ({
      ...segment,
      startFrame: segment.outputStartFrame,
      endFrame: segment.outputEndFrame,
      spokenText: segment.summary,
      layout: 'source-full',
      primaryAssetId: 'source_main',
      sourceId: null,
      captionStyle: 'normal',
      reason: segment.whyKept,
      confidence: segment.confidence,
    })),
    warnings: selection.warnings,
  };
}

function chaptersMarkdown(chapters) {
  const lines = ['# Chapters', ''];
  for (const chapter of chapters) {
    const speaker = chapter.speaker ? ` — ${chapter.speaker}` : '';
    lines.push(`- ${chapter.start.toFixed(2)}–${chapter.end.toFixed(2)}${speaker}: ${chapter.text}`);
  }
  return `${lines.join('\n')}\n`;
}

export function createLongformCondenseRunner({
  store: injectedStore,
  ingest = ingestLongformSource,
  transcribe = transcribeSource,
  transcribeSource: transcribeSourceDependency,
  download = downloadYoutubeSource,
  downloadYoutubeSource: downloadYoutubeSourceDependency,
  chapterize = chapterizeTranscript,
  select = selectCondenseClips,
  timeline = mapCondenseTimeline,
  translate = translateSelected,
  translateSource: translateDependency,
  translateProvider,
  render = renderVideo,
  qa = runQa,
  review = writeReviewPackage,
  verifyApproval,
  ffprobePath = 'ffprobe',
  ffmpegPath = 'ffmpeg',
  ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp',
} = {}) {
  const stores = new Map();
  const transcribeStage = transcribeSourceDependency || transcribe;
  const translateStage = translateDependency || translate;
  const downloadStage = downloadYoutubeSourceDependency || download;

  function getStore(jobDir) {
    if (injectedStore) return injectedStore;
    const key = String(jobDir || '');
    if (!key) throw new Error('job directory required');
    if (!stores.has(key)) stores.set(key, createJobStore(key));
    return stores.get(key);
  }

  async function transition(store, state, detail = {}) {
    const current = stateName(await store.status());
    if (current !== state) await store.transition(state, detail);
  }

  async function record(store, stage, fingerprint, outputs) {
    if (typeof store.recordStage === 'function') {
      await store.recordStage(stage, fingerprint, outputs);
    }
  }

  async function run({
    jobId,
    jobDir,
    targetDurationSec = 390,
    requiredTopics = DEFAULT_REQUIRED_TOPICS,
    suppliedTranscript,
    transcriptPath,
    transcriptProvider,
    suppliedKoreanWords,
    koreanWordsPath,
    subtitleProvider,
    sourceHash,
    sourceUrl,
    personalPermission = false,
    permissionNote = '',
    forceSourceDownload = false,
    ytDlpExecutable = ytDlpPath,
  }) {
    const store = getStore(jobDir);
    if (typeof store.initialize === 'function') await store.initialize(jobId);
    return store.withLock(async () => {
      const current = stateName(await store.status());
      if (current === 'ready-for-review' || current === 'approved') return store.status();
      let youtubeDownloadManifest;
      let resolvedTranscriptPath = transcriptPath;
      try {
        if (sourceUrl) {
          youtubeDownloadManifest = await downloadStage({
            jobId,
            jobDir,
            url: sourceUrl,
            ytDlpPath: ytDlpExecutable,
            force: forceSourceDownload,
            personalPermission,
            permissionNote,
          });
          if (!resolvedTranscriptPath && youtubeDownloadManifest?.transcriptPath) {
            resolvedTranscriptPath = path.join(jobDir, youtubeDownloadManifest.transcriptPath);
          }
        }
        await transition(store, 'validating', { stage: 'ingest' });
        const manifest = await ingest({ jobId, jobDir, ffprobePath });
        const workDir = path.join(jobDir, 'work');
        const sourcePath = path.join(jobDir, manifest.source.path);
        await record(store, 'ingest', hashValue(manifest), ['work/source-ingest-manifest.json']);

        await transition(store, 'transcribing', { stage: 'transcript' });
        const rawTranscript = await transcribeStage({
          sourcePath,
          workDir,
          suppliedTranscript: suppliedTranscript || resolvedTranscriptPath,
          provider: transcriptProvider,
        });
        const sourceDuration = Number(manifest.source.durationSeconds);
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
          throw new Error('source video duration is missing or zero');
        }
        const normalizedTranscript = normalizeTranscriptToSourceDuration(rawTranscript, sourceDuration);
        const transcript = normalizedTranscript.transcript;
        const transcriptWarnings = normalizedTranscript.warnings;
        let requestedKoreanWords = suppliedKoreanWords;
        if (requestedKoreanWords === undefined && koreanWordsPath) {
          const rawKoreanWords = JSON.parse(await readFile(koreanWordsPath, 'utf8'));
          requestedKoreanWords = Array.isArray(rawKoreanWords)
            ? rawKoreanWords
            : rawKoreanWords?.words;
        }
        await record(
          store,
          'transcript',
          hashValue({ source: manifest.source.sha256, transcript }),
          ['work/source-transcript.en.json'],
        );

        await transition(store, 'planning', { stage: 'plan' });
        const chapters = await chapterize(transcript, {
          minSeconds: 20,
          maxSeconds: 90,
          pauseSeconds: 0.8,
        });
        const selection = await select(chapters, {
          targetDurationSec,
          sourceHash: sourceHash || manifest.source.sha256,
          requiredTopics,
        });
        const compactTimeline = await timeline({ clips: selection.clips }, 30);
        const translation = await translateStage({
          sourceWords: transcript.words || [],
          sourceSegments: transcript.segments || [],
          selectedSegments: selection.clips,
          suppliedKoreanWords: requestedKoreanWords ?? transcript.koreanWords,
          provider: subtitleProvider || translateProvider,
        });
        const translationWarnings = translation.status === 'ready'
          ? []
          : [translation.warning || 'KOREAN_SUBTITLES_REVIEW_REQUIRED'];
        const koreanWords = Array.isArray(translation.koreanWords)
          ? translation.koreanWords
          : [];
        const planCheck = validateCondensePlan({
          version: 1,
          mode: 'longform-condense',
          targetDurationSec,
          sourceDurationSec: manifest.source.durationSeconds,
          clips: selection.clips,
          coverage: selection.coverage,
          dropped: selection.dropped,
          warnings: [
            ...manifest.warnings,
            ...selection.warnings,
            ...translationWarnings,
            ...transcriptWarnings,
          ],
        });
        if (!planCheck.ok) throw new Error('condense plan contract invalid');
        const compactPlan = {
          ...planCheck.value,
          jobId,
          sourceHash: manifest.source.sha256,
        };
        const compactKoreanWords = remapWordTimestamps(koreanWords, compactTimeline.segments, 30);
        const renderTranscript = { ...transcript, koreanWords };
        await writeJsonAtomic(path.join(workDir, 'condense-plan.json'), compactPlan);
        await writeFile(path.join(workDir, 'chapters.md'), chaptersMarkdown(chapters), 'utf8');
        const renderPlan = compositionPlan(jobId, selection, compactTimeline);
        renderPlan.warnings = compactPlan.warnings;
        await writeJsonAtomic(path.join(workDir, 'edit-plan.json'), renderPlan);
        await record(
          store,
          'plan',
          hashValue({ compactPlan, renderPlan }),
          ['work/condense-plan.json', 'work/chapters.md', 'work/edit-plan.json'],
        );

        const media = {
          source_main: {
            kind: 'video',
            absolutePath: sourcePath,
            staticPath: manifest.source.path.replace(/^input[\\/]/, '').replaceAll('\\', '/'),
            durationFrames: manifest.source.durationFrames,
          },
        };
        // Long-form mode uses the source video directly, but still records a
        // no-op matching stage so the shared job-state machine remains valid.
        await transition(store, 'matching', { stage: 'match', skipped: true });
        await transition(store, 'rendering', { stage: 'render' });
        const rendered = await render({
          plan: renderPlan,
          transcript: null,
          sourceTranscript: renderTranscript,
          mode: 'longform-condense',
          media,
          anchorMeasurements: {},
          workDir,
          publicDir: path.join(jobDir, 'input'),
          ffmpegPath,
        });
        await record(
          store,
          'render',
          hashValue({ renderPlan, source: manifest.source.sha256 }),
          ['work/render-mezzanine.mp4', 'work/review.mp4'],
        );

        await transition(store, 'checking', { stage: 'qa' });
        const report = await qa({
          videoPath: rendered.reviewPath,
          plan: renderPlan,
          transcript,
          media,
          sources: [],
          anchorMeasurements: {},
          renderedSegmentIds: rendered.renderedSegmentIds,
          ffmpegPath,
          ffprobePath,
          longform: true,
        });
        await writeJsonAtomic(path.join(workDir, 'qa-report.json'), report);
        await record(store, 'qa', hashValue(report), ['work/qa-report.json']);
        if (report.passed !== true) {
          await transition(store, 'blocked', { stage: 'qa', critical: report.critical || ['QA_FAILED'] });
          throw new Error('QA failed');
        }
        const reviewResult = await review({
          jobDir,
          version: 'v001',
          reviewPath: rendered.reviewPath,
          plan: renderPlan,
          qa: report,
          sources: [],
          longformArtifacts: {
            condensePlan: compactPlan,
            chapters: chaptersMarkdown(chapters),
            subtitles: wordsToSrt(compactKoreanWords, 30),
            citations: {
              version: 1,
              source: manifest.source,
              rights: manifest.rights,
              ...(sourceUrl ? {
                youtube: {
                  url: youtubeDownloadManifest?.url || sourceUrl,
                  ...(youtubeDownloadManifest?.videoId ? { videoId: youtubeDownloadManifest.videoId } : {}),
                  ...(youtubeDownloadManifest?.sha256 ? { sha256: youtubeDownloadManifest.sha256 } : {}),
                },
              } : {}),
            },
          },
          renderManifest: {
            inputSha256: manifest.inputHash,
            renderer: 'remotion-4.0.498',
            ffmpeg: ffmpegPath,
            durationInFrames: rendered.composition?.durationInFrames || compactTimeline.durationFrames,
          },
        });
        const outputSha256 = await sha256File(reviewResult.previewPath);
        await transition(store, 'ready-for-review', { version: 'v001', outputSha256 });
        return {
          jobId,
          state: 'ready-for-review',
          version: 'v001',
          outputSha256,
          previewFile: path.basename(reviewResult.previewPath),
          warnings: report.warnings || [],
        };
      } catch (error) {
        const failedState = stateName(await store.status());
        if (failedState !== 'blocked' && failedState !== 'ready-for-review') {
          const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
            ? error.code
            : null;
          await transition(store, 'blocked', {
            stage: failedState,
            reason: 'LONGFORM_STAGE_FAILED',
            message: failureMessage(error),
            ...(errorCode ? { errorCode } : {}),
          });
        }
        throw new Error('longform condense blocked');
      }
    });
  }

  async function status({ jobDir } = {}) {
    return getStore(jobDir).status();
  }

  async function revise({ jobDir, fromStage, note }) {
    const cacheStage = REVISION_STAGES[fromStage];
    if (!cacheStage) throw new Error('invalid revision stage');
    const boundedNote = String(note || '').trim();
    if (!boundedNote || boundedNote.length > 2_000) {
      throw new Error('revision note must contain 1 to 2000 characters');
    }
    const store = getStore(jobDir);
    if (stateName(await store.status()) !== 'ready-for-review') {
      throw new Error('job is not ready for revision');
    }
    if (typeof store.invalidateFrom !== 'function') {
      throw new Error('job store cannot invalidate revision stage');
    }
    await store.transition('revision-requested', { fromStage, note: boundedNote });
    await store.invalidateFrom(cacheStage);
    return store.status();
  }

  async function verifyReviewOutput({ jobDir, version, outputSha256 }) {
    if (typeof verifyApproval === 'function') {
      return verifyApproval({ jobDir, version, outputSha256 });
    }
    const previewPath = path.join(jobDir, 'output', version, 'preview.mp4');
    const reportPath = path.join(jobDir, 'output', version, 'edit-report.json');
    try {
      const metadata = await stat(previewPath);
      if (!metadata.isFile() || metadata.size <= 0) return false;
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      return report.passed === true && await sha256File(previewPath) === outputSha256;
    } catch {
      return false;
    }
  }

  async function approve({ jobDir, version, outputSha256 }) {
    if (!/^v\d{3}$/.test(String(version || ''))) {
      throw new Error('invalid review version');
    }
    if (!SHA256.test(String(outputSha256 || ''))) {
      throw new Error('invalid output SHA-256');
    }
    const store = getStore(jobDir);
    if (stateName(await store.status()) !== 'ready-for-review') {
      throw new Error('job is not ready for review');
    }
    if (await verifyReviewOutput({ jobDir, version, outputSha256 }) !== true) {
      throw new Error('review output verification failed');
    }
    await store.transition('approved', { version, outputSha256 });
    return store.status();
  }

  return Object.freeze({ run, status, revise, approve });
}
