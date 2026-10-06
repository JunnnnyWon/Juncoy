import { z } from 'zod';
const Id = z.uuid();

// RAG 지식 파이프라인 계약 — docs/RAG_DEVELOPMENT_SPEC.md §9, §12, §13 기준.
// 원본 UUID/snowflake는 모두 문자열로 보존한다 (§9.1).

export const KnowledgeSourceKind = z.enum(['notion', 'github', 'discord', 'meeting']);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

// §8.1 문서 처리 상태
export const DocumentState = z.enum([
  'RECEIVED',
  'FETCH_PENDING',
  'FETCHED',
  'EXTRACTING',
  'INDEXING',
  'READY',
  'RETRYABLE',
  'ACCESS_LOST',
  'COVERAGE_GAP',
  'DEAD_LETTER',
  'UNAVAILABLE',
]);
export type DocumentState = z.infer<typeof DocumentState>;

export const KnowledgeJobKind = z.enum(['fetch', 'parse', 'extract', 'index', 'refresh', 'delete']);
export type KnowledgeJobKind = z.infer<typeof KnowledgeJobKind>;

export const KnowledgeJobStatus = z.enum([
  'PENDING',
  'RUNNING',
  'DONE',
  'RETRYABLE',
  'DEAD_LETTER',
]);
export type KnowledgeJobStatus = z.infer<typeof KnowledgeJobStatus>;

// §12 claim 상태. 모델 추출 confidence는 승인 권한이 아니다.
export const ClaimState = z.enum([
  'DISCUSSION',
  'PROPOSAL',
  'CONFIRMED',
  'OPEN',
  'SUPERSEDED',
  'REJECTED',
  'UNKNOWN',
]);
export type ClaimState = z.infer<typeof ClaimState>;

export const TemporalMode = z.enum(['current', 'history']);
export type TemporalMode = z.infer<typeof TemporalMode>;

// §13.1 응답 상태. COMPLETE는 네 출처 탐색·Discord live read·ACL·인용 검증 통과를 뜻한다.
export const AnswerStatus = z.enum(['COMPLETE', 'PARTIAL', 'NEEDS_CLARIFICATION', 'FAILED']);
export type AnswerStatus = z.infer<typeof AnswerStatus>;

// NOT_APPLICABLE은 프로젝트에 등록되지 않은 자료 유형에만 쓰인다.
export const SourceReadStatus = z.enum(['LIVE_READ', 'PARTIAL', 'FAILED', 'NOT_APPLICABLE']);
export type SourceReadStatus = z.infer<typeof SourceReadStatus>;

export const SourceSearchStatus = z.enum(['MATCH', 'NO_MATCH', 'NOT_SEARCHED']);
export type SourceSearchStatus = z.infer<typeof SourceSearchStatus>;

export const KnowledgeErrorCode = z.enum([
  'SOURCE_AUTH_REQUIRED',
  'SOURCE_ACCESS_LOST',
  'DISCORD_CONTENT_RESTRICTED',
  'SOURCE_RATE_LIMITED',
  'LIVE_REFRESH_TIMEOUT',
  'SOURCE_COVERAGE_GAP',
  'INDEX_NOT_READY',
  'EVIDENCE_CHANGED',
  'ACL_REVOKED',
  'MODEL_INVALID_RESPONSE',
  'IMAGE_PROVIDER_NOT_CONFIGURED',
]);
export type KnowledgeErrorCode = z.infer<typeof KnowledgeErrorCode>;

// §13.1 SSE 상태 — 검증 전 draft를 최종 본문처럼 stream하지 않는다.
export const AnswerRunPhase = z.enum([
  'checking_sources',
  'reading_discord',
  'refreshing_evidence',
  'searching',
  'resolving_conflicts',
  'generating',
  'revalidating',
  'complete',
  'partial',
  'failed',
]);
export type AnswerRunPhase = z.infer<typeof AnswerRunPhase>;

export const Evidence = z
  .object({
    id: z.string().min(1),
    source: KnowledgeSourceKind,
    document_id: z.string().min(1),
    revision: z.string().min(1),
    url: z.string().min(1),
    quote: z.string(),
    observed_at: z.iso.datetime(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

export const AnswerClaim = z
  .object({
    text: z.string(),
    state: ClaimState,
    evidence_ids: z.array(z.string()),
  })
  .strict();
export type AnswerClaim = z.infer<typeof AnswerClaim>;

export const SourceCoverage = z
  .object({
    source: KnowledgeSourceKind,
    read_status: SourceReadStatus,
    search_status: SourceSearchStatus,
    // 요청에 필요한 조회·pagination·최신 확인을 끝냄 — 전체 백필 완료가 아니다.
    scope_complete: z.boolean(),
    last_reconciled_at: z.iso.datetime().nullable(),
    gaps: z.array(z.string()),
  })
  .strict();
export type SourceCoverage = z.infer<typeof SourceCoverage>;

export const Answer = z
  .object({
    answer_id: Id,
    status: AnswerStatus,
    answer: z.string(),
    checked_at: z.iso.datetime(),
    temporal_mode: TemporalMode,
    claims: z.array(AnswerClaim),
    evidence: z.array(Evidence),
    // 네 출처에 대해 정확히 하나씩.
    source_coverage: z.array(SourceCoverage),
    conflicts: z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) }).strict()),
    warnings: z.array(z.string()),
    model: z.string(),
    corpus_generation: z.string(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).strict(),
  })
  .strict();
export type Answer = z.infer<typeof Answer>;

export const QuestionRequest = z
  .object({
    question: z.string().min(1).max(4000),
    temporal_mode: TemporalMode.default('current'),
    as_of: z.iso.datetime().optional(),
    branch: z.string().optional(),
    conversation_id: z.string().optional(),
  })
  .strict();
export type QuestionRequest = z.infer<typeof QuestionRequest>;

// §9.1 문서 안정 식별자. provider snowflake/UUID는 문자열 그대로.
export const documentKeys = {
  notionPage: (workspace: string, pageId: string) => `notion:${workspace}:${pageId}`,
  notionFile: (pageOrBlock: string, fileId: string) => `notion-file:${pageOrBlock}:${fileId}`,
  discordMessage: (guild: string, channelOrThread: string, messageId: string) =>
    `discord:${guild}:${channelOrThread}:${messageId}`,
  discordFile: (messageId: string, attachmentId: string) =>
    `discord-file:${messageId}:${attachmentId}`,
  githubFile: (repoId: string, ref: string, path: string) => `github:${repoId}:${ref}:${path}`,
  meetingTranscript: (workspace: string, meetingId: string) => `meeting:${workspace}:${meetingId}`,
} as const;
