import { KnowledgeStore, sql, rows } from '@meeting/knowledge-db';
import { UpstageEmbeddings, activeProfile } from './embeddings.ts';

// 검색 — spec §11.1 단계 5: 출처별 키워드/벡터 후보 → ACL/current 필터 → dedupe/RRF.
// ACL-first (RAG-001): source가 ACTIVE이고 문서 acl.scope가 allowed scope에
// 매칭되며 guild 바인딩이 질문자 guild와 일치하는 문서만 후보가 된다.
// 버전 결속 (RAG-006): chunk_set.version_id = current_version_id인 청크만 대상.

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  stable_key: string;
  source: string;
  content: string;
  span: Record<string, any>;
  /** 후보 추출 시점의 current content_hash — 생성 전 캡처해 재검증 기준으로 쓴다 (RAG-004). */
  revision: string;
  /** 출처별 revision 문자열 (github는 `<head>:<blobSha>`) — permalink 복원용. */
  source_revision: string | null;
  /** 원본 발생/수정 시각 + 수집 시각 — "최신" 판단과 화면 표시에 쓴다. */
  occurred_at: string | null;
  modified_at: string | null;
  indexed_at: string | null;
  /** 문서 metadata (github: repo/ref/path/head, meeting: title 등). */
  metadata: Record<string, any> | null;
  score: number;
  keyword_rank: number | null;
  vector_rank: number | null;
}

const RRF_K = 60;

/** Reciprocal Rank Fusion — 각 목록의 rank를 점수로 환산해 합산한다. */
export function rrfMerge<T extends { id: string }>(lists: T[][], k = RRF_K) {
  const acc = new Map<string, { item: T; score: number; ranks: (number | null)[] }>();
  lists.forEach((list, li) =>
    list.forEach((item, rank) => {
      const cur = acc.get(item.id) ?? { item, score: 0, ranks: lists.map(() => null) };
      cur.score += 1 / (k + rank + 1);
      cur.ranks[li] = rank + 1;
      acc.set(item.id, cur);
    }),
  );
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.item, score: x.score, ranks: x.ranks }));
}

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  stable_key: string;
  source: string;
  content: string;
  span: any;
  revision: string;
  source_revision: string | null;
  occurred_at: Date | string | null;
  modified_at: Date | string | null;
  indexed_at: Date | string | null;
  metadata: Record<string, any> | null;
}

const iso = (v: Date | string | null | undefined) =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/**
 * 출처별 최소 커버리지 (RAG-019): 한 출처가 후보를 독점하지 않도록
 * 결과가 있는 출처끼리 limit를 균등 배당하고, 남는 자리는 순위대로 채운다.
 * 순수 함수 — 단위 테스트 가능하도록 분리.
 */
export function perSourceQuota<T extends { id: string }>(
  merged: T[],
  sourceOf: (item: T) => string,
  limit: number,
): T[] {
  const present = [...new Set(merged.map(sourceOf))];
  const quota = Math.max(1, Math.floor(limit / Math.max(1, present.length)));
  const counts = new Map<string, number>();
  const taken = new Set<string>();
  const ordered: T[] = [];
  for (const m of merged) {
    const s = sourceOf(m);
    if ((counts.get(s) ?? 0) < quota) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
      taken.add(m.id);
      ordered.push(m);
    }
  }
  for (const m of merged) {
    if (ordered.length >= limit) break;
    if (!taken.has(m.id)) ordered.push(m);
  }
  return ordered.slice(0, limit);
}

/** 질문자 권한 — OAuth guild 멤버십에서 도출된 guild id 목록. */
export interface AclInput {
  guilds: string[];
}

/** ACL + 버전 결속 + 가용성 조건. 모든 검색 경로가 공유한다 (RAG-001/RAG-006). */
const aclClause = (acl?: AclInput) => sql`
  AND src.status='ACTIVE'
  AND s.version_id = d.current_version_id
  AND (
    ${!acl || !acl.guilds.length}
    OR d.acl->>'guild' IS NULL
    OR d.acl->>'guild' = ANY(${acl?.guilds ?? []}::text[])
  )
  AND (
    d.acl->>'scope' IS NULL
    OR EXISTS (SELECT 1 FROM source_scopes sc
               WHERE sc.source_id=d.source_id
                 AND sc.scope_key=d.acl->>'scope' AND sc.allowed)
  )`;

