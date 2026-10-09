import { z } from 'zod';

const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);

const SourceWordSchema = z.strictObject({
  word: z.string().trim().min(1).max(200),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
});

const SourceSegmentSchema = z.strictObject({
  id: IdSchema,
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  text: z.string().max(2_000),
  speaker: z.string().trim().min(1).max(120).optional(),
  words: z.array(SourceWordSchema).max(10_000).optional(),
});

export const SourceTranscriptSchema = z.strictObject({
  version: z.literal(1),
  language: z.literal('en'),
  durationSeconds: z.number().finite().positive(),
  segments: z.array(SourceSegmentSchema).min(1).max(10_000),
  words: z.array(SourceWordSchema).max(100_000).optional(),
  koreanWords: z.array(SourceWordSchema).max(100_000).optional(),
}).superRefine((transcript, context) => {
  let previousEnd = 0;
  for (const [index, segment] of transcript.segments.entries()) {
    if (segment.end <= segment.start || segment.end > transcript.durationSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index],
        message: 'segment must be positive and inside source duration',
      });
    }
    if (segment.start < previousEnd) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index, 'start'],
        message: 'segments must be ordered and non-overlapping',
      });
    }
    previousEnd = Math.max(previousEnd, segment.end);
    for (const [wordIndex, word] of (segment.words || []).entries()) {
      if (
        word.end <= word.start
        || word.start < segment.start
        || word.end > segment.end
      ) {
        context.addIssue({
          code: 'custom',
          path: ['segments', index, 'words', wordIndex],
          message: 'word must stay inside its segment',
        });
      }
    }
  }
  for (const [index, word] of (transcript.words || []).entries()) {
    if (word.end <= word.start || word.end > transcript.durationSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['words', index],
        message: 'word must be positive and stay inside source duration',
      });
    }
  }
  for (const [index, word] of (transcript.koreanWords || []).entries()) {
    if (word.end <= word.start || word.end > transcript.durationSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['koreanWords', index],
        message: 'Korean word must be positive and stay inside source duration',
      });
    }
  }
});

export const CondenseClipSchema = z.strictObject({
  id: IdSchema,
  sourceStartSec: z.number().finite().nonnegative(),
  sourceEndSec: z.number().finite().positive(),
  durationSec: z.number().finite().positive().optional(),
  topic: z.string().trim().min(1).max(240),
  topicGroup: z.string().trim().min(1).max(240).optional(),
  summary: z.string().trim().max(1_000),
  whyKept: z.string().trim().min(1).max(300),
  confidence: z.number().finite().min(0).max(1),
  sourceRef: z.string().trim().min(1).max(500),
});

const CoverageSchema = z.strictObject({
  idea: z.string().trim().min(1).max(240),
  clipIds: z.array(IdSchema).min(1).max(100),
});

const DroppedRangeSchema = z.strictObject({
  sourceStartSec: z.number().finite().nonnegative(),
  sourceEndSec: z.number().finite().positive(),
  reason: z.string().trim().min(1).max(300),
});

export const CondensePlanSchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal('longform-condense'),
  targetDurationSec: z.number().finite().min(300).max(480),
  sourceDurationSec: z.number().finite().positive(),
  clips: z.array(CondenseClipSchema).min(1).max(500),
  coverage: z.array(CoverageSchema).max(100),
  dropped: z.array(DroppedRangeSchema).max(10_000),
  warnings: z.array(z.string().trim().min(1).max(500)).max(100),
});

function contractErrors(error) {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`);
}

export function validateCondensePlan(value) {
  const parsed = CondensePlanSchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: contractErrors(parsed.error) };

  const plan = parsed.data;
  const errors = [];
  let previousEnd = 0;
  let selectedDuration = 0;
  const ids = new Set();
  for (const [index, clip] of plan.clips.entries()) {
    if (ids.has(clip.id)) errors.push(`clips.${index}.id: duplicate clip id`);
    ids.add(clip.id);
    if (clip.sourceEndSec <= clip.sourceStartSec) {
      errors.push(`clips.${index}: source range must be positive`);
    }
    if (
      clip.durationSec !== undefined
      && Math.abs(clip.durationSec - (clip.sourceEndSec - clip.sourceStartSec)) > 0.01
    ) {
      errors.push(`clips.${index}.durationSec: must match source range`);
    }
    if (clip.sourceEndSec - clip.sourceStartSec > 90) {
      errors.push(`clips.${index}: source range cannot exceed 90 seconds`);
    }
    if (clip.sourceStartSec < previousEnd) {
      errors.push(`clips.${index}: clips must be ordered and non-overlapping`);
    }
    if (clip.sourceEndSec > plan.sourceDurationSec) {
      errors.push(`clips.${index}: source range exceeds source duration`);
    }
    previousEnd = Math.max(previousEnd, clip.sourceEndSec);
    selectedDuration += Math.max(0, clip.sourceEndSec - clip.sourceStartSec);
  }
  if (plan.sourceDurationSec < plan.targetDurationSec) {
    errors.push('sourceDurationSec: source must be longer than target duration');
  }
  if (selectedDuration < 300 || selectedDuration > 480) {
    errors.push('clips: selected duration must be between 300 and 480 seconds');
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, value: plan };
}
