import { EditPlanSchema, parseContract } from '../contracts.mjs';

const MATCH_THRESHOLD = 0.60;
const KIND_PRIORITY = Object.freeze({
  screen: 3,
  image: 2,
  'title-card': 1,
});

function tokens(value) {
  return String(value || '')
    .normalize('NFC')
    .toLocaleLowerCase('ko-KR')
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean);
}

function tokenSet(value) {
  return new Set(tokens(value));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = intersectionSize(left, right);
  return intersection / (left.size + right.size - intersection);
}

function hintCoverage(spokenTokens, hint) {
  const hintTokens = tokenSet(hint);
  if (hintTokens.size === 0) return 0;
  return intersectionSize(spokenTokens, hintTokens) / hintTokens.size;
}

function normalizedPhrase(value) {
  return tokens(value).join(' ');
}

function scoreAsset(segment, asset) {
  const spokenTokens = tokenSet(segment.spokenText);
  const descriptionJaccard = jaccard(
    spokenTokens,
    tokenSet(asset.description),
  );
  const hints = Array.isArray(asset.scriptHints) ? asset.scriptHints : [];
  const bestHintCoverage = hints.reduce(
    (best, hint) => Math.max(best, hintCoverage(spokenTokens, hint)),
    0,
  );
  const spokenPhrase = normalizedPhrase(segment.spokenText);
  const exactHintBonus = asset.kind === 'screen' && hints.some((hint) => {
    const phrase = normalizedPhrase(hint);
    return phrase.length > 0 && spokenPhrase.includes(phrase);
  }) ? 0.10 : 0;
  return Math.min(
    1,
    0.45 * descriptionJaccard
      + 0.40 * bestHintCoverage
      + 0.15 * segment.confidence
      + exactHintBonus,
  );
}

function faceRequired(segment) {
  const reason = String(segment.reason || '').toLocaleLowerCase('en-US');
  return (
    segment.captionStyle === 'hook'
    || /personal judgment|correction|conclusion|major claim/.test(reason)
  );
}

function sourceSafe(asset, sourceIds) {
  if (asset.kind === 'screen') return asset.sourceId == null;
  if (asset.kind === 'image') {
    return typeof asset.sourceId === 'string' && sourceIds.has(asset.sourceId);
  }
  return asset.kind === 'title-card' && (
    asset.sourceId == null || sourceIds.has(asset.sourceId)
  );
}

function layoutFor(asset) {
  if (asset.kind === 'screen') return 'screen-full-face-circle';
  if (asset.kind === 'image') return 'visual-full-face-circle';
  return 'title-card';
}

export function matchAssets({
  plan,
  assets,
  sources,
}) {
  const parsedInput = parseContract(EditPlanSchema, plan);
  if (!parsedInput.ok) throw new Error(`edit plan invalid: ${parsedInput.errors.join('; ')}`);
  const sourceIds = new Set(
    (Array.isArray(sources) ? sources : [])
      .map((source) => source?.id)
      .filter((id) => typeof id === 'string'),
  );
  const candidates = (Array.isArray(assets) ? assets : [])
    .filter((asset) => (
      asset
      && typeof asset.id === 'string'
      && Object.hasOwn(KIND_PRIORITY, asset.kind)
      && sourceSafe(asset, sourceIds)
    ));
  const warnings = [...parsedInput.value.warnings];

  const segments = parsedInput.value.segments.map((segment) => {
    if (faceRequired(segment)) return { ...segment };
    const ranked = candidates
      .map((asset, index) => ({
        asset,
        index,
        score: scoreAsset(segment, asset),
      }))
      .filter((candidate) => candidate.score >= MATCH_THRESHOLD)
      .sort((left, right) => (
        KIND_PRIORITY[right.asset.kind] - KIND_PRIORITY[left.asset.kind]
        || right.score - left.score
        || left.index - right.index
      ));

    if (ranked.length === 0) {
      warnings.push(`LOW_CONFIDENCE_VISUAL:${segment.id}`);
      return {
        ...segment,
        layout: 'face-full',
        primaryAssetId: 'facecam_main',
        sourceId: null,
      };
    }

    const selected = ranked[0];
    return {
      ...segment,
      layout: layoutFor(selected.asset),
      primaryAssetId: selected.asset.id,
      sourceId: selected.asset.sourceId || null,
      confidence: Math.min(segment.confidence, selected.score),
      reason: `${segment.reason}; matched approved ${selected.asset.kind} asset`,
    };
  });

  const candidatePlan = {
    ...parsedInput.value,
    segments,
    warnings: [...new Set(warnings)].slice(0, 100),
  };
  const parsedOutput = parseContract(EditPlanSchema, candidatePlan);
  if (!parsedOutput.ok) throw new Error(`matched edit plan invalid: ${parsedOutput.errors.join('; ')}`);
  return {
    plan: parsedOutput.value,
    warnings: [...parsedOutput.value.warnings],
  };
}