const baseFrom = (projectId: string, acl?: AclInput) => sql`
  FROM chunks c
  JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
  JOIN documents d ON d.id=s.document_id
    AND s.version_id = d.current_version_id
  JOIN document_versions v ON v.id=d.current_version_id
  JOIN knowledge_sources src ON src.id=d.source_id AND src.project_id=${projectId}
  WHERE NOT d.deleted AND d.state='READY' AND NOT d.dirty ${aclClause(acl)}`;

const QUESTION_STOPWORDS = new Set([
  '지금', '현재', '어디', '어디에', '어디서', '어디야', '있음', '있어', '있어요', '있나요', '있는지', '있나',
  '뭐', '뭐야', '뭔가', '무엇', '무슨', '어떤', '어떻게', '언제', '누가', '누구', '왜', '좀', '그', '이', '저',
  '알려줘', '알려', '줘', '해줘', '보여줘', '찾아줘', '확인', '관련', '대한', '대해', '그리고', '혹시', '우리',
  'the', 'and', 'for', 'what', 'where', 'how', 'which', 'with',
]);
const PARTICLE = /(?:으로|에서|에게|한테|까지|부터|이랑|하고|처럼|말고|이나|이야|이에요|예요|이랑|은|는|이|가|을|를|에|의|도|로|와|과|만|랑|요)$/;

/**
 * 질문에서 키워드 검색어를 뽑는다. 따옴표로 감싼 말은 가중치 2.
 * pg_trgm 유사도는 긴 질문 전체와 짧은 청크를 비교해 한국어 단어 하나("소녀")로는
 * 후보에 오르지 못했다. 단어 단위로도 맞춰 본다.
 */
