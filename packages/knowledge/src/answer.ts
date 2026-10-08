import { z } from 'zod';
import { KnowledgeStore, sql, first, rows } from '@meeting/knowledge-db';
import {
  Answer,
  AnswerStatus,
  ClaimState,
  QuestionRequest,
  SourceCoverage,
} from '@meeting/contracts';
import { retrieve, RetrievedChunk, AclInput } from './retrieve.ts';
import { UpstageEmbeddings } from './embeddings.ts';

// 문답 파이프라인 — spec §11.1/§13.
// Discord live read는 매 질문마다 시도하고, 실패하면 PARTIAL 강등만 한다 (§13.3).
// 검증 전 draft는 answer_runs.body에 쓰지 않는다 — 검증 완료 Answer만 저장.

const SOURCES = ['notion', 'github', 'discord', 'meeting'] as const;

const ModelOutput = z.object({
  answer: z.string(),
  claims: z
    .array(
      z.object({
        text: z.string(),
        state: z.enum(['DISCUSSION', 'PROPOSAL', 'CONFIRMED', 'OPEN', 'UNKNOWN']),
        evidence_ids: z.array(z.string()),
      }),
    )
    .default([]),
  conflicts: z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) })).default([]),
  warnings: z.array(z.string()).default([]),
});
type ModelOutput = z.infer<typeof ModelOutput>;

