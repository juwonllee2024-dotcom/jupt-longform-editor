import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { matchAssets } from './assets/matcher.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';
import { ingestJob } from './ingest.mjs';
import { createJobStore } from './job-store.mjs';
import { createEditPlan } from './planner/nim-edit-planner.mjs';
import { runQa } from './qa/checks.mjs';
import { analyzeAnchorSafety } from './render/anchor-analysis.mjs';
import { renderVideo } from './render/renderer.mjs';
import { writeReviewPackage } from './review-package.mjs';
import { transcribeFacecam } from './transcript/openai-whisper.mjs';
import { selectTakes } from './transcript/take-selector.mjs';

const PIPELINE = Object.freeze([
  ['ingest', 'validating'],
  ['transcribe', 'transcribing'],
  ['selectTakes', null],
  ['plan', 'planning'],
  ['match', 'matching'],
  ['render', 'rendering'],
  ['qa', 'checking'],
]);
const REVISION_STAGES = Object.freeze({
  validating: 'ingest',
  transcribing: 'transcript',
  planning: 'plan',
  matching: 'match',
  rendering: 'render',
});
const CACHE_STAGE = Object.freeze({
  transcribe: 'transcript',
  selectTakes: 'take-map',
});
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
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

function stateName(value) {
  return typeof value === 'string' ? value : value?.state;
}

export function createRunner(dependencies) {
  const {
    store,
  } = dependencies;
  const outputCache = new Map();

  async function transitionIfNeeded(next, detail = {}) {
    if (!next) return;
    const current = stateName(await store.status());
    if (current !== next) await store.transition(next, detail);
  }

  async function executeStage(stageName, input, previousOutput) {
    const action = dependencies[stageName];
    if (typeof action !== 'function') {
      throw new Error(`missing stage dependency: ${stageName}`);
    }
    const fingerprint = sha256({
      stage: stageName,
      input,
      previousOutput,
    });
    const cacheStage = CACHE_STAGE[stageName] || stageName;
    if (
      outputCache.has(stageName)
      && await store.stageFresh(cacheStage, fingerprint)
    ) {
      return outputCache.get(stageName);
    }
    const output = await action({
      ...input,
      previous: previousOutput,
    });
    await store.recordStage(cacheStage, fingerprint, output?.outputs || []);
    outputCache.set(stageName, output);
    return output;
  }

  async function run(input) {
    return store.withLock(async () => {
      let previousOutput = null;
      for (const [stageName, nextState] of PIPELINE) {
        await transitionIfNeeded(nextState, { stage: stageName });
        previousOutput = await executeStage(stageName, input, previousOutput);
        if (stageName === 'qa' && previousOutput?.passed !== true) {
          await transitionIfNeeded('blocked', {
            stage: 'qa',
            critical: previousOutput?.critical || ['QA_FAILED'],
          });
          throw new Error(`QA blocked: ${(previousOutput?.critical || []).join(', ')}`);
        }
      }
      await transitionIfNeeded('ready-for-review', { stage: 'qa' });
      return previousOutput;
    });
  }

  async function runFrom(state, input) {
    if (state !== 'checking') throw new Error(`unsupported resume state: ${state}`);
    return store.withLock(async () => {
      const qa = await dependencies.qa(input);
      if (qa?.passed !== true) {
        await transitionIfNeeded('blocked', {
          stage: 'qa',
          critical: qa?.critical || ['QA_FAILED'],
        });
        throw new Error(`QA blocked: ${(qa?.critical || []).join(', ')}`);
      }
      await transitionIfNeeded('ready-for-review', { stage: 'qa' });
      return qa;
    });
  }

  async function status() {
    return store.status();
  }

  async function revise({ fromStage, note }) {
    const cacheStage = REVISION_STAGES[fromStage];
    if (!cacheStage) throw new Error('invalid revision stage');
    const boundedNote = String(note || '').trim();
    if (!boundedNote || boundedNote.length > 2_000) {
      throw new Error('revision note must contain 1 to 2000 characters');
    }
    if (stateName(await store.status()) !== 'ready-for-review') {
      throw new Error('job is not ready for revision');
    }
    await store.transition('revision-requested', {
      fromStage,
      note: boundedNote,
    });
    await store.invalidateFrom(cacheStage);
    return store.status();
  }

  async function approve({ version, outputSha256 }) {
    if (!/^v\d{3}$/.test(String(version || ''))) {
      throw new Error('invalid review version');
    }
    if (!SHA256.test(String(outputSha256 || ''))) {
      throw new Error('invalid output SHA-256');
    }
    if (stateName(await store.status()) !== 'ready-for-review') {
      throw new Error('job is not ready for review');
    }
    if (
      typeof dependencies.verifyApproval !== 'function'
      || await dependencies.verifyApproval({ version, outputSha256 }) !== true
    ) {
      throw new Error('review output verification failed');
    }
    await store.transition('approved', {
      version,
      outputSha256,
    });
    return store.status();
  }

  return Object.freeze({
    run,
    runFrom,
    status,
    revise,
    approve,
  });
}

