import { KnowledgeStore, sql, first, rows } from '@meeting/knowledge-db';

// Upstage Text Embedding 어댑터 — C05 실측: embedding-query/embedding-passage, 4096차원.
// 구/신 모델 vector를 섞어 검색하지 않으므로 profile 단위로 저장한다 (§10).

export class UpstageEmbeddings {
  constructor(
    private readonly apiKey: string,
    private readonly queryModel = 'embedding-query',
    private readonly documentModel = 'embedding-passage',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async call(model: string, input: string | string[]) {
    const res = await this.fetchImpl('https://api.upstage.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`upstage embeddings ${res.status}: ${JSON.stringify(body)}`);
    return body.data.map((d: any) => d.embedding as number[]);
  }
  embedQuery(text: string) {
    return this.call(this.queryModel, text).then((v) => v[0]);
  }
  embedDocuments(texts: string[]) {
    return this.call(this.documentModel, texts);
  }
}

/** 활성 임베딩 profile 조회 — provider당 하나. */
export async function activeProfile(store: KnowledgeStore, provider = 'upstage') {
  return first<{ id: string; query_model: string; document_model: string; dimensions: number }>(
    sql`SELECT id, query_model, document_model, dimensions FROM embedding_profiles
        WHERE provider=${provider} AND active`,
    store.db,
  );
}

/** 모델 변경은 새 profile로 재색인 — 이전 profile의 vector는 비활성화해 섞지 않는다 (§10). */
export async function ensureProfile(
  store: KnowledgeStore,
  provider: string,
  queryModel: string,
  documentModel: string,
  dimensions: number,
) {
  const existing = await activeProfile(store, provider);
  if (
    existing &&
    existing.query_model === queryModel &&
    existing.document_model === documentModel &&
    existing.dimensions === dimensions
  )
    return existing.id;
  const id = crypto.randomUUID();
  await store.db.transaction().execute(async (tx) => {
    await sql`UPDATE embedding_profiles SET active=false WHERE provider=${provider}`.execute(tx);
    await sql`
      INSERT INTO embedding_profiles(id, provider, query_model, document_model, dimensions, active)
      VALUES (${id}, ${provider}, ${queryModel}, ${documentModel}, ${dimensions}, true)`.execute(tx);
  });
  return id;
}

/** 활성 청크 중 해당 profile vector가 없는 것을 배치로 채운다. */
export async function indexMissingEmbeddings(
  store: KnowledgeStore,
  client: UpstageEmbeddings,
  profileId: string,
  opts?: { batchSize?: number; limit?: number },
) {
  const batch = opts?.batchSize ?? 32;
  const limit = opts?.limit ?? 512;
  const pending = await rows<{ id: string; content: string }>(
    sql`SELECT c.id, c.content FROM chunks c
        JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
        WHERE NOT EXISTS (
          SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=c.id AND e.profile_id=${profileId})
        ORDER BY c.id LIMIT ${limit}`,
    store.db,
  );
  let indexed = 0;
  for (let i = 0; i < pending.length; i += batch) {
    const slice = pending.slice(i, i + batch);
    const vectors = await client.embedDocuments(slice.map((c) => c.content));
    for (let j = 0; j < slice.length; j++) {
      const lit = `[${vectors[j].join(',')}]`;
      await sql`
        INSERT INTO chunk_embeddings(chunk_id, profile_id, embedding)
        VALUES (${slice[j].id}, ${profileId}, ${lit}::vector)
        ON CONFLICT (chunk_id, profile_id) DO NOTHING`.execute(store.db);
    }
    indexed += slice.length;
  }
  return { indexed, pending: pending.length };
}
