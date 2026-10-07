import { z } from 'zod';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Crop = z.strictObject({
  left: z.number().min(0).max(1),
  top: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
}).superRefine((value, ctx) => {
  if (value.right <= value.left || value.bottom <= value.top)
    ctx.addIssue({ code: 'custom', message: 'invalid_crop' });
});

export const ImageBriefReference = z.strictObject({
  asset_id: z.string().uuid().nullable(),
  upload_id: z.string().uuid(),
  asset_revision: z.string().min(1).max(200),
  source_sha256: Sha256,
  order: z.number().int().nonnegative().max(15),
  role: z.array(z.string().min(1).max(80)).min(1).max(12),
  usage: z.record(z.string(), z.enum(['MUST_FOLLOW', 'STRONG_REFERENCE', 'MOOD_ONLY', 'PARTIAL_REFERENCE', 'REVIEW_REQUIRED'])),
  crop: Crop.nullable(),
  instruction: z.string().max(2000),
});
export type ImageBriefReference = z.infer<typeof ImageBriefReference>;

export const ImageBriefEvidence = z.strictObject({
  id: z.string().min(1).max(300),
  source: z.enum(['notion', 'github', 'discord', 'meeting', 'upload', 'art_board']),
  stable_key: z.string().min(1).max(1000),
  revision: z.string().min(1).max(300),
  quote: z.string().max(1000).optional(),
  read_status: z.enum(['OK', 'PARTIAL', 'FAILED', 'NOT_CONFIGURED']).default('OK'),
});
export type ImageBriefEvidence = z.infer<typeof ImageBriefEvidence>;

export const ImageBriefCoverage = z.record(
  z.enum(['notion', 'github', 'discord', 'meeting']),
  z.strictObject({
    read_status: z.enum(['OK', 'PARTIAL', 'FAILED', 'NOT_CONFIGURED']),
    latest_at: z.string().datetime().nullable(),
    gaps: z.array(z.string().max(300)).max(20),
  }),
);

export const ImageBriefDraft = z.strictObject({
  prompt: z.string().min(1).max(12000),
  negative_constraints: z.array(z.string().min(1).max(500)).max(64),
  role_directives: z.array(z.strictObject({ role: z.string().min(1).max(80), instruction: z.string().min(1).max(2000) })).max(32),
});

export const ImageBrief = z.strictObject({
  schema_version: z.literal(1),
  request: z.string().min(1).max(4000),
  role_directives: z.array(z.strictObject({
    role: z.string().min(1).max(80),
    instruction: z.string().min(1).max(2000),
  })).max(32),
  negative_constraints: z.array(z.string().min(1).max(500)).max(64),
  board_id: z.string().uuid(),
  board_revision: z.number().int().nonnegative(),
  art_bible_version: z.number().int().positive().nullable(),
  references: z.array(ImageBriefReference).max(16),
  evidence: z.array(ImageBriefEvidence).max(100),
  coverage: ImageBriefCoverage,
  provider: z.literal('openrouter'),
  model: z.literal('openai/gpt-image-2.5-flare'),
  prompt: z.string().min(1).max(12000),
  prompt_hash: Sha256,
  brief_hash: Sha256,
});
export type ImageBrief = z.infer<typeof ImageBrief>;
