export function sourceVideoTrimProps(segment, sourceDurationFrames) {
  const start = Number(segment?.sourceStartFrame);
  const end = Number(segment?.sourceEndFrame);
  const duration = Number(sourceDurationFrames);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start) {
    return {};
  }
  const props = { trimBefore: start };
  if (Number.isInteger(duration) && duration >= end) {
    const trimAfter = duration - end;
    // Remotion requires trimAfter to be positive when supplied. Reaching the
    // source end needs no trimAfter prop at all.
    if (trimAfter > 0) props.trimAfter = trimAfter;
  }
  return props;
}

export function selectDialogueWords({ mode, sourceTranscript, transcript } = {}) {
  if (mode === 'longform-condense') {
    return Array.isArray(sourceTranscript?.koreanWords)
      ? sourceTranscript.koreanWords
      : [];
  }
  return Array.isArray(transcript?.words) ? transcript.words : [];
}
