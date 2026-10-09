const MAX_LINE_CELLS = 16;
const MAX_EVENT_CELLS = MAX_LINE_CELLS * 2;
const MIN_CAPTION_FRAMES = 12;

function displayCells(value) {
  return [...String(value || '')].length;
}

function wrapLines(words) {
  const lines = [];
  let current = '';
  for (const originalWord of words) {
    const pieces = [];
    let remaining = originalWord;
    while (displayCells(remaining) > MAX_LINE_CELLS) {
      pieces.push([...remaining].slice(0, MAX_LINE_CELLS).join(''));
      remaining = [...remaining].slice(MAX_LINE_CELLS).join('');
    }
    if (remaining) pieces.push(remaining);

    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (displayCells(candidate) <= MAX_LINE_CELLS) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function makeCaptionEvent(words, fps, options) {
  const {
    sourceStartSeconds,
    outputStartFrame,
  } = options;
  const startFrame = Math.max(
    outputStartFrame,
    outputStartFrame + Math.round(
      (words[0].start - sourceStartSeconds) * fps,
    ),
  );
  const measuredEnd = outputStartFrame + Math.round(
    (words.at(-1).end - sourceStartSeconds) * fps,
  );
  const endFrame = Math.max(startFrame + MIN_CAPTION_FRAMES, measuredEnd);
  const displayWords = words.map((word) => String(word.word).trim()).filter(Boolean);
  const highlight = [...displayWords]
    .sort((left, right) => displayCells(right) - displayCells(left))[0] || '';
  return {
    startFrame,
    endFrame,
    lines: wrapLines(displayWords),
    text: displayWords.join(' '),
    highlight,
  };
}

export function captionEvents(words, fps, options = {}) {
  const sourceStartSeconds = Number(options.sourceStartSeconds || 0);
  const sourceEndSeconds = Number.isFinite(options.sourceEndSeconds)
    ? options.sourceEndSeconds
    : Number.POSITIVE_INFINITY;
  const outputStartFrame = Number(options.outputStartFrame || 0);
  const selected = (Array.isArray(words) ? words : []).filter((word) => (
    typeof word?.word === 'string'
    && Number.isFinite(word.start)
    && Number.isFinite(word.end)
    && word.end > word.start
    && word.end > sourceStartSeconds
    && word.start < sourceEndSeconds
  ));
  if (selected.length === 0) return [];

  const groups = [];
  let current = [];
  let cellCount = 0;
  for (const word of selected) {
    const clean = word.word.trim();
    if (!clean) continue;
    const previous = current.at(-1);
    const gap = previous ? word.start - previous.end : 0;
    const projectedCells = cellCount + (current.length ? 1 : 0) + displayCells(clean);
    if (current.length && (gap > 0.35 || projectedCells > MAX_EVENT_CELLS)) {
      groups.push(current);
      current = [];
      cellCount = 0;
    }
    current.push(word);
    cellCount += (current.length > 1 ? 1 : 0) + displayCells(clean);
    if (/[.!?。！？]$/.test(clean)) {
      groups.push(current);
      current = [];
      cellCount = 0;
    }
  }
  if (current.length) groups.push(current);

  return groups.map((group) => makeCaptionEvent(group, fps, {
    sourceStartSeconds,
    outputStartFrame,
  }));
}

export function circleAnchor({
  leftEdgeScore,
  rightEdgeScore,
}) {
  const left = Number(leftEdgeScore);
  const right = Number(rightEdgeScore);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('face anchor requires measured obstruction scores');
  }
  return left < right ? 'middle-left' : 'middle-right';
}

export function timelineSegments(plan) {
  let outputStartFrame = 0;
  return (Array.isArray(plan?.segments) ? plan.segments : []).map((segment) => {
    const hasExplicitSource = Number.isInteger(segment.sourceStartFrame)
      && Number.isInteger(segment.sourceEndFrame);
    const sourceStartFrame = hasExplicitSource
      ? segment.sourceStartFrame
      : segment.startFrame;
    const sourceEndFrame = hasExplicitSource
      ? segment.sourceEndFrame
      : segment.endFrame;
    const durationInFrames = hasExplicitSource && Number.isInteger(segment.durationInFrames)
      ? segment.durationInFrames
      : sourceEndFrame - sourceStartFrame;
    if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) {
      throw new Error(`segment ${segment.id || 'unknown'} has invalid duration`);
    }
    const requestedOutputStart = Number.isInteger(segment.outputStartFrame)
      ? segment.outputStartFrame
      : outputStartFrame;
    const requestedOutputEnd = Number.isInteger(segment.outputEndFrame)
      ? segment.outputEndFrame
      : requestedOutputStart + durationInFrames;
    if (
      requestedOutputStart !== outputStartFrame
      || requestedOutputEnd - requestedOutputStart !== durationInFrames
    ) {
      throw new Error(`segment ${segment.id || 'unknown'} has invalid output range`);
    }
    const timelineSegment = {
      ...segment,
      sourceStartFrame,
      sourceEndFrame,
      outputStartFrame: requestedOutputStart,
      durationInFrames,
    };
    outputStartFrame = requestedOutputEnd;
    return timelineSegment;
  });
}

export function timelineDuration(plan) {
  return timelineSegments(plan)
    .reduce((total, segment) => total + segment.durationInFrames, 0);
}

export function segmentStyle(segment) {
  return Object.freeze({
    transitionFrames: String(segment?.reason || '').includes('section transition')
      ? 8
      : 0,
    punchIn: segment?.captionStyle === 'emphasis',
  });
}

export function layoutAudioPolicy(layout, options = {}) {
  if (![ 
    'face-full',
    'visual-full-face-circle',
    'screen-full-face-circle',
    'visual-full',
    'title-card',
    'source-full',
    'source-full-face-circle',
  ].includes(layout)) {
    throw new Error(`unknown layout audio policy: ${layout}`);
  }
  return options.mode === 'longform-condense'
    && String(layout).startsWith('source-')
    ? 'source-dialogue'
    : 'facecam-dialogue';
}
