import { z } from 'zod';
const Id = z.uuid();

// 웹 프로젝트 어시스턴트 계약 — docs/WEB_PROJECT_ASSISTANT_DEVELOPMENT_SPEC.md §5/§7/§11/§14.
// 원본 ID는 문자열로 보존한다. 모델의 문장만으로 승인된 것으로 판단하지 않는다.

// §5 실행 모드 — 모든 assistant request는 이 중 하나로 분류된다.
export const AssistantMode = z.enum([
  'answer',
  'search',
  'propose',
  'mutate',
  'generate',
  'ingest',
]);
export type AssistantMode = z.infer<typeof AssistantMode>;

// §7 대화 run 상태.
export const AssistantRunPhase = z.enum([
  'idle',
  'retrieving',
  'checking_sources',
  'planning_tool_call',
  'awaiting_approval',
  'executing_tool',
  'generating_image',
  'ingesting_file',
  'completed',
  'partial',
  'failed',
]);
export type AssistantRunPhase = z.infer<typeof AssistantRunPhase>;

// run 종료 상태는 기존 answer 상태와 같은 의미론을 쓴다.
export const AssistantRunStatus = z.enum(['COMPLETE', 'PARTIAL', 'NEEDS_CLARIFICATION', 'FAILED']);
export type AssistantRunStatus = z.infer<typeof AssistantRunStatus>;

// §6 tool 이름 — registry에 등록된 이름만 허용한다. 모델이 임의 문자열을
// tool로 호출하지 못한다.
export const AssistantToolName = z.enum([
  'knowledge.search',
  'knowledge.ask',
  'knowledge.get_evidence',
  'discord.refresh_context',
  'notion.search',
  'notion.fetch_page',
  'notion.query_schedule',
  'notion.query_tasks',
  'github.search_code',
  'github.fetch_file',
  'meeting.search_transcript',
  'file.get_ingestion_status',
  'notion.preview_create_page',
  'notion.preview_update_page',
  'notion.preview_create_schedule',
  'notion.preview_update_schedule',
  'notion.preview_create_task',
  'notion.preview_update_task',
  'file.preview_delete_or_replace',
  'image.preview_generation',
  'notion.commit_page_change',
  'notion.commit_schedule_change',
  'notion.commit_task_change',
  'file.commit_delete_or_replace',
  'image.generate',
]);
export type AssistantToolName = z.infer<typeof AssistantToolName>;

// §11 approval 상태.
export const ApprovalStatus = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CONSUMED',
  'CANCELLED',
  'CONFLICT',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

// §11 역할 — 길드 멤버는 기본 reader. Discord 역할명을 자동으로 write로 승격하지 않는다.
export const AssistantRole = z.enum(['reader', 'editor', 'admin']);
export type AssistantRole = z.infer<typeof AssistantRole>;

export const AssistantConversation = z.strictObject({
  id: Id,
  project_id: Id,
  owner_id: z.string(),
  title: z.string(),
  archived: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AssistantConversation = z.infer<typeof AssistantConversation>;

export const AssistantMessage = z.strictObject({
  id: Id,
  conversation_id: Id,
  run_id: Id.nullable(),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  attachments: z.array(z.any()).default([]),
  citations: z.array(z.any()).default([]),
  created_at: z.string(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

// SSE로 흘러가는 run 이벤트 — seq는 대화 내에서 단조 증가한다.
export const AssistantRunEvent = z.strictObject({
  id: Id,
  run_id: Id,
  seq: z.number().int(),
  kind: z.string(), // phase | message_delta | evidence | coverage | tool_call | approval | result | error
  payload: z.any(),
  payload_hash: z.string(),
  created_at: z.string(),
});
export type AssistantRunEvent = z.infer<typeof AssistantRunEvent>;

// §10 preview가 만드는 승인 대상 — target을 재조회하고 before_hash를 비교해 실행한다.
export const AssistantApproval = z.strictObject({
  id: Id,
  project_id: Id,
  user_id: z.string(),
  conversation_id: Id.nullable(),
  run_id: Id.nullable(),
  kind: z.string(), // notion_page | notion_schedule | notion_task | file_delete | image_generate
  target: z.any(), // { connector, stable_id, revision, fetched_hash } — URL만 저장 금지
  before_hash: z.string().nullable(),
  after: z.any(),
  status: ApprovalStatus,
  expires_at: z.string(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type AssistantApproval = z.infer<typeof AssistantApproval>;

// §9 파일 업로드 상태.
export const UploadState = z.enum(['UPLOADED', 'EXTRACTING', 'INDEXING', 'READY', 'FAILED']);
export type UploadState = z.infer<typeof UploadState>;

export const KnowledgeUpload = z.strictObject({
  id: Id,
  project_id: Id,
  owner_id: z.string(),
  filename: z.string(),
  mime: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  storage_key: z.string(),
  state: UploadState,
  error: z.string().nullable(),
  created_at: z.string(),
});
export type KnowledgeUpload = z.infer<typeof KnowledgeUpload>;

export const ImageJobStatus = z.enum([
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'REJECTED',
  'CANCELLED',
]);
export type ImageJobStatus = z.infer<typeof ImageJobStatus>;
