import { KnowledgeStore, sql, rows } from '@meeting/knowledge-db';
import { UpstageEmbeddings, activeProfile } from './embeddings.ts';

// 검색 — spec §11.1 단계 5: 출처별 키워드/벡터 후보 → ACL/current 필터 → dedupe/RRF.
// ACL-first: 활성 chunk_set + 비삭제 + READY 문서만 대상으로 한다.

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  stable_key: string;
  source: string;
  content: string;
  span: Record<string, any>;
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
}

const baseFrom = (projectId: string) => sql`
  FROM chunks c
  JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
  JOIN documents d ON d.id=s.document_id
  JOIN knowledge_sources src ON src.id=d.source_id AND src.project_id=${projectId}
  WHERE NOT d.deleted AND d.state='READY' AND NOT d.dirty`;

/** 키워드 후보: pg_trgm 유사도 + 코드 식별자 정확 매칭 결합 (§10/R09). */
export async function keywordSearch(
  store: KnowledgeStore,
  projectId: string,
  query: string,
  limit = 30,
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
          c.content, c.span,
          similarity(c.content, ${q})
            + COALESCE((SELECT max(CASE WHEN c.content LIKE '%' || w.word || '%' THEN 0.5 ELSE 0 END)
                        FROM unnest(${ident}::text[]) AS w(word)), 0) AS kw
        ${baseFrom(projectId)}
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
) {
  const profile = await activeProfile(store);
  if (!profile) return [];
  const vec = await client.embedQuery(query);
  const lit = `[${vec.join(',')}]`;
  return rows<ChunkRow & { dist: number }>(
    sql`SELECT c.id AS chunk_id, d.id AS document_id, d.stable_key, src.kind AS source,
          c.content, c.span,
          (e.embedding <=> ${lit}::vector) AS dist
        FROM chunks c
        JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
        JOIN documents d ON d.id=s.document_id
        JOIN knowledge_sources src ON src.id=d.source_id AND src.project_id=${projectId}
        JOIN chunk_embeddings e ON e.chunk_id=c.id AND e.profile_id=${profile.id}
        WHERE NOT d.deleted AND d.state='READY' AND NOT d.dirty
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
  },
) {
  const per = opts.perSourceLimit ?? 30;
  const kw = await keywordSearch(store, opts.projectId, opts.query, per);
  const vec = opts.embeddings
    ? await vectorSearch(store, opts.embeddings, opts.projectId, opts.query, per)
    : [];
  const merged = rrfMerge([
    kw.map((c) => ({ id: c.chunk_id, row: c as ChunkRow })),
    vec.map((c) => ({ id: c.chunk_id, row: c as ChunkRow })),
  ]);
  const byId = new Map<string, ChunkRow>();
  for (const c of [...kw, ...vec]) if (!byId.has(c.chunk_id)) byId.set(c.chunk_id, c);
  return merged.slice(0, opts.limit ?? 40).map((m): RetrievedChunk => {
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
    };
  });
}
