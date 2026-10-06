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
}

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

/** 키워드 후보: pg_trgm 유사도 + 코드 식별자 정확 매칭 결합 (§10/R09). */
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
  return rows<ChunkRow & { kw: number }>(
    sql`SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span, v.content_hash AS revision
        ${baseFrom(projectId, acl)}
          AND (c.content % ${q} ${identOr})
        ORDER BY kw DESC LIMIT ${limit}`,
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
          c.content, c.span, v.content_hash AS revision,
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
  const byId = new Map<string, ChunkRow>();
  for (const c of [...kw, ...vec]) if (!byId.has(c.chunk_id)) byId.set(c.chunk_id, c);
  const ordered = perSourceQuota(merged, (m) => byId.get(m.id)!.source, opts.limit ?? 40);
  return ordered.map((m): RetrievedChunk => {
    const r = byId.get(m.id)!;
    return {
      chunk_id: m.id,
      document_id: r.document_id,
      stable_key: r.stable_key,
      source: r.source,
      content: r.content,
      span: r.span,
      score: m.score,
      keyword_rank: m.ranks[0],
      vector_rank: m.ranks[1],
      revision: r.revision,
    };
  });
}
