import { z } from 'zod';

export const JOB_STATES = Object.freeze([
  'queued',
  'validating',
  'transcribing',
  'planning',
  'matching',
  'rendering',
  'checking',
  'ready-for-review',
  'revision-requested',
  'approved',
  'blocked',
]);

export const LAYOUTS = Object.freeze([
  'face-full',
  'visual-full-face-circle',
  'screen-full-face-circle',
  'visual-full',
  'title-card',
  'source-full',
  'source-full-face-circle',
]);

export const JobStateSchema = z.enum(JOB_STATES);

export const RelativeMediaPathSchema = z.string().min(1).max(260).superRefine((value, context) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    /^[A-Za-z]:\//.test(normalized)
    || normalized.startsWith('/')
    || normalized.split('/').includes('..')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'path must stay relative to job root',
    });
  }
});

const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const SourcesSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(z.strictObject({
    id: IdSchema,
    title: z.string().min(1).max(300),
    url: z.string().url().refine((value) => ['https:', 'http:'].includes(new URL(value).protocol)),
    publisher: z.string().min(1).max(120),
    publishedAt: z.iso.date(),
    usage: z.enum([
      'commentary-screenshot',
      'official-media',
      'original',
      'deterministic-graphic',
    ]),
    localAsset: RelativeMediaPathSchema,
  })).max(100),
  screenClips: z.array(z.strictObject({
    id: IdSchema,
    path: RelativeMediaPathSchema,
    description: z.string().min(1).max(500),
    scriptHints: z.array(z.string().min(1).max(160)).max(20),
  })).max(100),
});

export const EditSegmentSchema = z.strictObject({
  id: IdSchema,
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  spokenText: z.string().max(1000),
  layout: z.enum(LAYOUTS),
  primaryAssetId: IdSchema,
  sourceId: IdSchema.nullable(),
  captionStyle: z.enum(['hook', 'normal', 'emphasis', 'none']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
});

export const EditPlanSchema = z.strictObject({
  version: z.literal(1),
  jobId: IdSchema,
  durationFrames: z.number().int().positive(),
  fps: z.literal(30),
  segments: z.array(EditSegmentSchema).min(1).max(500),
  warnings: z.array(z.string().max(500)).max(100),
}).superRefine((plan, context) => {
  let previousEnd = 0;
  for (const [index, segment] of plan.segments.entries()) {
    if (
      segment.startFrame < previousEnd
      || segment.endFrame <= segment.startFrame
      || segment.endFrame > plan.durationFrames
    ) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index],
        message: 'segments must be ordered, bounded, and non-overlapping',
      });
    }
    previousEnd = segment.endFrame;
  }
});

export const IngestManifestSchema = z.strictObject({
  version: z.literal(1),
  jobId: IdSchema,
  inputHash: Sha256Schema,
  facecam: z.strictObject({
    id: z.literal('facecam_main'),
    path: RelativeMediaPathSchema,
    sha256: Sha256Schema,
    durationSeconds: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  assets: z.array(z.strictObject({
    id: IdSchema,
    path: RelativeMediaPathSchema,
    sha256: Sha256Schema,
    kind: z.enum(['screen', 'image', 'music']),
  })).max(300),
});

export const TranscriptSchema = z.strictObject({
  version: z.literal(1),
  language: z.literal('ko'),
  text: z.string().max(100_000),
  words: z.array(z.strictObject({
    word: z.string().min(1).max(200),
    start: z.number().nonnegative(),
    end: z.number().positive(),
  })).max(100_000),
});

export const TakeMapSchema = z.strictObject({
  version: z.literal(1),
  ranges: z.array(z.strictObject({
    start: z.number().nonnegative(),
    end: z.number().positive(),
    text: z.string().max(2_000),
    accepted: z.boolean(),
    reason: z.enum(['complete', 'silence', 'repeat', 'abandoned', 'mistake']),
  })).max(10_000),
});

export const QaReportSchema = z.strictObject({
  version: z.literal(1),
  passed: z.boolean(),
  critical: z.array(z.string().max(300)).max(300),
  warnings: z.array(z.string().max(300)).max(300),
  metrics: z.record(z.string(), z.union([
    z.string().max(1_000),
    z.number(),
    z.boolean(),
  ])),
});

export function parseContract(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}
