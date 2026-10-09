const MIN_OUTPUT_SECONDS = 300;
const MAX_OUTPUT_SECONDS = 480;

function text(value, fallback) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function numeric(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function matchesTopic(candidate, required) {
  const needle = text(required, '').toLowerCase();
  if (!needle) return false;
  return [candidate.topic, candidate.role, candidate.topicHint]
    .some((value) => text(value, '').toLowerCase() === needle
      || text(value, '').toLowerCase().includes(needle));
}

function structuralRatio(required) {
  const key = String(required || '').toLowerCase();
  if (key.includes('hook') || key.includes('opening')) return 0;
  if (key.includes('context') || key.includes('background')) return 0.2;
  if (key.includes('evidence') || key.includes('example')) return 0.55;
  if (key.includes('implication') || key.includes('impact')) return 0.75;
  if (key.includes('conclusion') || key.includes('close') || key.includes('ending')) return 1;
  return null;
}

function inferStructuralCandidate(candidates, required, usedGroups) {
  const ratio = structuralRatio(required);
  if (ratio === null || candidates.length === 0) return null;
  const targetIndex = Math.round((candidates.length - 1) * ratio);
  return [...candidates]
    .map((chapter, index) => ({
      chapter,
      distance: Math.abs(index - targetIndex),
    }))
    .sort((left, right) => left.distance - right.distance || compareCandidates(left.chapter, right.chapter))
    .map((entry) => entry.chapter)
    .find((chapter) => !usedGroups.has(chapter.topicGroup)) || null;
}

function normalizeChapter(chapter, index) {
  const start = numeric(chapter?.start, NaN);
  const end = numeric(chapter?.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const topic = text(chapter.topic || chapter.role || chapter.topicHint, `chapter-${index + 1}`);
  const topicGroup = text(chapter.topicGroup || topic, topic);
  const importance = Math.min(1, Math.max(0, numeric(chapter.importance, 0.5)));
  const confidence = Math.min(1, Math.max(0, numeric(chapter.confidence, 0.7)));
  const novelty = Math.min(1, Math.max(0, numeric(chapter.novelty, 0.7)));
  return {
    ...chapter,
    id: text(chapter.id, `chapter_${String(index + 1).padStart(3, '0')}`),
    start,
    end,
    durationSec: end - start,
    topic,
    topicGroup,
    summary: text(chapter.summary || chapter.text, topic),
    importance,
    confidence,
    novelty,
    score: (importance * 0.45) + (confidence * 0.3) + (novelty * 0.15),
  };
}

function compareCandidates(left, right) {
  return right.score - left.score
    || left.start - right.start
    || left.id.localeCompare(right.id);
}

function toClip(chapter, reason) {
  return {
    id: chapter.id,
    sourceStartSec: chapter.start,
    sourceEndSec: chapter.end,
    durationSec: chapter.durationSec,
    topic: chapter.topic,
    topicGroup: chapter.topicGroup,
    // Chapter text can be much longer than the plan contract allows. Keep the
    // selected time range intact and bound only the explanatory summary field.
    summary: chapter.summary.slice(0, 1_000),
    whyKept: reason,
    confidence: chapter.confidence,
    sourceRef: text(chapter.sourceRef, `source#${chapter.id}`),
  };
}

export function selectCondenseClips(chapters, options = {}) {
  const targetDurationSec = numeric(options.targetDurationSec, 390);
  if (
    !Number.isFinite(targetDurationSec)
    || targetDurationSec < MIN_OUTPUT_SECONDS
    || targetDurationSec > MAX_OUTPUT_SECONDS
  ) {
    throw new Error('targetDurationSec must be between 300 and 480 seconds');
  }
  const candidates = (Array.isArray(chapters) ? chapters : [])
    .map(normalizeChapter)
    .filter(Boolean)
    .filter((chapter) => chapter.durationSec >= 2 && chapter.durationSec <= 90);
  const requiredTopics = Array.isArray(options.requiredTopics)
    ? options.requiredTopics.map((topic) => text(topic, '')).filter(Boolean)
    : [];
  const selected = [];
  const selectedIds = new Set();
  const usedGroups = new Set();
  const inferredCoverage = new Map();
  const droppedReasons = new Map();
  let total = 0;

  const add = (chapter, reason) => {
    if (selectedIds.has(chapter.id) || usedGroups.has(chapter.topicGroup)) return false;
    if (total + chapter.durationSec > MAX_OUTPUT_SECONDS) return false;
    selected.push(toClip(chapter, reason));
    selectedIds.add(chapter.id);
    usedGroups.add(chapter.topicGroup);
    total += chapter.durationSec;
    return true;
  };

  for (const required of requiredTopics) {
    let match = candidates
      .filter((chapter) => matchesTopic(chapter, required))
      .sort(compareCandidates)
      .find((chapter) => !usedGroups.has(chapter.topicGroup));
    const inferred = !match;
    if (!match) match = inferStructuralCandidate(candidates, required, usedGroups);
    if (!match) continue;
    const added = add(match, inferred ? `inferred structural slot: ${required}` : `required topic: ${required}`);
    if (added && inferred) inferredCoverage.set(match.id, required);
  }

  for (const chapter of [...candidates].sort(compareCandidates)) {
    if (selectedIds.has(chapter.id)) continue;
    if (usedGroups.has(chapter.topicGroup)) {
      droppedReasons.set(chapter.id, 'duplicate topic group');
      continue;
    }
    if (total >= MIN_OUTPUT_SECONDS || total + chapter.durationSec <= MAX_OUTPUT_SECONDS) {
      if (!add(chapter, 'covers a distinct idea')) droppedReasons.set(chapter.id, 'duration cap');
    } else {
      droppedReasons.set(chapter.id, 'duration cap');
    }
  }

  selected.sort((left, right) => left.sourceStartSec - right.sourceStartSec || left.id.localeCompare(right.id));
  const selectedSet = new Set(selected.map((clip) => clip.id));
  const dropped = candidates
    .filter((chapter) => !selectedSet.has(chapter.id))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
    .map((chapter) => ({
      sourceStartSec: chapter.start,
      sourceEndSec: chapter.end,
      reason: droppedReasons.get(chapter.id) || 'lower score after coverage',
    }));

  const coverage = requiredTopics.map((idea) => ({
    idea,
    clipIds: selected
      .filter((clip) => matchesTopic(clip, idea) || inferredCoverage.get(clip.id) === idea)
      .map((clip) => clip.id),
  }));
  const warnings = [];
  for (const entry of coverage) {
    if (entry.clipIds.length === 0) warnings.push(`MISSING_REQUIRED_TOPIC:${entry.idea}`);
  }
  if (total < MIN_OUTPUT_SECONDS) warnings.push('SELECTED_DURATION_BELOW_MINIMUM');
  if (total > MAX_OUTPUT_SECONDS) warnings.push('SELECTED_DURATION_ABOVE_MAXIMUM');

  return {
    targetDurationSec,
    selectedDurationSec: total,
    sourceHash: text(options.sourceHash, 'unknown'),
    clips: selected,
    coverage,
    dropped,
    warnings,
  };
}
