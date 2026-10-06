import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';
import { retrieve, type AclInput } from './retrieve.ts';
import { UpstageEmbeddings } from './embeddings.ts';

// 이미지 프롬프트 합성 — spec §11.2: 생성 자체는 IMAGE_GENERATION_ENABLED provider가
// 없으면 하지 않고, 코퍼스 근거 기반 프롬프트만 만든다. 근거 없는 상상은 금지.

export interface ImagePromptResult {
  prompt: string;
  negative: string;
  style_version: number | null;
  evidence_keys: string[];
  /** 근거 청크의 문서 버전 결속 — 나중에 어떤 버전을 봤는지 추적한다. */
  evidence: { stable_key: string; revision: string }[];
  retrieved_at: string;
  /** 사람 승인(approved_by/at)이 있는 스타일만 쓴다 — 없으면 null. */
  style_approved: boolean;
  /** 이 응답은 "프롬프트 합성"뿐 — 이미지 생성은 provider 미연결로 수행하지 않는다. */
  mode: 'prompt_only';
  generation: 'provider_unconfigured';
}

const DEFAULT_NEGATIVE = '글자, 워터마크, 로고, 실존 인물 얼굴, 저해상도, 왜곡된 손, 어색한 비율';

/** 승인된 최신 스타일 프로필 — 미승인 draft를 절대 쓰지 않는다 (§15.2, RAG-018). */
async function activeStyle(store: KnowledgeStore, projectId: string) {
  return first<{ version: number; body: any }>(
    sql`SELECT version, body FROM style_profiles
        WHERE project_id=${projectId}
          AND approved_by IS NOT NULL AND approved_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
    store.db,
  );
}

/**
 * 요청 + 관련 코퍼스 근거 + 스타일 프로필로 이미지 프롬프트 합성.
 * 근거 검색은 retrieve를 재사용 — 검색된 출처 키를 함께 반환해 추적 가능하게 한다.
 */
export async function buildImagePrompt(
  store: KnowledgeStore,
  opts: {
    projectId: string;
    request: string;
    embeddings?: UpstageEmbeddings;
    evidenceLimit?: number;
    acl?: AclInput;
  },
): Promise<ImagePromptResult> {
  const chunks = await retrieve(store, {
    projectId: opts.projectId,
    query: opts.request,
    embeddings: opts.embeddings,
    limit: opts.evidenceLimit ?? 6,
    acl: opts.acl,
  });
  const style = await activeStyle(store, opts.projectId);
  const styleText = style?.body
    ? Object.entries(style.body)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
    : '';
  const refs = chunks.map(
    (c) => `[${c.source}:${c.stable_key.slice(0, 80)}] ${c.content.slice(0, 220)}`,
  );
  const prompt = [
    opts.request,
    refs.length ? `참고 근거:\n${refs.join('\n')}` : '',
    styleText ? `스타일: ${styleText}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    prompt,
    negative: (style?.body?.negative as string) ?? DEFAULT_NEGATIVE,
    style_version: style?.version ?? null,
    style_approved: style != null,
    evidence_keys: chunks.map((c) => c.stable_key),
    evidence: chunks.map((c) => ({ stable_key: c.stable_key, revision: c.revision })),
    retrieved_at: new Date().toISOString(),
    mode: 'prompt_only',
    generation: 'provider_unconfigured',
  };
}
