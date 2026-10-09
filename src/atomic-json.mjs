import { randomBytes } from 'node:crypto';
import {
  open,
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { parseContract } from './contracts.mjs';

const MAX_JSON_BYTES = 5 * 1024 * 1024;

export async function writeJsonAtomic(filePath, value) {
  const suffix = randomBytes(8).toString('hex');
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${suffix}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const { rename } = await import('node:fs/promises');
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    const { unlink } = await import('node:fs/promises');
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function readJson(filePath, schema) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) {
    throw new Error('JSON file is missing or exceeds 5 MiB');
  }
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('JSON file is not valid UTF-8 JSON');
  }
  const result = parseContract(schema, value);
  if (!result.ok) throw new Error(`JSON contract invalid: ${result.errors.join('; ')}`);
  return result.value;
}
