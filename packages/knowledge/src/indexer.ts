import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';
import { chunkDocument } from './chunk.ts';
import { UpstageEmbeddings, activeProfile, indexMissingEmbeddings } from './embeddings.ts';

// 추출/인덱싱 워커 — publish된 current 버전을 청크로 만들고 비활성 set에 채운 뒤
// swapChunkSet으로 원자 공개한다 (§8.1). 임베딩은 활성 profile 단위.

export const EXTRACTOR_VERSION = 1;

const CONTENT_MAX = 256 * 1024;

/** publish 성공 직후 호출 — 같은 content_hash의 재추출은 job key로 dedupe된다. */
export async function queueExtract(store: KnowledgeStore, documentId: string, contentHash: string) {
  await store.enqueueJob(`extract:${documentId}:${contentHash}`, 'extract', {
    document_id: documentId,
    content_hash: contentHash,
  });
}

/** 문서의 current 버전 → 청크 set 생성→삽입→활성화. */
export async function extractDocument(store: KnowledgeStore, documentId: string) {
  const doc = await first<{
    id: string;
    stable_key: string;
    kind: string;
    normalized: any;
  }>(
    sql`SELECT d.id, d.stable_key, src.kind, v.normalized
        FROM documents d
        JOIN knowledge_sources src ON src.id=d.source_id
        JOIN document_versions v ON v.id=d.current_version_id
        WHERE d.id=${documentId} AND d.state='READY' AND NOT d.deleted`,
    store.db,
  );
  if (!doc) return { skipped: 'not_ready' } as const;
  const chunks = chunkDocument(doc.kind, doc.stable_key, doc.normalized);
  if (!chunks.length) return { skipped: 'empty' } as const;
  const oversized = chunks.find((c) => c.content.length > CONTENT_MAX);
  if (oversized) return { skipped: 'oversize_chunk' } as const;
  const setId = await store.createChunkSet(doc.id, EXTRACTOR_VERSION);
  await store.insertChunks(setId, chunks);
  await store.swapChunkSet(doc.id, setId);
  await store.enqueueJob(`index:${doc.id}:${setId}`, 'index', { document_id: doc.id });
  return { document_id: doc.id, chunk_set_id: setId, chunks: chunks.length } as const;
}

/**
 * 지식 워커 루프 1회 — 'extract' 잡은 문서를 청크하고, 'index' 잡은 활성 profile의
 * 누락 임베딩을 채운다. owner는 잡 fencing 식별자.
 */
export async function indexerTick(
  store: KnowledgeStore,
  owner: string,
  opts?: { embeddings?: UpstageEmbeddings; extractLimit?: number; embedLimit?: number },
) {
  const done = { extracted: 0, embedded: 0, failed: 0 };
  const jobs = await store.claimJobs(owner, ['extract', 'index'], opts?.extractLimit ?? 8, 60_000);
  for (const job of jobs) {
    try {
      if (job.kind === 'extract') {
        const r = await extractDocument(store, job.payload.document_id);
        if ('skipped' in r) await store.finishJob(job, 'DONE', r.skipped);
        else {
          done.extracted++;
          await store.finishJob(job, 'DONE');
        }
      } else {
        if (!opts?.embeddings) {
          await store.retryJob(job, new Date(Date.now() + 60_000), 'EMBEDDINGS_NOT_CONFIGURED');
          continue;
        }
        const profile = await activeProfile(store);
        if (!profile) {
          await store.retryJob(job, new Date(Date.now() + 60_000), 'INDEX_NOT_READY');
          continue;
        }
        const r = await indexMissingEmbeddings(store, opts.embeddings, profile.id, {
          limit: opts?.embedLimit ?? 256,
        });
        done.embedded += r.indexed;
        await store.finishJob(job, 'DONE');
      }
    } catch (err) {
      done.failed++;
      const retryable = job.attempts < 5;
      const backoff = new Date(Date.now() + Math.min(2 ** job.attempts, 64) * 1000);
      if (retryable) await store.retryJob(job, backoff, (err as Error).message.slice(0, 200));
      else await store.finishJob(job, 'DEAD_LETTER', (err as Error).message.slice(0, 200));
    }
  }
  return done;
}

/** 지속 워커 루프 — pollInterval마다 indexerTick. */
export async function runIndexer(
  store: KnowledgeStore,
  opts: {
    owner: string;
    embeddings?: UpstageEmbeddings;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  },
) {
  const interval = opts.pollIntervalMs ?? 5_000;
  while (!opts.signal?.aborted) {
    const r = await indexerTick(store, opts.owner, { embeddings: opts.embeddings });
    if (!r.extracted && !r.embedded) await new Promise((res) => setTimeout(res, interval));
  }
}
