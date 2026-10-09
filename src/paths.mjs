import path from 'node:path';
import { realpathSync } from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';

function hasTraversal(value) {
  const normalized = value.replaceAll('\\', '/');
  return (
    path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || normalized.startsWith('/')
    || normalized.split('/').includes('..')
  );
}

function assertContained(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('path escapes job root');
  }
}

export async function resolveInside(root, relativePath, { mustExist = true } = {}) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || hasTraversal(relativePath)
  ) {
    throw new Error('unsafe job-relative path');
  }

  const realRoot = await realpathAsync(root);
  const candidate = path.resolve(realRoot, relativePath);
  assertContained(realRoot, candidate);

  if (mustExist) {
    const resolved = await realpathAsync(candidate);
    assertContained(realRoot, resolved);
    return resolved;
  }

  const resolvedParent = await realpathAsync(path.dirname(candidate));
  assertContained(realRoot, resolvedParent);
  const resolved = path.join(resolvedParent, path.basename(candidate));
  assertContained(realRoot, resolved);
  return resolved;
}

export function toJobRelative(jobDir, absolutePath) {
  const canonical = (value) => {
    const absolute = path.resolve(value);
    try {
      return path.normalize(realpathSync(absolute));
    } catch {
      return path.normalize(absolute);
    }
  };
  // The app can be launched through a OneDrive junction. Compare canonical
  // paths so a real path and its junction alias are treated as one job root.
  const relative = path.relative(canonical(jobDir), canonical(absolutePath));
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('path escapes job root');
  }
  return relative.replaceAll('\\', '/');
}
