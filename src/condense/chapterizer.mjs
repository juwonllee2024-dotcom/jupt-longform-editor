const DEFAULTS = Object.freeze({
  minSeconds: 20,
  maxSeconds: 90,
  pauseSeconds: 0.8,
});

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function chapterFromSegments(segments, index) {
  const speakers = [...new Set(segments.map((segment) => segment.speaker).filter(Boolean))];
  const speaker = speakers.length === 1 ? speakers[0] : (speakers.length > 1 ? 'mixed' : undefined);
  return {
    id: `chapter_${String(index + 1).padStart(3, '0')}`,
    start: segments[0].start,
    end: segments.at(-1).end,
    text: segments.map((segment) => cleanText(segment.text)).filter(Boolean).join(' '),
    ...(speaker ? { speaker } : {}),
    topicHint: cleanText(segments[0].text).slice(0, 160),
  };
}

export function chapterizeTranscript(transcript, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const minSeconds = Number(config.minSeconds);
  const maxSeconds = Number(config.maxSeconds);
  const pauseSeconds = Number(config.pauseSeconds);
  if (!Number.isFinite(minSeconds) || minSeconds <= 0) {
    throw new Error('minSeconds must be positive');
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds < minSeconds) {
    throw new Error('maxSeconds must be at least minSeconds');
  }
  if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0) {
    throw new Error('pauseSeconds must be non-negative');
  }

  const segments = (Array.isArray(transcript?.segments) ? transcript.segments : [])
    .filter((segment) => (
      Number.isFinite(segment?.start)
      && Number.isFinite(segment?.end)
      && segment.end > segment.start
      && cleanText(segment.text)
    ));
  if (segments.length === 0) return [];

  const chapters = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) chapters.push(chapterFromSegments(current, chapters.length));
    current = [];
  };

  for (const segment of segments) {
    if (current.length === 0) {
      current.push(segment);
      continue;
    }
    const previous = current.at(-1);
    const currentStart = current[0].start;
    const durationWithSegment = segment.end - currentStart;
    const gap = Math.max(0, segment.start - previous.end);
    const speakerChange = Boolean(
      previous.speaker
      && segment.speaker
      && previous.speaker !== segment.speaker,
    );
    const canSplit = segment.start - currentStart >= minSeconds;
    const exceedsMaximum = durationWithSegment > maxSeconds;
    const naturalBoundary = (speakerChange || gap >= pauseSeconds)
      && canSplit;
    if (exceedsMaximum || naturalBoundary) flush();
    current.push(segment);
  }
  flush();

  if (chapters.length > 1 && chapters.at(-1).end - chapters.at(-1).start < minSeconds) {
    const last = chapters.pop();
    const previous = chapters.at(-1);
    if (last.end - previous.start <= maxSeconds) {
      const mergedSegments = [{
        start: previous.start,
        end: previous.end,
        text: previous.text,
        speaker: previous.speaker,
      }, {
        start: last.start,
        end: last.end,
        text: last.text,
        speaker: last.speaker,
      }];
      chapters.push(chapterFromSegments(mergedSegments, chapters.length));
    } else {
      chapters.push(last);
    }
  }
  return chapters;
}
