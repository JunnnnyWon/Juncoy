import { z } from 'zod';

const uuid = z.uuid(),
  user = z.string().regex(/^\d{15,22}$/);
export const FactKind = z.enum(['DISCUSSION', 'PROPOSAL', 'DECISION', 'ACTION', 'UNCERTAIN']);
export const FactSection = z.enum([
  'topics',
  'decisions',
  'action_items',
  'open_questions',
  'blockers',
  'next_agenda',
]);
export const FactCategory = z.enum(['기획', '프로그래밍', '아트', '사운드', 'QA', '운영', '기타']);
const UnitKind = z.enum(['IGNORE', 'DISCUSSION', 'PROPOSAL', 'DECISION', 'ACTION', 'UNCERTAIN']);
export const UnitClassification = z
  .object({
    items: z.array(
      z
        .object({
          unit_key: z.number().int().nonnegative(),
          kind: UnitKind,
          salience: z.enum(['CORE', 'DETAIL', 'NON_CONTENT']).optional(),
          section: FactSection,
          category: FactCategory,
        })
        .strict(),
    ),
  })
  .strict();
export const UnitReview = z
  .object({
    items: z.array(
      z
        .object({
          unit_key: z.number().int().nonnegative(),
          kind: UnitKind,
          salience: z.enum(['CORE', 'DETAIL', 'NON_CONTENT']).optional(),
          section: FactSection,
          category: FactCategory,
          supported: z.boolean(),
          owner_supported: z.boolean().optional(),
          due_supported: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type UnitClassificationDTO = z.infer<typeof UnitClassification>;
export type UnitReviewDTO = z.infer<typeof UnitReview>;
export const FactDraft = z
  .object({
    kind: FactKind,
    section: FactSection,
    category: FactCategory,
    topic: z.string().min(1).max(160),
    statement: z.string().min(1).max(800),
    evidence_segment_ids: z.array(uuid).min(1).max(4),
    owner_user_id: user.nullable(),
    owner_evidence_index: z.number().int().min(0).max(3).nullable(),
    due_date_text: z.string().nullable(),
    due_evidence_index: z.number().int().min(0).max(3).nullable(),
  })
  .strict();
export const FactExtraction = z
  .object({
    facts: z.array(FactDraft),
    ignored: z.array(
      z
        .object({
          evidence_segment_ids: z.array(uuid).min(1).max(4),
          reason: z.enum(['NON_SUBSTANTIVE', 'CONTEXT', 'REPETITION', 'UNINTELLIGIBLE']),
        })
        .strict(),
    ),
  })
  .strict();
export const FactVerification = z
  .object({
    checks: z.array(
      z
        .object({
          fact_key: z.number().int().nonnegative(),
          verdict: z.enum(['SUPPORTED', 'UNSUPPORTED', 'UNCERTAIN']),
          kind: FactKind,
          section_supported: z.boolean(),
          owner_supported: z.boolean(),
          due_supported: z.boolean(),
          reason_code: z.enum([
            'DIRECT_SUPPORT',
            'PROPOSAL_ONLY',
            'NO_ASSIGNMENT',
            'NOT_A_DECISION',
            'UNCLEAR_SOURCE',
            'WRONG_ENTITY',
            'UNSUPPORTED_DETAIL',
            'WRONG_OWNER',
            'WRONG_DATE',
            'TRANSCRIPT_INSTRUCTION',
          ]),
        })
        .strict(),
    ),
    missing_evidence_segment_ids: z.array(uuid),
  })
  .strict();
export const FactRelations = z
  .object({
    links: z.array(
      z
        .object({
          earlier_fact_key: z.number().int().nonnegative(),
          later_fact_key: z.number().int().nonnegative(),
          relation: z.enum(['DUPLICATE', 'SUPERSEDED']),
          evidence_segment_ids: z.array(uuid).min(1).max(4),
        })
        .strict(),
    ),
  })
  .strict();
export interface EvidenceSpan {
  segment_id: string;
  revision: number;
  start_char: number;
  end_char: number;
  quote: string;
}
export interface LedgerFact {
  fact_id: string;
  transcript_version: number;
  source_order: number;
  kind: z.infer<typeof FactKind>;
  section: z.infer<typeof FactSection>;
  category: z.infer<typeof FactCategory>;
  topic: string;
  statement: string;
  evidence: EvidenceSpan[];
  owner_user_id: string | null;
  owner_evidence: EvidenceSpan | null;
  due_date: string | null;
  due_date_text: string | null;
  due_evidence: EvidenceSpan | null;
  verification: 'SUPPORTED' | 'DOWNGRADED' | 'UNCERTAIN' | 'REJECTED';
  reason_code: string;
  salience?: 'CORE' | 'DETAIL' | 'NON_CONTENT';
}
export interface FactDisposition {
  fact_id: string;
  status: 'RENDERED' | 'DUPLICATE' | 'SUPERSEDED' | 'REJECTED' | 'EXCLUDED';
  target_fact_id: string | null;
  output_path: string | null;
  reason_code: string;
}
export interface LedgerReport {
  pipeline_version: string;
  input_segments: number;
  primary_coverage: number;
  facts: number;
  rendered: number;
  rejected: number;
  excluded?: number;
  dispositions: FactDisposition[];
  source_min_ms: number | null;
  source_max_ms: number | null;
  quality_passed: boolean;
}
export type FactDraftDTO = z.infer<typeof FactDraft>;
export type FactExtractionDTO = z.infer<typeof FactExtraction>;
export type FactVerificationDTO = z.infer<typeof FactVerification>;
export type FactRelationsDTO = z.infer<typeof FactRelations>;
