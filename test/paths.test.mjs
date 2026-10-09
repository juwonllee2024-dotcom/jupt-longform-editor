import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInside, toJobRelative } from '../src/paths.mjs';

test('rejects traversal, absolute paths, and escaped symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-paths-'));
  await mkdir(path.join(root, 'input'));

  await assert.rejects(() => resolveInside(root, '../outside.mp4'), /unsafe job-relative path/);
  await assert.rejects(() => resolveInside(root, 'C:\\outside.mp4'), /unsafe job-relative path/);

  const outside = await mkdtemp(path.join(tmpdir(), 'video-outside-'));
  await symlink(outside, path.join(root, 'input', 'escape'), 'junction');
  await assert.rejects(
    () => resolveInside(root, 'input/escape/secret.mp4', { mustExist: false }),
    /path escapes job root/,
  );
});

test('resolves a normal existing file inside the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-paths-ok-'));
  await mkdir(path.join(root, 'input'));
  const resolved = await resolveInside(root, 'input', { mustExist: true });
  assert.equal(resolved, path.join(root, 'input'));
});

test('treats a junction alias and its physical job root as the same root', async () => {
  const physicalRoot = await mkdtemp(path.join(tmpdir(), 'video-paths-physical-'));
  await mkdir(path.join(physicalRoot, 'input'));
  const aliasParent = await mkdtemp(path.join(tmpdir(), 'video-paths-alias-'));
  const aliasRoot = path.join(aliasParent, 'job-alias');
  await symlink(physicalRoot, aliasRoot, 'junction');

  assert.equal(
    toJobRelative(aliasRoot, path.join(physicalRoot, 'input', 'source.mp4')),
    'input/source.mp4',
  );
});