export function createRunnerWithDefaults({
  getOpenAIKey,
  planWithNim,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
} = {}) {
  const stores = new Map();

  function getStore(jobDir) {
    const key = String(jobDir || '');
    if (!key) throw new Error('job directory required');
    if (!stores.has(key)) stores.set(key, createJobStore(key));
    return stores.get(key);
  }

  async function run({ jobId, jobDir }) {
    const store = getStore(jobDir);
    await store.initialize(jobId);
    return store.withLock(async () => {
      const current = stateName(await store.status());
      if (current === 'ready-for-review' || current === 'approved') {
        return store.status();
      }
      if (current !== 'validating') {
        await store.transition('validating', { stage: 'ingest' });
      }
      try {
        const manifest = await ingestJob({
          jobId,
          jobDir,
          ffprobePath,
        });
        const workDir = path.join(jobDir, 'work');
        const inputDir = path.join(jobDir, 'input');
        const script = await readFile(path.join(inputDir, 'script.md'), 'utf8');
        const sourcesManifest = JSON.parse(
          await readFile(path.join(inputDir, 'sources.json'), 'utf8'),
        );
        await store.recordStage(
          'ingest',
          sha256({ version: 1, inputHash: manifest.inputHash }),
          ['work/ingest-manifest.json'],
        );

        await store.transition('transcribing', { stage: 'transcript' });
        const apiKey = await getOpenAIKey();
        const facecamPath = path.join(jobDir, manifest.facecam.path);
        const transcript = await transcribeFacecam({
          facecamPath,
          workDir,
          apiKey,
          ffmpegPath,
        });
        await store.recordStage(
          'transcript',
          sha256({
            version: 1,
            facecamSha256: manifest.facecam.sha256,
            model: 'whisper-1',
          }),
          ['work/transcript.json'],
        );

        const takeMap = selectTakes({ script, transcript });
        await writeJsonAtomic(path.join(workDir, 'take-map.json'), takeMap);
        await store.recordStage(
          'take-map',
          sha256({ version: 1, transcript, script }),
          ['work/take-map.json'],
        );

        await store.transition('planning', { stage: 'plan' });
        const plannerAssets = [
          {
            id: 'facecam_main',
            kind: 'face',
            description: 'Primary face-camera dialogue',
            scriptHints: [],
            sourceId: null,
          },
          ...sourcesManifest.screenClips.map((screen) => ({
            id: screen.id,
            kind: 'screen',
            description: screen.description,
            scriptHints: screen.scriptHints,
            sourceId: null,
          })),
          ...sourcesManifest.sources.map((source) => ({
            id: source.id,
            kind: 'image',
            description: source.title,
            scriptHints: [],
            sourceId: source.id,
          })),
        ];
        const planned = await createEditPlan({
          jobId,
          fps: 30,
          durationFrames: Math.max(1, Math.round(manifest.facecam.durationSeconds * 30)),
          script,
          transcript,
          takeMap,
          assets: plannerAssets,
          sources: sourcesManifest.sources,
          planWithNim,
        });
        await writeJsonAtomic(path.join(workDir, 'edit-plan.json'), planned.plan);
        await store.recordStage(
          'plan',
          sha256({ version: 1, takeMap, assets: plannerAssets }),
          ['work/edit-plan.json'],
        );

        await store.transition('matching', { stage: 'match' });
        const matched = matchAssets({
          plan: planned.plan,
          assets: plannerAssets,
          sources: sourcesManifest.sources,
        });
        await writeJsonAtomic(path.join(workDir, 'matched-plan.json'), matched.plan);
        await store.recordStage(
          'match',
          sha256({ version: 1, plan: planned.plan, sources: sourcesManifest }),
          ['work/matched-plan.json'],
        );

        const media = {
          facecam_main: {
            kind: 'video',
            absolutePath: facecamPath,
            staticPath: manifest.facecam.path.replace(/^input[\\/]/, '').replaceAll('\\', '/'),
          },
        };
        for (const asset of manifest.assets) {
          const absolutePath = path.join(jobDir, asset.path);
          media[asset.id] = {
            kind: asset.kind === 'image' ? 'image' : 'video',
            absolutePath,
            staticPath: asset.path.replace(/^input[\\/]/, '').replaceAll('\\', '/'),
          };
        }
        const anchorMeasurements = await analyzeAnchorSafety({
          segments: matched.plan.segments,
          media,
          fps: matched.plan.fps,
          ffmpegPath,
        });
        await writeJsonAtomic(
          path.join(workDir, 'anchor-measurements.json'),
          { version: 1, measurements: anchorMeasurements },
        );

        await store.transition('rendering', { stage: 'render' });
        const render = await renderVideo({
          plan: matched.plan,
          transcript,
          media,
          anchorMeasurements,
          workDir,
          publicDir: inputDir,
          ffmpegPath,
        });
        await store.recordStage(
          'render',
          sha256({ version: 1, plan: matched.plan, media: manifest }),
          ['work/render-mezzanine.mp4', 'work/review.mp4'],
        );

        await store.transition('checking', { stage: 'qa' });
        const qa = await runQa({
          videoPath: render.reviewPath,
          plan: matched.plan,
          media,
          sources: sourcesManifest.sources,
          anchorMeasurements,
          renderedSegmentIds: render.renderedSegmentIds,
          ffmpegPath,
          ffprobePath,
        });
        await writeJsonAtomic(path.join(workDir, 'qa-report.json'), qa);
        await store.recordStage(
          'qa',
          sha256({ version: 1, render: await sha256File(render.reviewPath) }),
          ['work/qa-report.json'],
        );
        if (!qa.passed) {
          await store.transition('blocked', {
            stage: 'qa',
            critical: qa.critical,
          });
          throw new Error('video editor blocked: QA failed');
        }

        const previewHash = await sha256File(render.reviewPath);
        const review = await writeReviewPackage({
          jobDir,
          version: 'v001',
          reviewPath: render.reviewPath,
          plan: matched.plan,
          qa,
          sources: sourcesManifest.sources,
          renderManifest: {
            inputSha256: manifest.inputHash,
            previewSha256: previewHash,
            renderer: 'remotion-4.0.498',
            ffmpeg: 'system',
            durationInFrames: render.composition.durationInFrames,
          },
        });
        await store.transition('ready-for-review', {
          version: 'v001',
          outputSha256: previewHash,
        });
        return {
          jobId,
          state: 'ready-for-review',
          version: 'v001',
          outputSha256: previewHash,
          previewFile: path.basename(review.previewPath),
          warnings: qa.warnings,
        };
      } catch {
        const failedState = stateName(await store.status());
        if (failedState !== 'blocked') {
          await store.transition('blocked', {
            stage: failedState,
            reason: failedState === 'validating'
              ? 'INPUT_VALIDATION_FAILED'
              : 'STAGE_FAILED',
          });
        }
        throw new Error(
          failedState === 'validating'
            ? 'video editor blocked: input validation failed'
            : 'video editor blocked: stage failed',
        );
      }
    });
  }

  async function status({ jobDir }) {
    return getStore(jobDir).status();
  }

  async function revise({ jobDir, fromStage, note }) {
    const store = getStore(jobDir);
    const runner = createRunner({ store });
    return runner.revise({ fromStage, note });
  }

  async function approve({
    jobDir,
    version,
    outputSha256,
  }) {
    const store = getStore(jobDir);
    const runner = createRunner({
      store,
      verifyApproval: async (approval) => {
        const previewPath = path.join(
          jobDir,
          'output',
          approval.version,
          'preview.mp4',
        );
        const editReportPath = path.join(
          jobDir,
          'output',
          approval.version,
          'edit-report.json',
        );
        const metadata = await stat(previewPath);
        if (!metadata.isFile() || metadata.size <= 0) return false;
        const report = JSON.parse(await readFile(editReportPath, 'utf8'));
        return report.passed === true
          && await sha256File(previewPath) === approval.outputSha256;
      },
    });
    return runner.approve({ version, outputSha256 });
  }

  return Object.freeze({
    run,
    status,
    revise,
    approve,
  });
}
