import {
  TakeMapSchema,
  TranscriptSchema,
  parseContract,
} from '../contracts.mjs';

const PRE_ROLL_SECONDS = 0.08;
const POST_ROLL_SECONDS = 0.12;
const LONG_SILENCE_SECONDS = 1.2;

function normalizeToken(value) {
  return String(value)
    .normalize('NFC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function scriptTokens(script) {
  return String(script)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function transcriptTokens(transcript) {
  return transcript.words
    .map((word, originalIndex) => ({
      value: normalizeToken(word.word),
      originalIndex,
    }))
    .filter((token) => token.value);
}

function align(script, spoken) {
  const rowCount = script.length + 1;
  const columnCount = spoken.length + 1;
  const score = Array.from(
    { length: rowCount },
    () => Array(columnCount).fill(Number.NEGATIVE_INFINITY),
  );
  const previous = Array.from(
    { length: rowCount },
    () => Array(columnCount).fill(null),
  );

  for (let column = 0; column < columnCount; column += 1) score[0][column] = 0;
  for (let row = 1; row < rowCount; row += 1) {
    score[row][0] = -row;
    previous[row][0] = 'up';
  }

  for (let row = 1; row < rowCount; row += 1) {
    for (let column = 1; column < columnCount; column += 1) {
      const exact = script[row - 1] === spoken[column - 1].value;
      const candidates = [
        {
          value: score[row - 1][column - 1] + (exact ? 2 : -1),
          operation: 'diagonal',
          priority: exact ? 3 : 1,
        },
        {
          value: score[row - 1][column] - 1,
          operation: 'up',
          priority: 0,
        },
        {
          value: score[row][column - 1] - 0.8,
          operation: 'left',
          priority: 2,
        },
      ].sort((a, b) => b.value - a.value || b.priority - a.priority);
      score[row][column] = candidates[0].value;
      previous[row][column] = candidates[0].operation;
    }
  }

  let column = 0;
  for (let candidate = 1; candidate < columnCount; candidate += 1) {
    if (score[script.length][candidate] >= score[script.length][column]) {
      column = candidate;
    }
  }

  const endColumn = column;
  let row = script.length;
  let matches = 0;
  let firstColumn = endColumn;
  while (row > 0) {
    const operation = previous[row][column];
    if (operation === 'diagonal') {
      if (script[row - 1] === spoken[column - 1].value) matches += 1;
      row -= 1;
      column -= 1;
      firstColumn = Math.min(firstColumn, column);
    } else if (operation === 'left') {
      column -= 1;
      firstColumn = Math.min(firstColumn, column);
    } else if (operation === 'up') {
      row -= 1;
    } else {
      break;
    }
  }

  return {
    coverage: matches / script.length,
    startIndex: spoken[firstColumn]?.originalIndex,
    endIndex: spoken[endColumn - 1]?.originalIndex,
  };
}

function joinedText(words, startIndex, endIndex) {
  return words
    .slice(startIndex, endIndex + 1)
    .map((word) => word.word)
    .join(' ');
}

function rejectedRange(words, startIndex, endIndex, reason) {
  if (startIndex > endIndex) return null;
  return {
    start: words[startIndex].start,
    end: words[endIndex].end,
    text: joinedText(words, startIndex, endIndex),
    accepted: false,
    reason,
  };
}

function acceptedRanges(words, startIndex, endIndex) {
  const ranges = [];
  let rangeStart = startIndex;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const gap = words[index].start - words[index - 1].end;
    if (gap < LONG_SILENCE_SECONDS) continue;
    ranges.push({
      start: Math.max(0, words[rangeStart].start - PRE_ROLL_SECONDS),
      end: words[index - 1].end + POST_ROLL_SECONDS,
      text: joinedText(words, rangeStart, index - 1),
      accepted: true,
      reason: 'complete',
    });
    ranges.push({
      start: words[index - 1].end + POST_ROLL_SECONDS,
      end: Math.max(
        words[index - 1].end + POST_ROLL_SECONDS + 0.001,
        words[index].start - PRE_ROLL_SECONDS,
      ),
      text: '',
      accepted: false,
      reason: 'silence',
    });
    rangeStart = index;
  }
  ranges.push({
    start: Math.max(0, words[rangeStart].start - PRE_ROLL_SECONDS),
    end: words[endIndex].end + POST_ROLL_SECONDS,
    text: joinedText(words, rangeStart, endIndex),
    accepted: true,
    reason: 'complete',
  });
  return ranges;
}

function containsScriptToken(words, startIndex, endIndex, expectedTokens) {
  const expected = new Set(expectedTokens);
  return words
    .slice(startIndex, endIndex + 1)
    .some((word) => expected.has(normalizeToken(word.word)));
}

export function selectTakes({ script, transcript }) {
  const transcriptResult = parseContract(TranscriptSchema, transcript);
  if (!transcriptResult.ok) {
    throw new Error(`transcript contract invalid: ${transcriptResult.errors.join('; ')}`);
  }
  const expected = scriptTokens(script);
  if (expected.length === 0) throw new Error('script has no spoken tokens');
  const spoken = transcriptTokens(transcriptResult.value);
  if (spoken.length === 0) throw new Error('transcript has no spoken tokens');

  const result = align(expected, spoken);
  if (
    result.coverage < 0.70
    || !Number.isInteger(result.startIndex)
    || !Number.isInteger(result.endIndex)
  ) {
    throw new Error(`script/transcript alignment below 0.70: ${result.coverage.toFixed(2)}`);
  }

  const words = transcriptResult.value.words;
  const ranges = [];
  if (result.startIndex > 0) {
    ranges.push(rejectedRange(
      words,
      0,
      result.startIndex - 1,
      containsScriptToken(words, 0, result.startIndex - 1, expected)
        ? 'repeat'
        : 'mistake',
    ));
  }
  ranges.push(...acceptedRanges(words, result.startIndex, result.endIndex));
  if (result.endIndex < words.length - 1) {
    ranges.push(rejectedRange(
      words,
      result.endIndex + 1,
      words.length - 1,
      containsScriptToken(words, result.endIndex + 1, words.length - 1, expected)
        ? 'abandoned'
        : 'mistake',
    ));
  }

  const takeMap = {
    version: 1,
    ranges: ranges.filter(Boolean).sort((a, b) => a.start - b.start),
  };
  const parsed = parseContract(TakeMapSchema, takeMap);
  if (!parsed.ok) throw new Error(`take map invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}
