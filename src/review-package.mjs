import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.mjs';

function sourceListMarkdown(sources) {
  const lines = ['# Sources', ''];
  if (sources.length === 0) {
    lines.push('No external sources.');
  } else {
    for (const source of sources) {
      const title = String(source.title).replaceAll(/[\r\n[\]]/g, ' ').trim();
      const url = new URL(source.url);
      lines.push(`- [${title}](${url.href}) — ${source.publisher}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function writeExclusive(filePath, contents) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeReviewPackage({
  jobDir,
  version,
  reviewPath,
  plan,
  qa,
  sources,
  renderManifest,
  longformArtifacts,
}) {
  if (!/^v\d{3}$/.test(version)) throw new Error('invalid review version');
  const outputRoot = path.join(jobDir, 'output');
  const outputDir = path.join(outputRoot, version);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDir);

  const previewPath = path.join(outputDir, 'preview.mp4');
  await copyFile(reviewPath, previewPath, constants.COPYFILE_EXCL);
  await writeJsonAtomic(path.join(outputDir, 'edit-report.json'), {
    version: 1,
    jobId: plan.jobId,
    passed: qa.passed,
    critical: qa.critical,
    metrics: qa.metrics,
    segments: plan.segments,
  });
  await writeJsonAtomic(path.join(outputDir, 'warnings.json'), {
    version: 1,
    warnings: qa.warnings,
  });
  await writeJsonAtomic(
    path.join(outputDir, 'render-manifest.json'),
    { version: 1, ...renderManifest },
  );
  await writeExclusive(
    path.join(outputDir, 'source-list.md'),
    sourceListMarkdown(sources),
  );
  if (longformArtifacts && typeof longformArtifacts === 'object') {
    if (longformArtifacts.condensePlan) {
      await writeJsonAtomic(
        path.join(outputDir, 'condense-plan.json'),
        longformArtifacts.condensePlan,
      );
    }
    if (typeof longformArtifacts.chapters === 'string') {
      await writeFile(path.join(outputDir, 'chapters.md'), longformArtifacts.chapters, 'utf8');
    }
    if (typeof longformArtifacts.subtitles === 'string') {
      await writeFile(
        path.join(outputDir, 'korean-subtitles.srt'),
        longformArtifacts.subtitles,
        'utf8',
      );
    }
    if (longformArtifacts.citations) {
      await writeJsonAtomic(
        path.join(outputDir, 'source-citations.json'),
        longformArtifacts.citations,
      );
    }
  }

  return {
    outputDir,
    previewPath,
  };
}
