import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function createVideo(outputPath, color, frequency) {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=640x360:d=2`,
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:duration=2`,
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    outputPath,
  ], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function createFixtureJob(options = {}) {
  const jobDir = options.jobDir
    ? path.resolve(options.jobDir)
    : await mkdtemp(path.join(tmpdir(), 'juwon-video-job-'));
  const inputDir = path.join(jobDir, 'input');
  const facecamDir = path.join(inputDir, 'facecam');
  const screenDir = path.join(inputDir, 'screen');
  const workDir = path.join(jobDir, 'work');
  const outputDir = path.join(jobDir, 'output');
  await Promise.all([
    mkdir(facecamDir, { recursive: true }),
    mkdir(screenDir, { recursive: true }),
    mkdir(path.join(inputDir, 'assets'), { recursive: true }),
    mkdir(path.join(inputDir, 'music'), { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);

  const facecamPath = path.join(facecamDir, 'main.mp4');
  const screenPath = path.join(screenDir, 'demo.mp4');
  await createVideo(facecamPath, 'blue', 440);
  await createVideo(screenPath, 'green', 660);

  await writeFile(
    path.join(inputDir, 'script.md'),
    '# 오프닝\n오늘 꼭 알아야 할 AI 소식입니다.\n',
    'utf8',
  );
  await writeFile(
    path.join(inputDir, 'sources.json'),
    `${JSON.stringify({
      version: 1,
      sources: [],
      screenClips: [{
        id: 'screen_demo',
        path: 'screen/demo.mp4',
        description: 'AI 제품을 직접 사용하는 화면',
        scriptHints: ['직접 사용'],
      }],
    }, null, 2)}\n`,
    'utf8',
  );

  return {
    jobDir,
    inputDir,
    workDir,
    outputDir,
    facecamPath,
    screenPath,
    facecamHash: () => sha256(facecamPath),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jobDirIndex = process.argv.indexOf('--job-dir');
  const requestedJobDir = jobDirIndex >= 0
    ? process.argv[jobDirIndex + 1]
    : path.join('test', 'tmp', 'fixture-job');
  const fixture = await createFixtureJob({ jobDir: requestedJobDir });
  process.stdout.write(`${fixture.jobDir}\n`);
}