/** Solar.structured 호환 최소 인터페이스. */
export interface ChatModel {
  structured<T>(
    schema: z.ZodType<T>,
    input: unknown,
    system: string,
  ): Promise<{
    result: T;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
}

/** Discord 라이브 읽기 결과 — 앱이 주입한다. */
export interface DiscordLiveRead {
  (timeoutMs: number): Promise<{ ok: boolean; gaps: string[] }>;
}

const ANSWER_SYSTEM = `너는 프로젝트 지식 어시스턴트다. 아래 evidence 목록만 근거로 한국어로 답한다.
규칙:
- 모든 서술은 evidence에 근거한다. 근거가 없으면 억측하지 않고 "자료에 없음"이라고 한다.
- 각 claim의 evidence_ids에 근거 evidence의 id를 넣는다. 근거 없는 claim은 만들지 않는다.
- evidence 간 충돌·구버전·상반된 결정이 보이면 conflicts에 적는다.
- 최신 정보가 없거나 요청 시점과 evidence가 다르면 warnings에 명시한다.
- answer는 간결한 한국어 문장들로 쓴다.`;

interface CoverageInput {
  source: (typeof SOURCES)[number];
  read_status: SourceCoverage['read_status'];
  search_status: SourceCoverage['search_status'];
  scope_complete: boolean;
  last_reconciled_at: string | null;
  gaps: string[];
}

/** stable_key → 사람이 열 수 있는 URL (출처별 형식, §13 evidence.url). */
export function stableKeyToUrl(stableKey: string, span: Record<string, any> = {}): string {
  const [kind, ...rest] = stableKey.split(':');
  if (kind === 'discord') {
    const [guild, channel, message] = rest;
    return `https://discord.com/channels/${guild}/${channel}/${message}`;
  }
  if (kind === 'github') {
    const repo = rest[0];
    const ref = rest[1];
    const path = rest.slice(2).join(':');
    return `https://github.com/${repo}/blob/${ref}/${path}`;
  }
  if (kind === 'notion') return `https://notion.so/${rest[1]?.replace(/-/g, '') ?? rest.join('')}`;
  if (kind === 'meeting') return `https://juncoystt.junnnny.kr/meetings/${rest[1]}`;
  if (kind === 'upload') {
    const page = Number(span.page_start ?? 0);
    return `/api/assistant/files/${rest[0]}/content${page > 0 ? `#page=${page}` : ''}`;
  }
  return '';
}

async function sourceRows(store: KnowledgeStore, projectId: string) {
  return rows<{ id: string; kind: string; status: string; scopes: number }>(
    sql`SELECT s.id, s.kind, s.status,
          (SELECT count(*)::int FROM source_scopes sc
            WHERE sc.source_id=s.id AND sc.allowed) AS scopes
        FROM knowledge_sources s WHERE s.project_id=${projectId}`,
    store.db,
  );
}

async function lastReconciled(store: KnowledgeStore, sourceId: string) {
  const row = await first<{ t: Date | null }>(
    sql`SELECT max(last_reconciled_at) AS t FROM connector_cursors WHERE source_id=${sourceId}`,
    store.db,
  );
  return row?.t ? row.t.toISOString() : null;
}

/** 프로젝트의 corpus generation — 현재 활성 인덱스의 최신 갱신 시각 집계. */
async function corpusGeneration(store: KnowledgeStore, projectId: string) {
  const row = await first<{ g: string | null }>(
    sql`SELECT to_char(max(d.updated_at), 'YYYYMMDDHH24MISS') AS g
        FROM documents d JOIN knowledge_sources s ON s.id=d.source_id
        WHERE s.project_id=${projectId}`,
    store.db,
  );
  return row?.g ?? '0';
}

/**
 * 근거 재검증 (§11.1 단계 8, RAG-004) — 생성 시점에 캡처된 revision 대비
 * 현재 상태를 확인한다: 문서 READY·비삭제·비-dirty, 청크의 chunk_set이 아직
 * current 버전에 결속, 현재 버전의 정규화 본문에 청크 텍스트가 존재,
 * 그리고 ACL(허용 scope/ACTIVE 소스)이 여전히 통과해야 한다.
 */
async function revalidateEvidence(
  store: KnowledgeStore,
  ev: { chunk: RetrievedChunk; revision: string },
  acl?: AclInput,
) {
  const doc = await first<{
    state: string;
    deleted: boolean;
    dirty: boolean;
    content_hash: string | null;
    text: string | null;
    bound: boolean;
    allowed: boolean;
  }>(
    sql`SELECT d.state, d.deleted, d.dirty, v.content_hash,
          left(v.normalized->>'text', 200000) AS text,
          EXISTS(SELECT 1 FROM chunks c2
                 JOIN chunk_sets s ON s.id=c2.chunk_set_id
                   AND s.active AND s.version_id=d.current_version_id
                 WHERE c2.id=${ev.chunk.chunk_id}) AS bound,
          (src.status='ACTIVE' AND (
            d.acl->>'scope' IS NULL OR EXISTS(
              SELECT 1 FROM source_scopes sc
              WHERE sc.source_id=d.source_id AND sc.scope_key=d.acl->>'scope'
                AND sc.allowed))) AS allowed
        FROM documents d
        JOIN knowledge_sources src ON src.id=d.source_id
        LEFT JOIN document_versions v ON v.id=d.current_version_id
        WHERE d.id=${ev.chunk.document_id}`,
    store.db,
  );
  if (!doc || doc.deleted || doc.state !== 'READY') return 'deleted_or_unavailable';
  if (doc.dirty) return 'stale_pending';
  if (!doc.bound) return 'EVIDENCE_SUPERSEDED';
  if (!doc.allowed) return 'acl_revoked';
  if (doc.content_hash !== ev.revision) return 'EVIDENCE_CHANGED';
  const probe = ev.chunk.content.trim().slice(0, 80);
  if (probe && doc.text !== null && !doc.text.includes(probe)) return 'quote_missing';
  return null;
}

export interface AnswerDeps {
  store: KnowledgeStore;
  model: ChatModel;
  embeddings?: UpstageEmbeddings;
  discordRead?: DiscordLiveRead; // DISCORD_CONTEXT_ENABLED일 때만 주입
  userId?: string;
  acl?: AclInput; // 질문자 권한 — 후보 SQL·모델 입력·저장 답변에 동일 적용 (RAG-001)
}

export async function answerQuestion(
  deps: AnswerDeps,
  projectId: string,
  rawReq: z.input<typeof QuestionRequest>,
): Promise<Answer> {
  const req = QuestionRequest.parse(rawReq);
  const { store } = deps;
  const runId = crypto.randomUUID();
  const warnings: string[] = [];
  // 단계별 latency 계측 (RAG-019) — 실행 끝에 audit로 남긴다.
  const latency: Record<string, number> = {};
  const startedAt = Date.now();
  let stageAt = startedAt;
  const markStage = (name: string) => {
    const now = Date.now();
    latency[name] = now - stageAt;
    stageAt = now;
  };
  const setPhase = (phase: string, status = 'PENDING') =>
    sql`UPDATE answer_runs SET phase=${phase}, status=${status} WHERE id=${runId}`.execute(
      store.db,
    );
  await sql`
    INSERT INTO answer_runs(id, project_id, user_id, question, temporal_mode, as_of, phase)
    VALUES (${runId}, ${projectId}, ${deps.userId ?? ''}, ${req.question},
            ${req.temporal_mode}, ${req.as_of ?? null}, 'checking_sources')`.execute(store.db);

  try {
    // 단계 1-2: 출처 등록 상태 + Discord live read
    const sources = await sourceRows(store, projectId);
    const hasDiscord = sources.some((s) => s.kind === 'discord');
    await setPhase('reading_discord');
    let discordOk = true;
    const discordGaps: string[] = [];
    if (hasDiscord) {
      if (!deps.discordRead) {
        discordOk = false;
        discordGaps.push('discord_context_disabled');
        warnings.push('Discord 라이브 읽기가 비활성화되어 실시간 메시지를 확인하지 못했습니다.');
      } else {
        try {
          const r = await deps.discordRead(10_000);
          if (!r.ok) {
            discordOk = false;
            discordGaps.push(...r.gaps);
            warnings.push('Discord 라이브 읽기가 부분 실패했습니다.');
          }
        } catch {
          discordOk = false;
          discordGaps.push('live_refresh_timeout');
          warnings.push('Discord 라이브 읽기가 시간 초과되었습니다.');
        }
      }
    }

    markStage('discord_read');
    // 단계 5: 검색 — 질문자 ACL이 후보 SQL에 바인딩된다 (RAG-001).
    await setPhase('searching');
    const chunks = await retrieve(store, {
      projectId,
      query: req.question,
      embeddings: deps.embeddings,
      // Keep the evidence list focused. The answer model still receives all selected
      // evidence, but the UI should not present a fixed, noisy list for every question.
      limit: 8,
      acl: deps.acl,
    });
    markStage('search');
    const chunksBySource = new Map<string, RetrievedChunk[]>();
    for (const c of chunks)
      chunksBySource.set(c.source, [...(chunksBySource.get(c.source) ?? []), c]);

    // 단계 6: 생성 — evidence에 chunk id·revision(content_hash)·url 부여
    // revision은 검색 시점의 current content_hash — 모델 호출 *전*에 캡처해
    // 생성 중 원본이 바뀐 근거를 재검증에서 걸러낸다 (RAG-004).
    await setPhase('generating');
    const revisions = new Map<string, string>();
    for (const c of chunks) revisions.set(c.document_id, c.revision);
    const evidenceInput = chunks.map((c, i) => {
      const id = `e${i + 1}`;
      return { id, source: c.source, chunk: c.content.slice(0, 1200), stable_key: c.stable_key };
    });
    let modelOut: ModelOutput | null = null;
    let modelName = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    if (chunks.length) {
      const res = await deps.model.structured(
        ModelOutput as unknown as z.ZodType<ModelOutput>,
        { question: req.question, temporal_mode: req.temporal_mode, evidence: evidenceInput },
        ANSWER_SYSTEM,
      );
      modelOut = res.result;
      modelName = res.model;
      usage = res.usage ?? usage; // 실제 provider usage를 기록한다 (RAG-019)
    }
    markStage('generate');

    // 단계 8: 근거 재검증 — 캡처된 revision 대비 현재 상태 확인 (RAG-004).
    await setPhase('revalidating');
    const evidence: Answer['evidence'] = [];
    let evidenceFailed = false;
    for (const [i, c] of chunks.entries()) {
      const rev = revisions.get(c.document_id) ?? '';
      const reason = await revalidateEvidence(store, { chunk: c, revision: rev }, deps.acl);
      if (reason) {
        evidenceFailed = true;
        warnings.push(`근거가 응답 생성 중 변경/삭제되었습니다 (${c.stable_key}: ${reason}).`);
        continue;
      }
      evidence.push({
        id: `e${i + 1}`,
        source: c.source as any,
        document_id: c.document_id,
        revision: rev || 'unknown',
        url: stableKeyToUrl(c.stable_key, c.span),
        quote: c.content.slice(0, 500),
        observed_at: new Date().toISOString(),
        ...(Number.isInteger(c.span?.page_start) && c.span.page_start > 0 ? { page_start: c.span.page_start } : {}),
        ...(Number.isInteger(c.span?.page_end) && c.span.page_end > 0 ? { page_end: c.span.page_end } : {}),
        ...(Array.isArray(c.span?.block_ids) ? { block_ids: c.span.block_ids } : {}),
        ...(Array.isArray(c.span?.block_locations) ? { block_locations: c.span.block_locations } : {}),
        ...(c.span?.bbox ? { bbox: c.span.bbox } : {}),
        ...(c.span?.parser_version ? { parser_version: c.span.parser_version } : {}),
        ...(c.span?.source_sha256 ? { source_sha256: c.span.source_sha256 } : {}),
      });
    }
    const validIds = new Set(evidence.map((e) => e.id));

    // coverage — 네 출처 정확히 하나씩 (§13, RAG-003).
    // 소스의 실제 상태를 보고한다: ACCESS_LOST/DISABLED → FAILED,
    // 스코프 없음 → scope_complete=false, 대조 이력 없음/정체 → PARTIAL.
    // "등록만 됐다"고 LIVE_READ로 분류하지 않는다.
    const STALE_MS: Record<string, number> = {
      meeting: 3 * 60_000,
      notion: 45 * 60_000,
      github: 45 * 60_000,
      discord: 45 * 60_000,
    };
    const coverage: SourceCoverage[] = [];
    let coverageOk = true;
    for (const kind of SOURCES) {
      const src = sources.find((s) => s.kind === kind);
      if (!src) {
        coverage.push({
          source: kind,
          read_status: 'NOT_APPLICABLE',
          search_status: 'NOT_SEARCHED',
          scope_complete: true,
          last_reconciled_at: null,
          gaps: [],
        });
        continue;
      }
      const gaps: string[] = [];
      const lastAt = await lastReconciled(store, src.id);
      let read: SourceCoverage['read_status'] = 'LIVE_READ';
      let scopeComplete = true;
      if (src.status !== 'ACTIVE') {
        read = 'FAILED';
        gaps.push(`source_${src.status.toLowerCase()}`);
      }
      if (src.scopes === 0) {
        scopeComplete = false;
        gaps.push('no_allowed_scopes');
        if (read === 'LIVE_READ') read = 'PARTIAL';
      }
      if (read !== 'FAILED') {
        if (!lastAt) {
          read = 'PARTIAL';
          scopeComplete = false;
          gaps.push('never_reconciled');
        } else if (Date.now() - new Date(lastAt).getTime() > (STALE_MS[kind] ?? 45 * 60_000)) {
          read = 'PARTIAL';
          gaps.push('stale_index');
        }
      }
      if (kind === 'discord') {
        if (!discordOk) {
          read = 'PARTIAL';
          scopeComplete = false;
          gaps.push(...discordGaps);
        }
      }
      if (read !== 'LIVE_READ') coverageOk = false;
      coverage.push({
        source: kind,
        read_status: read,
        search_status: chunksBySource.has(kind) ? 'MATCH' : 'NO_MATCH',
        scope_complete: scopeComplete,
        last_reconciled_at: lastAt,
        gaps,
      });
    }

    // 상태 판정 (§13.1/§13.3) — 어느 출처든 읽기 실패/정체면 COMPLETE 불가.
    let status: AnswerStatus;
    if (!chunks.length) status = 'NEEDS_CLARIFICATION';
    else if (!modelOut) status = 'FAILED';
    else if (!coverageOk || evidenceFailed) status = 'PARTIAL';
    else status = 'COMPLETE';
    const claims = (modelOut?.claims ?? [])
      .map((c) => ({
        text: c.text,
        state: c.state as ClaimState,
        evidence_ids: c.evidence_ids.filter((id) => validIds.has(id)),
      }))
      .filter((c) => c.evidence_ids.length > 0);
    const conflicts = (modelOut?.conflicts ?? []).map((c) => ({
      text: c.text,
      evidence_ids: c.evidence_ids.filter((id) => validIds.has(id)),
    }));
    const answer: Answer = {
      answer_id: runId,
      status,
      answer:
        modelOut?.answer ??
        (status === 'NEEDS_CLARIFICATION'
          ? '프로젝트 자료에서 해당 질문의 근거를 찾지 못했습니다.'
          : ''),
      checked_at: new Date().toISOString(),
      temporal_mode: req.temporal_mode,
      claims,
      evidence,
      source_coverage: coverage,
      conflicts,
      warnings: [...(modelOut?.warnings ?? []), ...warnings],
      model: modelName || 'none',
      corpus_generation: await corpusGeneration(store, projectId),
      usage,
    };

    markStage('revalidate');
    latency.total = Date.now() - startedAt;
    // 검증 완료된 Answer만 body에 기록 + 근거 정규 저장 (§10)
    await sql`
      UPDATE answer_runs SET status=${status}, phase=${status === 'COMPLETE' ? 'complete' : status === 'FAILED' ? 'failed' : 'partial'},
        body=${JSON.stringify(answer)}::jsonb, model=${answer.model},
        corpus_generation=${answer.corpus_generation}, checked_at=now()
      WHERE id=${runId}`.execute(store.db);
    // 단계별 latency + usage를 audit로 남긴다 (RAG-019) — 스키마가 strict라
    // Answer body엔 넣지 못하므로 실행 단위 계측은 여기에 둔다.
    await sql`
      INSERT INTO knowledge_audit(id, project_id, actor, kind, data)
      VALUES (${crypto.randomUUID()}, ${projectId}, ${deps.userId ?? 'system'},
        'ANSWER_RUN',
        ${JSON.stringify({
          run_id: runId,
          status,
          latency_ms: latency,
          usage,
          model: answer.model,
          chunks: chunks.length,
        })}::jsonb)`.execute(store.db);
    for (const e of evidence)
      await sql`
        INSERT INTO answer_evidence(answer_run_id, document_id, source, url, quote, observed_at)
        VALUES (${runId}, ${e.document_id}, ${e.source}, ${e.url}, ${e.quote}, ${e.observed_at})
        ON CONFLICT DO NOTHING`.execute(store.db);
    return answer;
  } catch (err) {
    await sql`
      UPDATE answer_runs SET status='FAILED', phase='failed'
      WHERE id=${runId}`.execute(store.db);
    throw err;
  }
}