export function queryTerms(query: string): { term: string; weight: number }[] {
  const out = new Map<string, number>();
  for (const m of query.matchAll(/["“”'‘’「」『』]([^"“”'‘’「」『』]{1,40})["“”'‘’「」『』]/g)) {
    const t = m[1].trim();
    if (t.length >= 2 || /[가-힣]/.test(t)) out.set(t.toLowerCase(), 2);
  }
  for (const raw of query.split(/[\s"“”'‘’「」『』()[\]{}<>?!.,~:;\/·]+/)) {
    let t = raw.trim().toLowerCase();
    if (!t) continue;
    // "메인캐릭터말고", "주인공 빼고"처럼 빼 달라는 말은 검색어로 쓰지 않는다.
    if (/(?:말고|빼고|제외)$/.test(t)) continue;
    if (/[가-힣]/.test(t)) {
      const stripped = t.replace(PARTICLE, '');
      if (stripped.length >= 2) t = stripped;
      if (t.length < 2) continue;
    } else if (t.length < 3) continue;
    if (QUESTION_STOPWORDS.has(t) || out.has(t)) continue;
    out.set(t, 1);
  }
  return [...out.entries()].slice(0, 8).map(([term, weight]) => ({ term, weight }));
}

/** 키워드 후보: pg_trgm 유사도 + 코드 식별자 정확 매칭 + 질문 단어 매칭 (§10/R09). */
export async function keywordSearch(
  store: KnowledgeStore,
  projectId: string,
  query: string,
  limit = 30,
  acl?: AclInput,
) {
  const q = query.trim();
  if (!q) return [];
  const ident = q
    .split(/\s+/)
    .filter((w) => /[\w:]/.test(w) && (/[A-Z_]|::|\.[a-z]/.test(w) || /^[\w:]+$/.test(w)))
    .slice(0, 4);
  const identOr = ident.length
    ? sql`OR c.content ILIKE ANY (SELECT '%' || w.word || '%' FROM unnest(${ident}::text[]) AS w(word))`
    : sql``;
  const terms = queryTerms(q);
  const termWords = terms.map((t) => t.term.replace(/[%_\\]/g, ''));
  const termWeights = terms.map((t) => t.weight);
  const totalWeight = termWeights.reduce((a, b) => a + b, 0) || 1;
  const termOr = terms.length
    ? sql`OR c.content ILIKE ANY (SELECT '%' || w || '%' FROM unnest(${termWords}::text[]) AS w)`
    : sql``;
  // 질문 단어가 많이 겹칠수록 위로. 유사도(0~1)와 같은 척도로 맞춘다.
  const termScore = terms.length
    ? sql`(SELECT coalesce(sum(t.weight), 0) FROM unnest(${termWords}::text[], ${termWeights}::int[]) AS t(word, weight)
            WHERE c.content ILIKE '%' || t.word || '%')::float / ${totalWeight}`
    : sql`0`;
  return rows<ChunkRow & { kw: number }>(
    sql`SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span, v.content_hash AS revision, v.source_revision,
          v.source_occurred_at AS occurred_at, v.source_modified_at AS modified_at,
          d.created_at AS indexed_at, d.metadata,
          similarity(c.content, ${q}) + ${termScore} AS kw
        ${baseFrom(projectId, acl)}
          AND (c.content % ${q} ${identOr} ${termOr})
        ORDER BY kw DESC LIMIT ${limit}`,
    store.db,
  );
}

/**
 * 최신 문서 보강 (QA 10-12): "최근/마지막" 질문에서 최신 문서가
 * 유사도 순위 밖이면 근거에서 누락된다. 소스별 최신 문서의 앞쪽
 * 청크를 항상 후보에 추가해 모델이 최신 시각을 비교할 수 있게 한다.
 */
export async function recentSearch(
  store: KnowledgeStore,
  projectId: string,
  chunksPerDoc = 2,
  acl?: AclInput,
) {
  return rows<ChunkRow>(
    sql`WITH newest AS (
          SELECT DISTINCT ON (src.kind) d.id AS document_id
          FROM documents d
          JOIN chunk_sets s ON s.document_id=d.id AND s.active
            AND s.version_id = d.current_version_id
          JOIN document_versions v ON v.id=d.current_version_id
          JOIN knowledge_sources src ON src.id=d.source_id AND src.project_id=${projectId}
          WHERE NOT d.deleted AND d.state='READY' AND NOT d.dirty ${aclClause(acl)}
          ORDER BY src.kind,
            coalesce(v.source_modified_at, v.source_occurred_at, d.updated_at) DESC
        )
        SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span, v.content_hash AS revision, v.source_revision,
          v.source_occurred_at AS occurred_at, v.source_modified_at AS modified_at,
          d.created_at AS indexed_at, d.metadata
        FROM newest n
        JOIN chunk_sets s ON s.document_id=n.document_id AND s.active
        JOIN chunks c ON c.chunk_set_id=s.id AND c.ordinal < ${chunksPerDoc}
        JOIN documents d ON d.id=n.document_id
        JOIN document_versions v ON v.id=d.current_version_id
        JOIN knowledge_sources src ON src.id=d.source_id
        ORDER BY coalesce(v.source_modified_at, v.source_occurred_at, d.updated_at) DESC`,
    store.db,
  );
}

/** 벡터 후보: 활성 profile의 cosine 거리. */
export async function vectorSearch(
  store: KnowledgeStore,
  client: UpstageEmbeddings,
  projectId: string,
  query: string,
  limit = 30,
  acl?: AclInput,
) {
  const profile = await activeProfile(store);
  if (!profile) return [];
  const vec = await client.embedQuery(query);
  const lit = `[${vec.join(',')}]`;
  return rows<ChunkRow & { dist: number }>(
    sql`SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span, v.content_hash AS revision, v.source_revision,
          v.source_occurred_at AS occurred_at, v.source_modified_at AS modified_at,
          d.created_at AS indexed_at, d.metadata,
          (e.embedding <=> ${lit}::vector) AS dist
        FROM chunks c
        JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
        JOIN documents d ON d.id=s.document_id
          AND s.version_id = d.current_version_id
        JOIN document_versions v ON v.id=d.current_version_id
        JOIN knowledge_sources src ON src.id=d.source_id AND src.project_id=${projectId}
        JOIN chunk_embeddings e ON e.chunk_id=c.id AND e.profile_id=${profile.id}
        WHERE NOT d.deleted AND d.state='READY' AND NOT d.dirty ${aclClause(acl)}
        ORDER BY dist ASC LIMIT ${limit}`,
    store.db,
  );
}

/** 질문에 이름이 그대로 적힌 파일 — "화풍레퍼런스2.jpg", "기획서.pdf". */
export function namedFiles(query: string) {
  const out = new Set<string>();
  for (const m of query.matchAll(/[\p{L}\p{N}_()\-]+(?: [\p{L}\p{N}_()\-]+)*\.(?:png|jpe?g|webp|gif|pdf|docx?|txt|md|hwpx?|xlsx?|pptx?)\b/giu))
  {
    // 앞 단어까지 붙어 잡힐 수 있으므로("그거 girl image.png") 뒤쪽 부분들도 후보로 둔다.
    const words = m[0].normalize('NFC').split(' ');
    for (let i = 0; i < words.length; i++) out.add(words.slice(i).join(' '));
  }
  return [...out].slice(0, 20);
}

/**
 * 질문이 이름으로 지목한 업로드 파일의 청크. 출처별 상한(perSourceQuota) 때문에
 * "A.jpg와 B.jpg"처럼 두 파일을 함께 물으면 하나가 빠졌다. 지목한 파일은 상한 밖에서 먼저 넣는다.
 */
async function namedFileSearch(store: KnowledgeStore, projectId: string, names: string[], acl?: AclInput) {
  if (!names.length) return [];
  const lowered = names.map((n) => n.toLowerCase());
  return rows<ChunkRow>(
    sql`SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span, v.content_hash AS revision, v.source_revision,
          v.source_occurred_at AS occurred_at, v.source_modified_at AS modified_at,
          d.created_at AS indexed_at, d.metadata
        ${baseFrom(projectId, acl)}
          AND src.kind = 'upload' AND c.ordinal < 2
          AND lower(normalize(d.metadata->>'filename', NFC)) = ANY(${lowered}::text[])
        ORDER BY d.metadata->>'filename', c.ordinal LIMIT 20`,
    store.db,
  );
}

/**
 * 하이브리드 검색 — 키워드+벡터 후보를 RRF로 합친다.
 * 출처별 상한은 호출자가 정한다 (기본 각 30개, §11.1).
 */
export async function retrieve(
  store: KnowledgeStore,
  opts: {
    projectId: string;
    query: string;
    embeddings?: UpstageEmbeddings;
    perSourceLimit?: number;
    limit?: number;
    acl?: AclInput;
  },
) {
  const per = opts.perSourceLimit ?? 30;
  const kw = await keywordSearch(store, opts.projectId, opts.query, per, opts.acl);
  const vec = opts.embeddings
    ? await vectorSearch(store, opts.embeddings, opts.projectId, opts.query, per, opts.acl)
    : [];
  const merged = rrfMerge([
    kw.map((c) => ({ id: c.chunk_id, row: c as ChunkRow })),
    vec.map((c) => ({ id: c.chunk_id, row: c as ChunkRow })),
  ]);
  const named = await namedFileSearch(store, opts.projectId, namedFiles(opts.query), opts.acl);
  const byId = new Map<string, ChunkRow>();
  for (const c of [...named, ...kw, ...vec]) if (!byId.has(c.chunk_id)) byId.set(c.chunk_id, c);
  const pinned = named.map((c) => ({ id: c.chunk_id, score: 1, ranks: [null, null] as (number | null)[] }));
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const ordered = [
    ...pinned,
    ...perSourceQuota(merged.filter((m) => !pinnedIds.has(m.id)), (m) => byId.get(m.id)!.source, Math.max(0, (opts.limit ?? 40) - pinned.length)),
  ];
  const seen = new Set(ordered.map((m) => m.id));
  const recent = (await recentSearch(store, opts.projectId, 2, opts.acl)).filter(
    (r) => !seen.has(r.chunk_id),
  );
  for (const r of recent) byId.set(r.chunk_id, r);
  const tail = recent.map(
    (r): { id: string; score: number; ranks: (number | null)[] } => ({
      id: r.chunk_id,
      score: 0,
      ranks: [],
    }),
  );
  return [...ordered, ...tail].map((m): RetrievedChunk => {
    const r = byId.get(m.id)!;
    return {
      chunk_id: m.id,
      document_id: r.document_id,
      stable_key: r.stable_key,
      source: r.source,
      content: r.content,
      span: r.span,
      score: m.score,
      keyword_rank: m.ranks[0] ?? null,
      vector_rank: m.ranks[1] ?? null,
      revision: r.revision,
      source_revision: r.source_revision,
      occurred_at: iso(r.occurred_at),
      modified_at: iso(r.modified_at),
      indexed_at: iso(r.indexed_at),
      metadata: r.metadata ?? null,
    };
  });
}
