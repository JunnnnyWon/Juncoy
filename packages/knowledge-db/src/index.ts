import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction, type RawBuilder } from 'kysely';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtBoardSnapshot, type DocumentState, type KnowledgeJobKind, type KnowledgeJobStatus } from '@meeting/contracts';

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
  owner: string | null;
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

  /**
   * 이벤트 기록과 후속 잡 enqueue를 한 트랜잭션으로 묶는다 (RAG-014) —
   * 이벤트는 저장됐는데 잡이 빠지는 경유 상태가 없다.
   * 반환: { eventId } — 중복 이벤트면 eventId=null이고 잡도 넣지 않는다.
   */
  async recordSourceEventWithJob(
    sourceId: string,
    eventKey: string,
    kind: string,
    body: Record<string, any>,
    job?: {
      key: string;
      kind: KnowledgeJobKind;
      payload: Record<string, any>;
      documentId?: string;
      dueAt?: Date;
    },
  ): Promise<{ eventId: string | null; jobId: string | null }> {
    return this.db.transaction().execute(async (tx) => {
      const eventId = randomUUID();
      const hit = await first(
        sql<{ id: string }>`
          INSERT INTO source_events(id, source_id, event_key, kind, body)
          VALUES (${eventId}, ${sourceId}, ${eventKey}, ${kind}, ${json(body)})
          ON CONFLICT (source_id, event_key) DO NOTHING
          RETURNING id`,
        tx,
      );
      if (!hit) return { eventId: null, jobId: null };
      let jobId: string | null = null;
      if (job) {
        jobId = randomUUID();
        await sql`
          INSERT INTO knowledge_jobs(id, key, kind, document_id, payload, due_at)
          VALUES (${jobId}, ${job.key}, ${job.kind}, ${job.documentId ?? null},
                  ${json(job.payload)}, ${job.dueAt ?? new Date()})
          ON CONFLICT (key) DO NOTHING`.execute(tx);
      }
      return { eventId, jobId };
    });
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
              ${opts?.dueAt ?? sql`now()`})
      ON CONFLICT (key) DO NOTHING`.execute(this.db);
  }
  /**
   * 늦게 도착한 이전 세대 worker 결과가 current를 덮어쓰지 못하게 generation을 올린다.
   * RUNNING이지만 lease가 만료된 잡은 worker 죽음으로 보고 재claim한다 —
   * fencing generation이 올라가므로 구 owner의 쓰기는 전부 거절된다 (RAG-007).
   */
  async claimJobs(owner: string, kinds: KnowledgeJobKind[], limit: number, leaseMs: number) {
    return rows<KnowledgeJob>(
      sql<KnowledgeJob>`
        UPDATE knowledge_jobs SET
          status='RUNNING', owner=${owner}, generation=generation+1,
          lease_until=now() + ${leaseMs} * interval '1 millisecond',
          attempts=attempts+1
        WHERE id IN (
          SELECT id FROM knowledge_jobs
          WHERE (status IN ('PENDING','RETRYABLE') OR
                 (status='RUNNING' AND lease_until < now()))
            AND due_at <= now() AND kind = ANY(${kinds})
          ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING id, key, kind, document_id, payload, attempts, generation, owner`,
      this.db,
    );
  }
  /**
   * claim 이후 generation이 바뀐 잡(재claim/리셋)은 완료 쓰기를 거부한다.
   * owner 일치까지 확인해 다른 worker의 완료 쓰기가 섞이지 않게 한다 (RAG-007).
   */
  async finishJob(job: KnowledgeJob, status: KnowledgeJobStatus, errorCode?: string) {
    const res = await sql`
      UPDATE knowledge_jobs SET status=${status}, owner=null, lease_until=null,
        error_code=${errorCode ?? null}
      WHERE id=${job.id} AND generation=${job.generation}
        AND owner=${job.owner} AND status='RUNNING'`.execute(this.db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }
  async retryJob(job: KnowledgeJob, dueAt: Date, errorCode?: string) {
    const res = await sql`
      UPDATE knowledge_jobs SET status='RETRYABLE', owner=null, lease_until=null,
        due_at=${dueAt}, error_code=${errorCode ?? null}
      WHERE id=${job.id} AND generation=${job.generation}
        AND owner=${job.owner} AND status='RUNNING'`.execute(this.db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }
  async renewJobLease(job: KnowledgeJob, leaseMs: number) {
    const result = await sql`UPDATE knowledge_jobs SET lease_until=now() + ${leaseMs} * interval '1 millisecond'
      WHERE id=${job.id} AND generation=${job.generation} AND owner=${job.owner}
        AND status='RUNNING' AND lease_until > now()`.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  async failUploadJob(job: KnowledgeJob, errorCode: string, retryAt?: Date) {
    return this.db.transaction().execute(async (tx) => {
      const owned = await first(sql`SELECT id FROM knowledge_jobs
        WHERE id=${job.id} AND generation=${job.generation} AND owner=${job.owner}
          AND status='RUNNING' AND lease_until > now() FOR UPDATE`, tx);
      if (!owned) return false;
      await sql`UPDATE knowledge_jobs SET status=${retryAt ? 'RETRYABLE' : 'DEAD_LETTER'},
        owner=null, lease_until=null, error_code=${errorCode}, due_at=${retryAt ?? sql`now()`}
        WHERE id=${job.id}`.execute(tx);
      await sql`UPDATE knowledge_uploads SET state=${retryAt ? 'EXTRACTING' : 'FAILED'}, error=${errorCode}
        WHERE id=${job.payload.upload_id} AND state != 'DELETED'
          AND sha256=${job.payload.source_sha256 ?? sql`sha256`}`.execute(tx);
      return true;
    });
  }

  // ── 문서/버전: dirty 표시와 current 전환 분리 (§8.1) ──────────────
  /**
   * 원본 변경을 알게 되는 즉시 호출. tombstone이 있으면 새 문서로 부활시키지 않고
   * 'tombstoned'를 반환한다 — 복원은 원본의 새 fetch 버전을 통해서만 가능하다.
   *
   * `unlessHash`를 주면 현재 current 버전의 content_hash와 같은 수집은
   * dirty를 세우지 않고 'unchanged'를 반환한다 — 동일 내용 재수집이 검색에서
   * 문서를 숨기지 않는다 (RAG-005). `revision`은 원본의 최신 관측 revision으로
   * pending_revision에 기록돼 publishVersion의 순서 검증 기준이 된다 (RAG-006).
   */
  async markDocumentDirty(
    sourceId: string,
    stableKey: string,
    metadata: Record<string, any> = {},
    opts: { unlessHash?: string; revision?: string; acl?: Record<string, any> } = {},
  ): Promise<'dirty' | 'unchanged' | 'tombstoned'> {
    const tomb = await first(
      sql`SELECT stable_key FROM deletion_tombstones WHERE stable_key=${stableKey}`,
      this.db,
    );
    if (tomb) return 'tombstoned';
    const unlessHash = opts.unlessHash ?? null;
    const row = await first<{ cur_hash: string | null; dirty: boolean }>(
      sql`
      INSERT INTO documents(id, source_id, stable_key, metadata, pending_revision, acl)
      VALUES (${randomUUID()}, ${sourceId}, ${stableKey}, ${json(metadata)},
        ${opts.revision ?? null}, ${json(opts.acl ?? {})})
      ON CONFLICT (source_id, stable_key) DO UPDATE
        SET updated_at=now(),
            metadata=documents.metadata || EXCLUDED.metadata,
            acl=documents.acl || coalesce(${json(opts.acl ?? {})}, '{}'::jsonb),
            pending_revision=coalesce(${opts.revision ?? null}, documents.pending_revision),
            dirty = documents.dirty OR (
              ${unlessHash === null} OR coalesce(
                (SELECT v.content_hash FROM document_versions v
                  WHERE v.id=documents.current_version_id)
                  IS DISTINCT FROM ${unlessHash}, true))
      RETURNING (SELECT v.content_hash FROM document_versions v
                  WHERE v.id=documents.current_version_id) AS cur_hash,
                documents.dirty`,
      this.db,
    );
    if (!row) return 'tombstoned'; // 방어적 — INSERT는 항상 행을 반환한다
    if (unlessHash !== null && row.cur_hash === unlessHash && !row.dirty) return 'unchanged';
    return 'dirty';
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
    connection?: Transaction<Database>,
  ): Promise<boolean> {
    const publish = async (tx: Transaction<Database>) => {
      const doc = await first<{
        id: string;
        deleted: boolean;
        state: DocumentState;
        pending_revision: string | null;
      }>(
        sql`SELECT d.id, d.deleted, d.state, d.pending_revision
            FROM documents d WHERE d.id=${docId} FOR UPDATE`,
        tx,
      );
      if (!doc || doc.deleted || doc.state === 'UNAVAILABLE') return false;
      const tomb = await first(
        sql`SELECT stable_key FROM deletion_tombstones WHERE document_id=${docId}`,
        tx,
      );
      if (tomb) return false;
      // out-of-order 방지: 지정된 기대 revision이 있는데 원본이 이미 더 새
      // revision으로 넘어갔다면 이 publish는 폐기한다 (RAG-006).
      if (
        expectedRevision !== undefined &&
        doc.pending_revision !== null &&
        doc.pending_revision !== expectedRevision
      )
        return false;
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
    };
    return connection ? publish(connection) : this.db.transaction().execute(publish);
  }

  /** Fence and lock the source before persisting any ingestion result. */
  async commitUploadIngestion<T>(
    uploadId: string, sourceHash: string, job: KnowledgeJob | undefined,
    persist: (store: KnowledgeStore, connection: Transaction<Database>) => Promise<T>,
  ): Promise<T | null> {
    return this.db.transaction().execute(async (tx) => {
      if (job) {
        const lease = await first(sql`SELECT id FROM knowledge_jobs
          WHERE id=${job.id} AND owner=${job.owner} AND generation=${job.generation}
            AND status='RUNNING' AND lease_until > now() FOR UPDATE`, tx);
        if (!lease) return null;
      }
      const upload = await first(sql`SELECT id FROM knowledge_uploads
        WHERE id=${uploadId} AND sha256=${sourceHash} AND state != 'DELETED' FOR UPDATE`, tx);
      if (!upload) return null;
      const scoped = Object.create(this) as KnowledgeStore;
      Object.defineProperty(scoped, 'db', { value: tx });
      const result = await persist(scoped, tx);
      if (result && typeof result === 'object' && 'skipped' in result)
        throw new Error('ingestion_publish_rejected');
      if (job && !(await scoped.finishJob(job, 'DONE')))
        throw new Error('ingestion_job_fenced');
      return result;
    });
  }

  // ── active chunk_set 단일 트랜잭션 전환 (§8.1) ────────────────────
  /** 비활성 set을 만들고 청크를 채운 뒤 swapChunkSet으로 원자 교체한다.
   * versionId = 이 set을 만든 대상 document_version — 검색은
   * version_id = current_version_id 결합을 요구한다 (RAG-006). */
  async createChunkSet(documentId: string, extractorVersion: number, versionId: string) {
    const id = randomUUID();
    await sql`
      INSERT INTO chunk_sets(id, document_id, extractor_version, version_id)
      VALUES (${id}, ${documentId}, ${extractorVersion}, ${versionId})`.execute(this.db);
    return id;
  }
  /** 단일 UPDATE로 활성 set을 바꿔 검색자가 부분 청크를 보지 않게 한다.
   * set이 바인딩된 버전이 더 이상 current가 아니면 교체를 거부한다 —
   * 순서 역전으로 오래된 청크가 현재 근거를 가장하지 못한다 (RAG-006). */
  async swapChunkSet(documentId: string, chunkSetId: string) {
    return this.db.transaction().execute(async (tx) => {
      const set = await first<{ id: string }>(
        sql`SELECT s.id FROM chunk_sets s
              JOIN documents d ON d.id=s.document_id
              AND d.current_version_id=s.version_id
            WHERE s.id=${chunkSetId} AND s.document_id=${documentId}
              AND NOT s.active FOR UPDATE OF s`,
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
  /**
   * prefix 단위 대량 tombstone (RAG-010) — 채널/스레드 삭제처럼 부모가 지워질 때
   * 그 아래 문서 전체를 한 트랜잭션으로 차단한다.
   * stable_key LIKE '<prefix>%' 형태 — 호출자는 접두 경계(보통 ':'로 끝나는)를 맞춘다.
   */
  async applyTombstonesByPrefix(sourceId: string, keyPrefix: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const docs = await rows<{ id: string; stable_key: string }>(
        sql`SELECT id, stable_key FROM documents
            WHERE source_id=${sourceId} AND stable_key LIKE ${keyPrefix + '%'} AND NOT deleted`,
        tx,
      );
      for (const d of docs) {
        await sql`
          INSERT INTO deletion_tombstones(stable_key, source_id, document_id, reason)
          VALUES (${d.stable_key}, ${sourceId}, ${d.id}, ${reason})
          ON CONFLICT (stable_key) DO UPDATE
            SET reason=EXCLUDED.reason, deleted_at=now()`.execute(tx);
        await sql`
          UPDATE chunk_sets SET active=false WHERE document_id=${d.id}`.execute(tx);
      }
      if (docs.length)
        await sql`
          UPDATE documents SET state='UNAVAILABLE', deleted=true, dirty=false, updated_at=now()
          WHERE source_id=${sourceId} AND stable_key LIKE ${keyPrefix + '%'}`.execute(tx);
      await sql`
        INSERT INTO knowledge_audit(id, project_id, actor, kind, data)
        VALUES (${randomUUID()}, null, null, 'TOMBSTONE_BULK',
          ${json({ prefix: keyPrefix, reason, count: docs.length, at: new Date().toISOString() })})`.execute(
        tx,
      );
      return docs.length;
    });
  }

  /** tombstone 해제는 원본 존재 + 새 fetch 버전 확인이 있는 경우에만 (§8.1). */
  async liftTombstone(stableKey: string, observedAt: Date) {
    await sql`
      DELETE FROM deletion_tombstones WHERE stable_key=${stableKey}`.execute(this.db);
    await sql`
      INSERT INTO knowledge_audit(id, project_id, actor, kind, data)
      VALUES (${randomUUID()}, null, null, 'TOMBSTONE_LIFTED',
        ${json({ stable_key: stableKey, observed_at: observedAt.toISOString() })})`.execute(
      this.db,
    );
  }

  // ── 웹 어시스턴트 (spec §14) ──────────────────────────────────────

  async createConversation(projectId: string, ownerId: string, title = '새 대화') {
    const id = randomUUID();
    await sql`
      INSERT INTO assistant_conversations(id, project_id, owner_id, title)
      VALUES (${id}, ${projectId}, ${ownerId}, ${title})`.execute(this.db);
    return id;
  }

  async createArtBoard(projectId: string, ownerId: string, name = '비주얼 레퍼런스 보드') {
    const id = randomUUID();
    await sql`INSERT INTO art_boards(id, project_id, owner_id, name)
      VALUES (${id}, ${projectId}, ${ownerId}, ${name})`.execute(this.db);
    return id;
  }

  async listArtBoards(projectId: string, ownerId: string) {
    return rows<any>(
      sql`SELECT id, name, description, status, current_revision, created_at, updated_at
      FROM art_boards WHERE project_id=${projectId} AND owner_id=${ownerId} AND archived_at IS NULL
      ORDER BY updated_at DESC`,
      this.db,
    );
  }

  async getArtBoard(projectId: string, ownerId: string, boardId: string) {
    return first<any>(
      sql`SELECT id, name, description, status, current_revision, created_at, updated_at
      FROM art_boards WHERE id=${boardId} AND project_id=${projectId} AND owner_id=${ownerId} AND archived_at IS NULL`,
      this.db,
    );
  }

  async saveArtBoardRevision(input: {
    projectId: string;
    ownerId: string;
    boardId: string;
    baseRevision: number;
    snapshot: unknown;
    snapshotHash: string;
  }) {
    const snapshot = ArtBoardSnapshot.parse(input.snapshot);
    return this.db.transaction().execute(async (tx) => {
      const board = await first<{ current_revision: number }>(
        sql`SELECT current_revision FROM art_boards
        WHERE id=${input.boardId} AND project_id=${input.projectId} AND owner_id=${input.ownerId} AND archived_at IS NULL FOR UPDATE`,
        tx,
      );
      if (!board) return { kind: 'NOT_FOUND' as const };
      if (Number(board.current_revision) !== input.baseRevision)
        return { kind: 'CONFLICT' as const, current_revision: Number(board.current_revision) };
      const revision = input.baseRevision + 1;
      await sql`INSERT INTO art_board_revisions(id, board_id, revision, created_by, snapshot, snapshot_hash)
        VALUES (${randomUUID()}, ${input.boardId}, ${revision}, ${input.ownerId}, ${json(input.snapshot)}, ${input.snapshotHash})`.execute(
        tx,
      );
      const references = Array.isArray((input.snapshot as any)?.references)
        ? (input.snapshot as any).references
        : [];
      const geometry = [
        ...snapshot.nodes.map((node) => ({ ...node, data: { text: node.text } })),
        ...snapshot.references.map((ref) => ({ id: ref.id, node_type: 'image_reference', x: Number(ref.x ?? 0), y: Number(ref.y ?? 0), width: Number(ref.width ?? 220), height: Number(ref.height ?? 180), data: ref })),
      ];
      for (const node of geometry) {
        await sql`INSERT INTO art_board_nodes(board_id, revision, id, node_type, x, y, width, height, data)
          VALUES (${input.boardId}, ${revision}, ${node.id}, ${node.node_type}, ${node.x}, ${node.y}, ${node.width}, ${node.height}, ${json(node.data)})`.execute(tx);
      }
      for (const edge of snapshot.edges) {
        await sql`INSERT INTO art_board_edges(board_id, revision, id, source_node_id, target_node_id, edge_type)
          VALUES (${input.boardId}, ${revision}, ${edge.id}, ${edge.source}, ${edge.target}, ${edge.edge_type})`.execute(tx);
      }
      await sql`DELETE FROM art_board_assets WHERE board_id=${input.boardId}`.execute(tx);
      for (const ref of references) {
        if (!ref || typeof ref.id !== 'string') continue;
        await sql`INSERT INTO art_board_assets(
          board_id, asset_key, source_upload_id, role, usage_strength, note, selected, source_sha256
        ) VALUES (
          ${input.boardId}, ${ref.id}, ${ref.upload_id ?? null},
          ${ref.role ?? 'mood'}, ${ref.usage ?? 'REVIEW_REQUIRED'},
          ${ref.note ?? ''}, ${Boolean(ref.selected)}, ${ref.sha256 ?? null}
        )`.execute(tx);
      }
      await sql`UPDATE art_boards SET current_revision=${revision}, updated_at=now() WHERE id=${input.boardId}`.execute(
        tx,
      );
      return { kind: 'SAVED' as const, revision };
    });
  }

  async getArtBoardRevision(
    projectId: string,
    ownerId: string,
    boardId: string,
    revision?: number,
  ) {
    const board = await this.getArtBoard(projectId, ownerId, boardId);
    if (!board) return null;
    return first<any>(
      sql`SELECT r.id, r.revision, r.snapshot, r.snapshot_hash, r.analysis_state, r.created_at
      FROM art_board_revisions r WHERE r.board_id=${boardId} AND r.revision=${revision ?? board.current_revision}`,
      this.db,
    );
  }

  async listArtBoardHistory(projectId: string, ownerId: string, boardId: string) {
    return rows<any>(sql`SELECT r.id, r.revision, r.created_by, r.snapshot_hash,
        r.analysis_state, r.created_at
      FROM art_board_revisions r JOIN art_boards b ON b.id=r.board_id
      WHERE r.board_id=${boardId} AND b.project_id=${projectId} AND b.owner_id=${ownerId}
      ORDER BY r.revision DESC LIMIT 100`, this.db);
  }

  async saveArtBoardAnalysis(input: {
    boardId: string;
    revision: number;
    userId: string;
    model: string;
    result: unknown;
    resultHash: string;
  }) {
    const id = randomUUID();
    await sql`INSERT INTO art_board_analyses(id, board_id, revision, status, model, result, result_hash, created_by)
      VALUES (${id}, ${input.boardId}, ${input.revision}, 'DRAFT', ${input.model}, ${json(input.result)}, ${input.resultHash}, ${input.userId})
      `.execute(this.db);
    return id;
  }

  async getArtBoardAnalysis(projectId: string, ownerId: string, boardId: string, revision: number) {
    return first<any>(sql`SELECT a.* FROM art_board_analyses a
      JOIN art_boards b ON b.id=a.board_id
      WHERE a.board_id=${boardId} AND a.revision=${revision}
        AND b.project_id=${projectId} AND b.owner_id=${ownerId}
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1`, this.db);
  }

  async approveArtBoardAnalysis(input: {
    projectId: string;
    ownerId: string;
    boardId: string;
    revision: number;
    analysisId: string;
    approvedBy: string;
    expectedHash: string;
  }) {
    return this.db.transaction().execute(async (tx) => {
      // Serialize project-wide version allocation across different boards.
      await sql`SELECT id FROM knowledge_projects WHERE id=${input.projectId} FOR UPDATE`.execute(tx);
      const analysis = await first<any>(sql`SELECT a.*, b.current_revision, b.archived_at FROM art_board_analyses a
        JOIN art_boards b ON b.id=a.board_id
        WHERE a.id=${input.analysisId} AND a.board_id=${input.boardId} AND a.revision=${input.revision}
          AND b.project_id=${input.projectId} AND b.owner_id=${input.ownerId} FOR UPDATE`, tx);
      if (!analysis) return { kind: 'NOT_FOUND' as const };
      if (analysis.result_hash !== input.expectedHash) return { kind: 'RESULT_CHANGED' as const };
      if (analysis.status === 'APPROVED') {
        if (!analysis.approved_style_version) return { kind: 'LEGACY_APPROVAL' as const };
        return { kind: 'APPROVED' as const, version: Number(analysis.approved_style_version), result: analysis.result, reused: true };
      }
      if (analysis.status !== 'DRAFT') return { kind: 'NOT_DRAFT' as const };
      if (analysis.archived_at || Number(analysis.current_revision) !== input.revision)
        return { kind: 'REVISION_CONFLICT' as const };
      const latest = await first<{ version: number }>(sql`SELECT coalesce(max(version), 0)::int AS version
        FROM style_profiles WHERE project_id=${input.projectId}`, tx);
      const version = Number(latest?.version ?? 0) + 1;
      await sql`INSERT INTO style_profiles(id, project_id, version, body, approved_by, approved_at, epoch)
        VALUES (${randomUUID()}, ${input.projectId}, ${version}, ${json({ ...analysis.result, provenance: { board_id: input.boardId, revision: input.revision, analysis_id: analysis.id, result_hash: analysis.result_hash } })}, ${input.approvedBy}, now(), ${version})`.execute(tx);
      await sql`UPDATE art_board_analyses SET status='APPROVED', approved_style_version=${version} WHERE id=${analysis.id}`.execute(tx);
      for (const rule of analysis.result.common_rules ?? []) {
        await sql`INSERT INTO style_profile_rules(id, project_id, style_version, category, statement, strength, provenance, status, approved_by, approved_at)
          VALUES (${randomUUID()}, ${input.projectId}, ${version}, ${rule.category}, ${rule.statement}, 'STRONG_REFERENCE',
            ${json({ board_id: input.boardId, revision: input.revision, analysis_id: analysis.id, evidence_ids: rule.evidence_ids ?? [] })},
            'APPROVED', ${input.approvedBy}, now())`.execute(tx);
      }
      return { kind: 'APPROVED' as const, version, result: analysis.result };
    });
  }

  async getApprovedStyleProfile(projectId: string) {
    return first<any>(sql`SELECT version, body, approved_by, approved_at FROM style_profiles
      WHERE project_id=${projectId} AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY version DESC LIMIT 1`, this.db);
  }

  async getApprovedStyleRules(projectId: string, version: number) {
    return rows<any>(sql`SELECT id, category, statement, strength, provenance, approved_by, approved_at
      FROM style_profile_rules WHERE project_id=${projectId} AND style_version=${version}
        AND status='APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY created_at, id`, this.db);
  }

  /** 대화는 owner+project 스코프로만 조회 — id만으로 타인 대화를 열지 않는다. */
  async getConversation(projectId: string, conversationId: string, ownerId: string) {
    return first<{ id: string; title: string; archived: boolean }>(
      sql`SELECT id, title, archived FROM assistant_conversations
          WHERE id=${conversationId} AND project_id=${projectId} AND owner_id=${ownerId}`,
      this.db,
    );
  }

  async listConversations(projectId: string, ownerId: string) {
    return rows<{ id: string; title: string; archived: boolean; updated_at: Date }>(
      sql`SELECT id, title, archived, updated_at FROM assistant_conversations
          WHERE project_id=${projectId} AND owner_id=${ownerId} AND NOT archived
          ORDER BY updated_at DESC LIMIT 100`,
      this.db,
    );
  }

  async archiveConversation(projectId: string, conversationId: string, ownerId: string) {
    const res = await sql`
      UPDATE assistant_conversations SET archived=true, updated_at=now()
      WHERE id=${conversationId} AND project_id=${projectId} AND owner_id=${ownerId}`.execute(
      this.db,
    );
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  async createMessage(
    conversationId: string,
    role: string,
    content: string,
    opts: { runId?: string; attachments?: unknown[]; citations?: unknown[] } = {},
  ) {
    const id = randomUUID();
    await sql`
      INSERT INTO assistant_messages(id, conversation_id, run_id, role, content, attachments, citations)
      VALUES (${id}, ${conversationId}, ${opts.runId ?? null}, ${role}, ${content},
        ${json(opts.attachments ?? [])}, ${json(opts.citations ?? [])})`.execute(this.db);
    await sql`UPDATE assistant_conversations SET updated_at=now() WHERE id=${conversationId}`.execute(
      this.db,
    );
    return id;
  }

  async listMessages(conversationId: string, limit = 200) {
    return rows<{
      id: string;
      run_id: string | null;
      role: string;
      content: string;
      attachments: unknown[];
      citations: unknown[];
      created_at: Date;
    }>(
      sql`SELECT id, run_id, role, content, attachments, citations, created_at
          FROM assistant_messages WHERE conversation_id=${conversationId}
          ORDER BY created_at ASC LIMIT ${limit}`,
      this.db,
    );
  }

  async createRun(conversationId: string, mode: string, messageId?: string) {
    const id = randomUUID();
    await sql`
      INSERT INTO assistant_runs(id, conversation_id, message_id, mode, phase)
      VALUES (${id}, ${conversationId}, ${messageId ?? null}, ${mode}, 'idle')`.execute(this.db);
    return id;
  }

  async getRun(runId: string) {
    return first<{
      id: string;
      conversation_id: string;
      mode: string;
      phase: string;
      status: string | null;
      model: string | null;
      error: string | null;
      cancelled: boolean;
      created_at: Date;
    }>(
      sql`SELECT id, conversation_id, mode, phase, status, model, error, cancelled, created_at
          FROM assistant_runs WHERE id=${runId}`,
      this.db,
    );
  }

  async updateRun(
    runId: string,
    patch: { phase?: string; status?: string; model?: string; error?: string; cancelled?: boolean },
  ) {
    if (patch.phase !== undefined)
      await sql`UPDATE assistant_runs SET phase=${patch.phase}, updated_at=now() WHERE id=${runId}`.execute(
        this.db,
      );
    if (patch.status !== undefined)
      await sql`UPDATE assistant_runs SET status=${patch.status}, updated_at=now() WHERE id=${runId}`.execute(
        this.db,
      );
    if (patch.model !== undefined)
      await sql`UPDATE assistant_runs SET model=${patch.model} WHERE id=${runId}`.execute(this.db);
    if (patch.error !== undefined)
      await sql`UPDATE assistant_runs SET error=${patch.error} WHERE id=${runId}`.execute(this.db);
    if (patch.cancelled !== undefined)
      await sql`UPDATE assistant_runs SET cancelled=${patch.cancelled} WHERE id=${runId}`.execute(
        this.db,
      );
  }

  /** 이벤트는 run 내 seq 단조 증가 + payload hash로 재검증 (§14). */
  async emitRunEvent(runId: string, kind: string, payload: unknown) {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.db.transaction().execute(async (tx) => {
      const { n } = await first<{ n: number }>(
        sql`SELECT COALESCE(max(seq), 0) + 1 AS n FROM assistant_run_events WHERE run_id=${runId}`,
        tx,
      );
      const id = randomUUID();
      await sql`
        INSERT INTO assistant_run_events(id, run_id, seq, kind, payload, payload_hash)
        VALUES (${id}, ${runId}, ${n}, ${kind}, ${json(payload ?? {})}, ${hash})`.execute(tx);
      return { id, seq: n };
    });
  }

  async runEvents(runId: string, afterSeq = 0) {
    return rows<{ id: string; seq: number; kind: string; payload: unknown; created_at: Date }>(
      sql`SELECT id, seq, kind, payload, created_at FROM assistant_run_events
          WHERE run_id=${runId} AND seq>${afterSeq} ORDER BY seq ASC LIMIT 500`,
      this.db,
    );
  }

  async cancelRun(runId: string) {
    const res = await sql`
      UPDATE assistant_runs SET cancelled=true, updated_at=now()
      WHERE id=${runId} AND status IS NULL`.execute(this.db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  // ── 승인 (§11) ────────────────────────────────────────────────────

  async createApproval(a: {
    projectId: string;
    userId: string;
    conversationId?: string;
    runId?: string;
    kind: string;
    target: unknown;
    beforeHash?: string | null;
    after: unknown;
    expiresAt: Date;
  }) {
    const id = randomUUID();
    await sql`
      INSERT INTO assistant_approvals(id, project_id, user_id, conversation_id, run_id, kind,
        target, before_hash, after, expires_at)
      VALUES (${id}, ${a.projectId}, ${a.userId}, ${a.conversationId ?? null},
        ${a.runId ?? null}, ${a.kind}, ${json(a.target)}, ${a.beforeHash ?? null},
        ${json(a.after)}, ${a.expiresAt})`.execute(this.db);
    return id;
  }

  async getApproval(approvalId: string, projectId?: string) {
    return first<{
      id: string;
      project_id: string;
      user_id: string;
      run_id: string | null;
      kind: string;
      target: any;
      before_hash: string | null;
      after: any;
      status: string;
      expires_at: Date;
    }>(
      sql`SELECT id, project_id, user_id, run_id, kind, target, before_hash, after, status, expires_at
          FROM assistant_approvals WHERE id=${approvalId}
          ${projectId ? sql`AND project_id=${projectId}` : sql``}`,
      this.db,
    );
  }

  /** 만료되지 않은 PENDING 승인만 통과 — 만료건은 EXPIRED로 마킹하고 false. */
  async resolveApproval(approvalId: string, userId: string, accept: boolean) {
    return this.db.transaction().execute(async (tx) => {
      const a = await first<{ status: string; expires_at: Date; user_id: string }>(
        sql`SELECT status, expires_at, user_id FROM assistant_approvals WHERE id=${approvalId} FOR UPDATE`,
        tx,
      );
      if (!a || a.user_id !== userId) return 'not_found';
      if (a.status !== 'PENDING') return 'already_resolved';
      if (a.expires_at.getTime() < Date.now()) {
        await sql`UPDATE assistant_approvals SET status='EXPIRED', resolved_at=now() WHERE id=${approvalId}`.execute(
          tx,
        );
        return 'expired';
      }
      await sql`
        UPDATE assistant_approvals SET status=${accept ? 'APPROVED' : 'REJECTED'}, resolved_at=now()
        WHERE id=${approvalId}`.execute(tx);
      return accept ? 'approved' : 'rejected';
    });
  }

  /** 승인 소비는 1회 — 이미 소비됐으면 false (§11 1회 사용). */
  async consumeApproval(approvalId: string) {
    const res = await sql`
      UPDATE assistant_approvals SET status='CONSUMED'
      WHERE id=${approvalId} AND status='APPROVED'`.execute(this.db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  async listApprovals(projectId: string, userId: string, pendingOnly = true) {
    return rows<any>(
      sql`SELECT id, kind, target, after, status, expires_at, created_at
          FROM assistant_approvals
          WHERE project_id=${projectId} AND user_id=${userId}
          ${pendingOnly ? sql`AND status='PENDING' AND expires_at>now()` : sql``}
          ORDER BY created_at DESC LIMIT 50`,
      this.db,
    );
  }

  async audit(a: {
    projectId: string;
    actor: string;
    connector: string;
    target: unknown;
    action: string;
    beforeHash?: string | null;
    afterHash?: string | null;
    status: string;
    error?: string;
  }) {
    await sql`
      INSERT INTO assistant_audit(id, project_id, actor, connector, target, action,
        before_hash, after_hash, status, error)
      VALUES (${randomUUID()}, ${a.projectId}, ${a.actor}, ${a.connector},
        ${json(a.target)}, ${a.action}, ${a.beforeHash ?? null}, ${a.afterHash ?? null},
        ${a.status}, ${a.error ?? null})`.execute(this.db);
  }

  // ── 업로드 (spec §5) ───────────────────────────────────────────────
  async createUpload(u: {
    projectId: string;
    uploaderId: string;
    filename: string;
    mime: string;
    bytes: number;
    sha256: string;
    storageKey: string;
  }) {
    const r = await first<{ id: string; reused: boolean }>(
      sql`INSERT INTO knowledge_uploads(id, project_id, owner_id, filename, mime, bytes,
              sha256, storage_key)
          VALUES (${randomUUID()}, ${u.projectId}, ${u.uploaderId}, ${u.filename},
              ${u.mime}, ${u.bytes}, ${u.sha256}, ${u.storageKey})
          ON CONFLICT (project_id, sha256) DO NOTHING
          RETURNING id, false AS reused`,
      this.db,
    );
    if (r) return r;
    // 동일 sha256 = 동일 내용 → 기존 업로드 재사용 (삭제됐으면 별도 처리는 호출자)
    const existing = await first<{ id: string }>(
      sql`SELECT id FROM knowledge_uploads WHERE project_id=${u.projectId} AND sha256=${u.sha256}`,
      this.db,
    );
    return { id: existing!.id, reused: true };
  }

  async getUpload(projectId: string, uploadId: string) {
    return first<any>(
      sql`SELECT u.*, d.state AS document_state, d.id AS document_id,
          pv.parser_kind, pv.parser_version, pv.parse_status, pv.parse_error_code,
          pv.parse_request_id, pv.parse_latency_ms, pv.source_sha256 AS parsed_source_sha256
          FROM knowledge_uploads u
          LEFT JOIN documents d ON d.id=u.document_id
             OR d.stable_key='upload:' || u.id::text
          LEFT JOIN LATERAL (SELECT v.* FROM knowledge_upload_versions v
             WHERE v.upload_id=u.id ORDER BY v.created_at DESC LIMIT 1) pv ON true
          WHERE u.project_id=${projectId} AND u.id=${uploadId}`,
      this.db,
    );
  }

  async listUploads(projectId: string) {
    return rows<any>(
      sql`SELECT u.id, u.filename, u.mime, u.bytes, u.sha256, u.state, u.error,
                 u.owner_id, u.created_at, d.state AS document_state, d.id AS document_id,
                 pv.parser_kind, pv.parser_version, pv.parse_status, pv.parse_error_code,
                 pv.parse_request_id, pv.parse_latency_ms, pv.source_sha256 AS parsed_source_sha256
          FROM knowledge_uploads u
          LEFT JOIN documents d ON d.id=u.document_id
             OR d.stable_key='upload:' || u.id::text
          LEFT JOIN LATERAL (SELECT v.* FROM knowledge_upload_versions v
             WHERE v.upload_id=u.id ORDER BY v.created_at DESC LIMIT 1) pv ON true
          WHERE u.project_id=${projectId} AND u.state != 'DELETED'
          ORDER BY u.created_at DESC LIMIT 200`,
      this.db,
    );
  }

  async getUploadsByIds(projectId: string, ids: string[]) {
    if (!ids.length) return [];
    return rows<any>(
      sql`SELECT u.id, u.filename, u.mime, u.storage_key, u.sha256, u.state,
        a.id AS asset_id, a.canonical_state, a.rights_note, a.state AS asset_state
      FROM knowledge_uploads u
      LEFT JOIN art_reference_assets a ON a.upload_id=u.id AND a.project_id=u.project_id
      WHERE u.project_id=${projectId} AND u.id = ANY(${ids}::uuid[]) AND u.state != 'DELETED'`,
      this.db,
    );
  }

  async createArtReferenceAsset(input: {
    projectId: string;
    uploadId: string;
    label?: string;
    rightsNote?: string;
    createdBy: string;
  }) {
    const upload = await first<any>(sql`SELECT id, mime, bytes, sha256, storage_key, state
      FROM knowledge_uploads WHERE id=${input.uploadId} AND project_id=${input.projectId}`, this.db);
    if (!upload || upload.state === 'DELETED' || !String(upload.mime).startsWith('image/')) return null;
    const existing = await first<any>(sql`SELECT id FROM art_reference_assets
      WHERE project_id=${input.projectId} AND upload_id=${input.uploadId}`, this.db);
    if (existing) return existing.id;
    const id = randomUUID();
    await sql`INSERT INTO art_reference_assets(
      id, project_id, upload_id, source_label, rights_note, state, canonical_state, created_by
    ) VALUES (${id}, ${input.projectId}, ${input.uploadId}, ${input.label ?? ''}, ${input.rightsNote ?? ''}, ${upload.state === 'READY' ? 'READY' : 'ANALYZING'}, 'NONE', ${input.createdBy})`.execute(this.db);
    return id;
  }

  async getArtReferenceAsset(projectId: string, assetId: string) {
    return first<any>(sql`SELECT a.*, u.filename, u.mime, u.bytes, u.sha256, u.storage_key, u.state AS upload_state
      FROM art_reference_assets a JOIN knowledge_uploads u ON u.id=a.upload_id
      WHERE a.id=${assetId} AND a.project_id=${projectId}
        AND a.state != 'DELETED' AND u.state != 'DELETED'`, this.db);
  }

  async getLatestArtExtraction(projectId: string, assetId: string) {
    return first<any>(sql`SELECT e.* FROM art_extractions e
      JOIN art_reference_assets a ON a.id=e.asset_id
      JOIN knowledge_uploads u ON u.id=a.upload_id
      WHERE a.project_id=${projectId} AND a.id=${assetId}
        AND a.state != 'DELETED' AND u.state != 'DELETED' AND e.asset_revision=u.sha256
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`, this.db);
  }

  async saveArtExtraction(input: { assetId: string; revision: string; model: string; observations: unknown; ocr?: unknown; confidence?: string }) {
    return this.db.transaction().execute(async (tx) => {
      const asset = await first<any>(sql`SELECT a.id FROM art_reference_assets a
        JOIN knowledge_uploads u ON u.id=a.upload_id
        WHERE a.id=${input.assetId} AND a.state != 'DELETED'
          AND a.canonical_state NOT IN ('REJECTED','ARCHIVED')
          AND u.state != 'DELETED' AND u.sha256=${input.revision}
        FOR UPDATE OF a, u`, tx);
      if (!asset) return null;
      const id = randomUUID();
      await sql`INSERT INTO art_extractions(id, asset_id, asset_revision, extractor_version, observations, ocr, machine_confidence, status)
      VALUES (${id}, ${input.assetId}, ${input.revision}, ${input.model}, ${json(input.observations)}, ${json(input.ocr ?? {})}, ${input.confidence ?? null}, 'DRAFT')`.execute(tx);
      await sql`UPDATE art_reference_assets SET state='READY', updated_at=now() WHERE id=${input.assetId}`.execute(tx);
      return id;
    });
  }

  async reviewArtReferenceAsset(projectId: string, assetId: string, userId: string, state: string, rightsNote?: string) {
    const result = await sql`UPDATE art_reference_assets SET canonical_state=${state}, rights_note=coalesce(${rightsNote ?? null}, rights_note), updated_at=now()
      WHERE id=${assetId} AND project_id=${projectId} AND state != 'DELETED'
        AND (${state !== 'APPROVED_CANONICAL'} OR length(trim(coalesce(${rightsNote ?? null}, rights_note))) > 0)
        AND EXISTS (SELECT 1 FROM knowledge_uploads u WHERE u.id=art_reference_assets.upload_id AND u.state != 'DELETED')`.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  async updateUpload(
    uploadId: string,
    patch: { state?: string; error?: string | null; storageKey?: string; documentId?: string },
  ) {
    await sql`UPDATE knowledge_uploads SET
        state=coalesce(${patch.state ?? null}, state),
        error=${patch.error === undefined ? sql`error` : patch.error},
        storage_key=coalesce(${patch.storageKey ?? null}, storage_key),
        document_id=coalesce(${patch.documentId ?? null}, document_id)
      WHERE id=${uploadId}`.execute(this.db);
  }

  async createUploadVersion(v: {
    uploadId: string;
    extractorVersion: string;
    sourceRevision: string;
    parserKind: string;
    parserVersion?: string;
    parseStatus: string;
    parseRequestId?: string;
    parseLatencyMs?: number;
    parseErrorCode?: string;
    sourceSha256: string;
    normalizedHash: string;
  }) {
    const id = randomUUID();
    await sql`INSERT INTO knowledge_upload_versions(
      id, upload_id, extractor_version, source_revision, state, parser_kind,
      parser_version, parse_status, parse_request_id, parse_latency_ms,
      parse_error_code, source_sha256, normalized_hash
    ) VALUES (
      ${id}, ${v.uploadId}, ${v.extractorVersion}, ${v.sourceRevision},
      ${v.parseStatus}, ${v.parserKind}, ${v.parserVersion ?? null}, ${v.parseStatus},
      ${v.parseRequestId ?? null}, ${v.parseLatencyMs ?? null}, ${v.parseErrorCode ?? null},
      ${v.sourceSha256}, ${v.normalizedHash}
    )`.execute(this.db);
    return id;
  }

  async saveDocumentParseStructure(uploadVersionId: string, normalized: any) {
    const blocks = Array.isArray(normalized?.blocks) ? normalized.blocks : [];
    const pages = Array.isArray(normalized?.pages) ? normalized.pages : [];
    for (const block of blocks) {
      await sql`INSERT INTO document_parse_blocks(id, upload_version_id, block_id, page_number, ordinal, block_type, text, html, metadata, content_hash)
        VALUES (${randomUUID()}, ${uploadVersionId}, ${block.block_id}, ${block.page ?? null}, ${block.ordinal ?? 0}, ${block.block_type ?? 'unknown'}, ${block.text ?? ''}, ${block.html ?? null}, ${json(block.metadata ?? {})}, ${createHash(
          'sha256',
        )
          .update(String(block.text ?? ''))
          .digest('hex')})
        ON CONFLICT (upload_version_id, block_id) DO UPDATE SET text=excluded.text, html=excluded.html, metadata=excluded.metadata, content_hash=excluded.content_hash`.execute(
        this.db,
      );
    }
    for (const page of pages) {
      await sql`INSERT INTO document_parse_pages(id, upload_version_id, page_number, text, block_ids, page_hash)
        VALUES (${randomUUID()}, ${uploadVersionId}, ${page.page}, ${page.text ?? ''}, ${json(page.block_ids ?? [])}, ${createHash(
          'sha256',
        )
          .update(String(page.text ?? ''))
          .digest('hex')})
        ON CONFLICT (upload_version_id, page_number) DO UPDATE SET text=excluded.text, block_ids=excluded.block_ids, page_hash=excluded.page_hash`.execute(
        this.db,
      );
    }
  }

  async getDocumentParse(projectId: string, uploadId: string) {
    const version = await first<any>(sql`
      SELECT v.id, v.parser_kind, v.parser_version, v.parse_status, v.parse_request_id,
             v.parse_latency_ms, v.parse_error_code, v.source_sha256, v.normalized_hash
      FROM knowledge_upload_versions v
      JOIN knowledge_uploads u ON u.id=v.upload_id
      WHERE u.project_id=${projectId} AND u.id=${uploadId}
      ORDER BY v.created_at DESC LIMIT 1`, this.db);
    if (!version) return null;
    const blocks = await rows<any>(sql`
      SELECT block_id, page_number, ordinal, block_type, text, html, metadata, content_hash
      FROM document_parse_blocks WHERE upload_version_id=${version.id}
      ORDER BY page_number NULLS LAST, ordinal`, this.db);
    const pages = await rows<any>(sql`
      SELECT page_number, text, block_ids, page_hash
      FROM document_parse_pages WHERE upload_version_id=${version.id}
      ORDER BY page_number`, this.db);
    return { version, blocks, pages };
  }

  async uploadQuotaUsed(projectId: string) {
    const r = await first<{ total: string }>(
      sql`SELECT coalesce(sum(bytes),0) AS total FROM knowledge_uploads
          WHERE project_id=${projectId} AND state != 'DELETED'`,
      this.db,
    );
    return Number(r?.total ?? 0);
  }
}
