import { randomBytes } from 'node:crypto';
import { parseYoutubeUrl } from '../condense/youtube-source.mjs';

const MIN_TARGET_DURATION_SEC = 300;
const MAX_TARGET_DURATION_SEC = 480;
const SAFE_JOB_ID = /^web_[a-z0-9_-]{3,63}$/;
const SAFE_MODEL = /^[^\u0000-\u001f\u007f]{1,80}$/;
const MAX_PERMISSION_NOTE_LENGTH = 500;

function requestError(message, code = 'WEB_REQUEST_INVALID') {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function parseCreateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError('request body must be an object');
  }
  const parsedUrl = parseYoutubeUrl(value.youtubeUrl);
  const targetDurationSec = value.targetDurationSec === undefined
    ? 390
    : Number(value.targetDurationSec);
  if (!Number.isInteger(targetDurationSec)) {
    throw requestError('targetDurationSec must be an integer');
  }
  if (targetDurationSec < MIN_TARGET_DURATION_SEC || targetDurationSec > MAX_TARGET_DURATION_SEC) {
    throw requestError(`targetDurationSec must be between ${MIN_TARGET_DURATION_SEC} and ${MAX_TARGET_DURATION_SEC}`);
  }
  const useOllama = value.useOllama === undefined ? false : value.useOllama;
  if (typeof useOllama !== 'boolean') throw requestError('useOllama must be boolean');
  const ollamaModel = value.ollamaModel === undefined ? 'qwen3:8b' : value.ollamaModel;
  if (typeof ollamaModel !== 'string' || !SAFE_MODEL.test(ollamaModel.trim())) {
    throw requestError('ollamaModel is invalid');
  }
  const personalPermission = value.personalPermission === undefined
    ? false
    : value.personalPermission;
  if (typeof personalPermission !== 'boolean') {
    throw requestError('personalPermission must be boolean');
  }
  const permissionNote = value.permissionNote === undefined ? '' : value.permissionNote;
  if (typeof permissionNote !== 'string') {
    throw requestError('permissionNote must be a string');
  }
  const normalizedPermissionNote = permissionNote.replace(/\s+/g, ' ').trim();
  if (normalizedPermissionNote.length > MAX_PERMISSION_NOTE_LENGTH) {
    throw requestError(`permissionNote must be ${MAX_PERMISSION_NOTE_LENGTH} characters or fewer`);
  }
  return {
    youtubeUrl: parsedUrl.url,
    targetDurationSec,
    useOllama,
    ollamaModel: ollamaModel.trim(),
    personalPermission,
    permissionNote: normalizedPermissionNote,
  };
}

export function createWebJobId(now = new Date(), randomPart = randomBytes(4).toString('hex')) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw requestError('job timestamp is invalid');
  const stamp = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('') + '_' + [
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
  ].join('');
  const suffix = String(randomPart || randomBytes(4).toString('hex'))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 24)
    .padEnd(3, '0');
  return `web_${stamp}_${suffix}`;
}

export function isSafeWebJobId(value) {
  return typeof value === 'string' && SAFE_JOB_ID.test(value);
}

export {
  MAX_TARGET_DURATION_SEC,
  MIN_TARGET_DURATION_SEC,
};
