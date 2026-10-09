import { EditPlanSchema, parseContract } from '../contracts.mjs';

export function createFallbackPlan({
  jobId,
  fps = 30,
  durationFrames,
  takeMap,
}) {
  const accepted = (takeMap?.ranges || []).filter((range) => range.accepted);
  const segments = accepted.map((range, index) => {
    const startFrame = Math.max(0, Math.round(range.start * fps));
    const endFrame = Math.min(
      durationFrames,
      Math.max(startFrame + 1, Math.round(range.end * fps)),
    );
    return {
      id: `segment_${String(index + 1).padStart(3, '0')}`,
      startFrame,
      endFrame,
      spokenText: range.text,
      layout: 'face-full',
      primaryAssetId: 'facecam_main',
      sourceId: null,
      captionStyle: index === 0 ? 'hook' : 'normal',
      confidence: 1,
      reason: 'Conservative degraded plan uses accepted face-camera take',
    };
  }).filter((segment) => segment.endFrame > segment.startFrame);

  if (segments.length === 0) {
    segments.push({
      id: 'segment_001',
      startFrame: 0,
      endFrame: durationFrames,
      spokenText: '',
      layout: 'face-full',
      primaryAssetId: 'facecam_main',
      sourceId: null,
      captionStyle: 'normal',
      confidence: 1,
      reason: 'Conservative degraded plan uses full face-camera timeline',
    });
  }

  const candidate = {
    version: 1,
    jobId,
    durationFrames,
    fps,
    segments,
    warnings: ['DEGRADED_EDIT_PLAN'],
  };
  const parsed = parseContract(EditPlanSchema, candidate);
  if (!parsed.ok) throw new Error(`fallback plan invalid: ${parsed.errors.join('; ')}`);
  return parsed.value;
}
