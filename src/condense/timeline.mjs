export function mapCondenseTimeline(plan, fps = 30) {
  const frameRate = Number(fps);
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    throw new Error('fps must be a positive integer');
  }
  const clips = Array.isArray(plan?.clips) ? plan.clips : [];
  const segments = [];
  let outputStartFrame = 0;
  let previousSourceEndFrame = 0;
  for (const [index, clip] of clips.entries()) {
    const sourceStartFrame = Math.round(Number(clip?.sourceStartSec) * frameRate);
    const sourceEndFrame = Math.round(Number(clip?.sourceEndSec) * frameRate);
    if (!Number.isFinite(sourceStartFrame) || !Number.isFinite(sourceEndFrame)) {
      throw new Error(`clip ${clip?.id || index} has invalid source range`);
    }
    if (sourceEndFrame <= sourceStartFrame) {
      throw new Error(`clip ${clip?.id || index} has non-positive source range`);
    }
    if (sourceStartFrame < previousSourceEndFrame) {
      throw new Error('clips must be ordered and non-overlapping');
    }
    const durationInFrames = sourceEndFrame - sourceStartFrame;
    const outputEndFrame = outputStartFrame + durationInFrames;
    segments.push({
      ...clip,
      sourceStartFrame,
      sourceEndFrame,
      outputStartFrame,
      outputEndFrame,
      durationInFrames,
      audioSource: 'source',
      layout: 'source-full',
    });
    previousSourceEndFrame = sourceEndFrame;
    outputStartFrame = outputEndFrame;
  }
  return {
    segments,
    durationFrames: outputStartFrame,
  };
}
