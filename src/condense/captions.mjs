import { captionEvents } from '../composition/editorial-grammar.mjs';

export function remapCaptionEvents(words, segments, fps = 30) {
  const frameRate = Number(fps);
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    throw new Error('fps must be a positive integer');
  }
  const events = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const sourceStartSeconds = Number(segment?.sourceStartSec);
    const sourceEndSeconds = Number(segment?.sourceEndSec);
    const outputStartFrame = Number(segment?.outputStartFrame);
    if (
      !Number.isFinite(sourceStartSeconds)
      || !Number.isFinite(sourceEndSeconds)
      || sourceEndSeconds <= sourceStartSeconds
      || !Number.isInteger(outputStartFrame)
      || outputStartFrame < 0
    ) continue;
    events.push(...captionEvents(words, frameRate, {
      sourceStartSeconds,
      sourceEndSeconds,
      outputStartFrame,
    }));
  }
  return events.sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
}
