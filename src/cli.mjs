#!/usr/bin/env node
import { createRunnerForMode } from './runner-factory.mjs';
import { transcribeSourceWithOpenAI } from './condense/source-transcript.mjs';
import { createOllamaTranslator } from './condense/translation-provider.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`) || option(name) === 'true';
}

async function standaloneNim(messages) {
  const apiKey = process.env.NVIDIA_API_KEY;
  const model = process.env.NVIDIA_NIM_MODEL;
  if (!apiKey || !model) throw new Error('NVIDIA NIM credentials unavailable');
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 4_000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`NIM planner failed: ${response.status}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || '';
}

const command = process.argv[2];
const jobDir = option('job-dir');
const mode = option('mode') || 'facecam';
if (!['run', 'status', 'revise', 'approve'].includes(command) || !jobDir) {
  throw new Error('usage: cli.mjs <run|status|revise|approve> --job-dir <path> [--mode facecam|longform-condense] [--youtube-url <url>]');
}

const runner = createRunnerForMode({
  mode,
  getOpenAIKey: async () => process.env.OPENAI_API_KEY,
  planWithNim: standaloneNim,
});
let result;
if (command === 'run') {
  const runInput = {
    jobDir,
    jobId: option('job-id'),
  };
  if (mode === 'longform-condense') {
    runInput.sourceUrl = option('youtube-url') || option('url');
    runInput.personalPermission = flag('personal-permission');
    runInput.permissionNote = option('permission-note') || '';
    runInput.ytDlpExecutable = option('yt-dlp-path');
    runInput.forceSourceDownload = flag('force-source-download');
    runInput.targetDurationSec = Number(option('target-duration') || 390);
    runInput.transcriptPath = option('transcript');
    runInput.koreanWordsPath = option('korean-words');
    if (option('transcriber') === 'openai') {
      runInput.transcriptProvider = ({ sourcePath, workDir }) => transcribeSourceWithOpenAI({
        sourcePath,
        workDir,
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    if (option('translator') === 'ollama') {
      const endpoint = option('ollama-url');
      const model = option('ollama-model');
      runInput.subtitleProvider = createOllamaTranslator({
        ...(endpoint ? { endpoint } : {}),
        ...(model ? { model } : {}),
      });
    }
  }
  result = await runner.run(runInput);
} else if (command === 'status') {
  result = await runner.status({ jobDir });
} else if (command === 'revise') {
  result = await runner.revise({
    jobDir,
    fromStage: option('from'),
    note: option('note'),
  });
} else {
  result = await runner.approve({
    jobDir,
    version: option('version'),
    outputSha256: option('output-sha256'),
  });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
