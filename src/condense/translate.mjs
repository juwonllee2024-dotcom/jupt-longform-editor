function validWord(word) {
  return typeof word?.word === 'string'
    && word.word.trim().length > 0
    && Number.isFinite(Number(word.start))
    && Number.isFinite(Number(word.end))
    && Number(word.end) > Number(word.start);
}

function normalizeWords(words) {
  const normalized = (Array.isArray(words) ? words : [])
    .filter(validWord)
    .map((word) => ({
      word: word.word.trim(),
      start: Number(word.start),
      end: Number(word.end),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const [index, word] of normalized.entries()) {
    if (index > 0 && word.start < normalized[index - 1].start) {
      throw new Error('Korean word timestamps are not ordered');
    }
  }
  return normalized;
}

function wordsInsideSegments(words, segments) {
  const ranges = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: Number(segment?.sourceStartSec),
      end: Number(segment?.sourceEndSec),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
  if (ranges.length === 0) return [];
  return words.filter((word) => ranges.some((range) => word.end > range.start && word.start < range.end));
}

function segmentsInsideRanges(sourceSegments, selectedSegments) {
  const ranges = (Array.isArray(selectedSegments) ? selectedSegments : [])
    .map((segment) => ({
      start: Number(segment?.sourceStartSec),
      end: Number(segment?.sourceEndSec),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
  return (Array.isArray(sourceSegments) ? sourceSegments : [])
    .filter((segment) => (
      Number.isFinite(Number(segment?.start))
      && Number.isFinite(Number(segment?.end))
      && Number(segment.end) > Number(segment.start)
      && ranges.some((range) => Number(segment.end) > range.start && Number(segment.start) < range.end)
    ));
}

export async function translateSelected({
  sourceWords,
  sourceSegments,
  selectedSegments,
  suppliedKoreanWords,
  provider,
} = {}) {
  const selectedWords = wordsInsideSegments(normalizeWords(sourceWords), selectedSegments);
  const selectedSourceSegments = segmentsInsideRanges(sourceSegments, selectedSegments);
  if (Array.isArray(suppliedKoreanWords)) {
    return {
      status: 'ready',
      koreanWords: normalizeWords(suppliedKoreanWords),
    };
  }
  if (typeof provider !== 'function') {
    return {
      status: 'review-required',
      koreanWords: [],
      warning: 'KOREAN_SUBTITLES_REVIEW_REQUIRED',
    };
  }
  try {
    const result = await provider({
      words: selectedWords,
      segments: selectedSourceSegments,
      selectedSegments,
    });
    const koreanWords = normalizeWords(Array.isArray(result) ? result : result?.words);
    if (selectedWords.length > 0 && koreanWords.length === 0) {
      return {
        status: 'review-required',
        koreanWords: [],
        warning: 'KOREAN_SUBTITLES_PROVIDER_EMPTY',
      };
    }
    return { status: 'ready', koreanWords };
  } catch {
    return {
      status: 'review-required',
      koreanWords: [],
      warning: 'KOREAN_SUBTITLES_PROVIDER_FAILED',
    };
  }
}

function subtitleGroups(words) {
  const groups = [];
  let current = [];
  let cells = 0;
  for (const word of normalizeWords(words)) {
    const previous = current.at(-1);
    const gap = previous ? word.start - previous.end : 0;
    const wordCells = [...word.word].length;
    const projected = cells + (current.length ? 1 : 0) + wordCells;
    if (current.length && (gap > 0.35 || projected > 32)) {
      groups.push(current);
      current = [];
      cells = 0;
    }
    current.push(word);
    cells += (current.length > 1 ? 1 : 0) + wordCells;
    if (/[.!?。！？]$/.test(word.word)) {
      groups.push(current);
      current = [];
      cells = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function wordsToSrt(words, fps = 30) {
  const frameRate = Number(fps);
  if (!Number.isInteger(frameRate) || frameRate <= 0) throw new Error('fps must be a positive integer');
  const list = normalizeWords(words);
  const timestamp = (seconds) => {
    const millis = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(millis / 3_600_000);
    const minutes = Math.floor((millis % 3_600_000) / 60_000);
    const remainder = millis % 60_000;
    const secondsPart = Math.floor(remainder / 1000);
    const millisPart = remainder % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')},${String(millisPart).padStart(3, '0')}`;
  };
  return subtitleGroups(list).map((group, index) => (
    `${index + 1}\n${timestamp(group[0].start)} --> ${timestamp(group.at(-1).end)}\n${group.map((word) => word.word).join(' ')}\n`
  )).join('\n');
}

export function remapWordTimestamps(words, segments, fps = 30) {
  const frameRate = Number(fps);
  if (!Number.isInteger(frameRate) || frameRate <= 0) throw new Error('fps must be a positive integer');
  const ranges = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      sourceStartSec: Number(segment?.sourceStartSec),
      sourceEndSec: Number(segment?.sourceEndSec),
      outputStartFrame: Number(segment?.outputStartFrame),
    }))
    .filter((segment) => (
      Number.isFinite(segment.sourceStartSec)
      && Number.isFinite(segment.sourceEndSec)
      && segment.sourceEndSec > segment.sourceStartSec
      && Number.isInteger(segment.outputStartFrame)
      && segment.outputStartFrame >= 0
    ));
  const mapped = [];
  for (const word of normalizeWords(words)) {
    const segment = ranges.find((candidate) => (
      word.end > candidate.sourceStartSec
      && word.start < candidate.sourceEndSec
    ));
    if (!segment) continue;
    const outputStartSec = segment.outputStartFrame / frameRate;
    mapped.push({
      word: word.word,
      start: outputStartSec + Math.max(word.start, segment.sourceStartSec) - segment.sourceStartSec,
      end: outputStartSec + Math.min(word.end, segment.sourceEndSec) - segment.sourceStartSec,
    });
  }
  return mapped.filter((word) => word.end > word.start);
}
