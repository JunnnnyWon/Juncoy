import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction, type RawBuilder } from 'kysely';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DocumentState,
  KnowledgeJobKind,
  KnowledgeJobStatus,
} from '@meeting/contracts';

export { sql } from 'kysely';
export type Database = Record<string, never>;
export type Conn = Kysely<Database> | Transaction<Database>;
export const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
export const rows = async <T>(q: RawBuilder<T>, db: Conn) => (await q.execute(db)).rows;
export const first = async <T>(q: RawBuilder<T>, db: Conn) => (await rows(q, db))[0];

export interface KnowledgeJob {
  id: string;
  key: string;
  kind: KnowledgeJobKind;
  document_id: string | null;
  payload: Record<string, any>;
  attempts: number;
  generation: number;
}

const MIGRATION_LOCK = 736121113;

export class KnowledgeStore {
  readonly db: Kysely<Database>;
  private readonly pool: Pool;
  constructor(url: string, opts?: { max?: number }) {
    this.pool = new Pool({ connectionString: url, max: opts?.max ?? 4 });
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }
  async close() {
    // Kysely.destroy()가 이미 pool.end()를 호출한다 — 두 번 end하면 pg가 throw.
    await this.db.destroy();
  }

  // 자체 migration 디렉터리 — 회의 DB와 별도 스키마/라이프사이클.
  async migrate() {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(
      this.db,
    );
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
    for (const name of (await readdir(dir)).filter((n) => /^\d+_.*\.sql$/.test(n)).sort())
      await this.db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`.execute(tx);
        if ((await rows(sql`SELECT name FROM schema_migrations WHERE name=${name}`, tx)).length)
          return;
        await sql.raw(await readFile(resolve(dir, name), 'utf8')).execute(tx);
        await sql`INSERT INTO schema_migrations(name) VALUES(${name})`.execute(tx);
      });
  }

  // ── §8.1 이벤트 수신: delivery ID dedupe + 내구 저장 ──────────────
  /** 신규 이벤트면 event id, 중복이면 null. */
  async recordSourceEvent(
    sourceId: string,
    eventKey: string,
    kind: string,
    body: Record<string, any>,
  ): Promise<string | null> {
    const id = randomUUID();
    const hit = await first(
      sql<{ id: string }>`
        INSERT INTO source_events(id, source_id, event_key, kind, body)
        VALUES (${id}, ${sourceId}, ${eventKey}, ${kind}, ${json(body)})
        ON CONFLICT (source_id, event_key) DO NOTHING
        RETURNING id`,
      this.db,
    );
    return hit?.id ?? null;
  }
  async markEventProcessed(sourceId: string, eventKey: string, status = 'PROCESSED') {
    await sql`
      UPDATE source_events SET status=${status}, processed_at=now()
      WHERE source_id=${sourceId} AND event_key=${eventKey}`.execute(this.db);
  }

  // ── 작업 큐: lease + generation fencing (§8.1) ────────────────────
  async enqueueJob(
    key: string,
    kind: KnowledgeJobKind,
    payload: Record<string, any>,
    opts?: { documentId?: string; dueAt?: Date },
  ) {
    await sql`
      INSERT INTO knowledge_jobs(id, key, kind, document_id, payload, due_at)
      VALUES (${randomUUID()}, ${key}, ${kind}, ${opts?.documentId ?? null}, ${json(payload)},
              ${opts?.dueAt ?? null})
      ON CONFLICT (key) DO NOTHING`.execute(this.db);
  }
  /** 늦게 도착한 이전 세대 worker 결과가 current를 덮어쓰지 못하게 generation을 올린다. */
  async claimJobs(owner: string, kinds: KnowledgeJobKind[], limit: number, leaseMs: number) {
    return rows<KnowledgeJob>(
      sql<KnowledgeJob>`
        UPDATE knowledge_jobs SET
          status='RUNNING', owner=${owner}, generation=generation+1,
          lease_until=now() + ${leaseMs} * interval '1 millisecond',
          attempts=attempts+1
        WHERE id IN (
          SELECT id FROM knowledge_jobs
          WHERE status IN ('PENDING','RETRYABLE') AND due_at <= now() AND kind = ANY(${kinds})
          ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING id, key, kind, document_id, payload, attempts, generation`,
      this.db,
    );
  }
  async finishJob(job: KnowledgeJob, status: KnowledgeJobStatus, errorCode?: string) {
    // claim 이후 generation이 바뀐 잡(재claim/리셋)은 완료 쓰기를 거부한다.
    await sql`
      UPDATE knowledge_jobs SET status=${status}, owner=null, lease_until=null,
        error_code=${errorCode ?? null}
      WHERE id=${job.id} AND generation=${job.generation}`.execute(this.db);
  }
  async retryJob(job: KnowledgeJob, dueAt: Date, errorCode?: string) {
    await sql`
      UPDATE knowledge_jobs SET status='RETRYABLE', owner=null, lease_until=null,
        due_at=${dueAt}, error_code=${errorCode ?? null}
      WHERE id=${job.id} AND generation=${job.generation}`.execute(this.db);
  }

  // ── 문서/버전: dirty 표시와 current 전환 분리 (§8.1) ──────────────
  /**
   * 원본 변경을 알게 되는 즉시 호출. tombstone이 있으면 새 문서로 부활시키지 않고
   * false를 반환한다 — 복원은 원본의 새 fetch 버전을 통해서만 가능하다.
   */
  async markDocumentDirty(
    sourceId: string,
    stableKey: string,
    metadata: Record<string, any> = {},
  ): Promise<boolean> {
    const tomb = await first(
      sql`SELECT stable_key FROM deletion_tombstones WHERE stable_key=${stableKey}`,
      this.db,
    );
    if (tomb) return false;
    await sql`
      INSERT INTO documents(id, source_id, stable_key, metadata)
      VALUES (${randomUUID()}, ${sourceId}, ${stableKey}, ${json(metadata)})
      ON CONFLICT (source_id, stable_key) DO UPDATE
        SET dirty=true, updated_at=now(),
            metadata=documents.metadata || EXCLUDED.metadata,
            state=CASE WHEN documents.state='UNAVAILABLE' THEN documents.state
                       ELSE 'FETCH_PENDING' END`.execute(this.db);
    return true;
  }

  /**
   * fetch→normalize 끝난 결과를 current로 공개. 작업 시작 시점과 원본이 달라졌거나
   * tombstoned/deleted면 공개하지 않고 false.
   */
  async publishVersion(
    docId: string,
    version: {
      contentHash: string;
      sourceRevision: string;
      extractorVersion?: number;
      sourceOccurredAt?: Date | null;
      sourceModifiedAt?: Date | null;
      normalized: Record<string, any>;
    },
    expectedRevision?: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const doc = await first<{
        id: string;
        deleted: boolean;
        state: DocumentState;
        pending_revision: string | null;
      }>(
        sql`SELECT d.id, d.deleted, d.state,
              (SELECT source_revision FROM document_versions
                WHERE document_id=d.id ORDER BY fetched_at DESC LIMIT 1) AS pending_revision
            FROM documents d WHERE d.id=${docId} FOR UPDATE`,
        tx,
      );
      if (!doc || doc.deleted || doc.state === 'UNAVAILABLE') return false;
      const tomb = await first(
        sql`SELECT stable_key FROM deletion_tombstones WHERE document_id=${docId}`,
        tx,
      );
      if (tomb) return false;
      const versionId = randomUUID();
      await sql`
        INSERT INTO document_versions(id, document_id, content_hash, extractor_version,
          source_revision, source_occurred_at, source_modified_at, normalized)
        VALUES (${versionId}, ${docId}, ${version.contentHash},
          ${version.extractorVersion ?? 1}, ${version.sourceRevision},
          ${version.sourceOccurredAt ?? null}, ${version.sourceModifiedAt ?? null},
          ${json(version.normalized)})
        ON CONFLICT (document_id, content_hash, extractor_version) DO NOTHING`.execute(tx);
      const row = await first<{ id: string }>(
        sql`SELECT id FROM document_versions
            WHERE document_id=${docId} AND content_hash=${version.contentHash}
              AND extractor_version=${version.extractorVersion ?? 1}`,
        tx,
      );
      if (!row) return false;
      await sql`
        UPDATE documents SET current_version_id=${row.id}, dirty=false, state='READY',
          updated_at=now()
        WHERE id=${docId}`.execute(tx);
      return true;
    });
  }

  // ── active chunk_set 단일 트랜잭션 전환 (§8.1) ────────────────────
  /** 비활성 set을 먼저 만들고 청크를 채운 뒤 swapChunkSet으로 원자 교체한다. */
  async createChunkSet(documentId: string, extractorVersion: number) {
    const id = randomUUID();
    await sql`
      INSERT INTO chunk_sets(id, document_id, extractor_version)
      VALUES (${id}, ${documentId}, ${extractorVersion})`.execute(this.db);
    return id;
  }
  /** 단일 UPDATE로 활성 set을 바꿔 검색자가 부분 청크를 보지 않게 한다. */
  async swapChunkSet(documentId: string, chunkSetId: string) {
    return this.db.transaction().execute(async (tx) => {
      const set = await first<{ id: string }>(
        sql`SELECT id FROM chunk_sets WHERE id=${chunkSetId}
              AND document_id=${documentId} AND NOT active FOR UPDATE`,
        tx,
      );
      if (!set) return null;
      await sql`UPDATE chunk_sets SET active=false WHERE document_id=${documentId}`.execute(tx);
      await sql`UPDATE chunk_sets SET active=true WHERE id=${set.id}`.execute(tx);
      return set.id;
    });
  }
  async insertChunks(
    chunkSetId: string,
    chunks: { ordinal: number; content: string; tokenCount?: number; span?: any; metadata?: any }[],
  ) {
    for (const c of chunks)
      await sql`
        INSERT INTO chunks(id, chunk_set_id, ordinal, content, token_count, span, metadata)
        VALUES (${randomUUID()}, ${chunkSetId}, ${c.ordinal}, ${c.content},
          ${c.tokenCount ?? null}, ${json(c.span ?? {})}, ${json(c.metadata ?? {})})
        ON CONFLICT (chunk_set_id, ordinal) DO NOTHING`.execute(this.db);
  }

  // ── 삭제/권한 회수: tombstone + 파생 데이터 차단 (§8.1/§8.2) ──────
  async applyTombstone(
    stableKey: string,
    sourceId: string | null,
    reason: string,
    contentHash?: string,
  ) {
    await this.db.transaction().execute(async (tx) => {
      const doc = await first<{ id: string }>(
        sql`SELECT id FROM documents WHERE stable_key=${stableKey} LIMIT 1`,
        tx,
      );
      await sql`
        INSERT INTO deletion_tombstones(stable_key, source_id, document_id, reason, content_hash)
        VALUES (${stableKey}, ${sourceId}, ${doc?.id ?? null}, ${reason}, ${contentHash ?? null})
        ON CONFLICT (stable_key) DO UPDATE
          SET reason=EXCLUDED.reason, deleted_at=now()`.execute(tx);
      await sql`
        UPDATE documents SET state='UNAVAILABLE', deleted=true, dirty=false, updated_at=now()
        WHERE stable_key=${stableKey}`.execute(tx);
      // 파생 청크는 tombstone 문서의 active chunk_set을 해제해 즉시 검색 차단한다.
      await sql`
        UPDATE chunk_sets SET active=false
        WHERE document_id IN (SELECT id FROM documents WHERE stable_key=${stableKey})`.execute(tx);
      await sql`
        INSERT INTO knowledge_audit(id, project_id, actor, kind, data)
        VALUES (${randomUUID()}, null, null, 'TOMBSTONE',
          ${json({ stable_key: stableKey, reason, content_hash: contentHash ?? null, at: new Date().toISOString() })})`.execute(
        tx,
      );
    });
  }
  /** tombstone 해제는 원본 존재 + 새 fetch 버전 확인이 있는 경우에만 (§8.1). */
  async liftTombstone(stableKey: string, observedAt: Date) {
    await sql`
      DELETE FROM deletion_tombstones WHERE stable_key=${stableKey}`.execute(this.db);
    await sql`
      INSERT INTO knowledge_audit(id, project_id, actor, kind, data)
      VALUES (${randomUUID()}, null, null, 'TOMBSTONE_LIFTED',
        ${json({ stable_key: stableKey, observed_at: observedAt.toISOString() })})`.execute(this.db);
  }
}
