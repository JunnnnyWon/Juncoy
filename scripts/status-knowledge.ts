import 'dotenv/config';
import { KnowledgeStore, sql, rows } from '@meeting/knowledge-db';

// 지식 스택 진단 (QA 10-12 후속) — 소스·스코프·커서·잡·문서 신선도·답변 상태를
// JSON으로 출력한다. 운영에서 `pnpm status:knowledge`로 실행.
// KNOWLEDGE_DATABASE_URL 필수.

const url = process.env.KNOWLEDGE_DATABASE_URL;
if (!url) {
  process.stderr.write('KNOWLEDGE_DATABASE_URL is required\n');
  process.exit(1);
}

const store = new KnowledgeStore(url);
try {
  const sources = await rows(
    sql`SELECT s.id, s.kind, s.status, s.created_at,
          (SELECT count(*)::int FROM documents d WHERE d.source_id=s.id AND NOT d.deleted) AS documents,
          (SELECT max(d.updated_at) FROM documents d WHERE d.source_id=s.id) AS last_document_at,
          (SELECT count(*)::int FROM source_scopes sc WHERE sc.source_id=s.id AND sc.allowed) AS allowed_scopes,
          (SELECT max(cc.last_reconciled_at) FROM connector_cursors cc WHERE cc.source_id=s.id) AS last_reconciled_at
        FROM knowledge_sources s ORDER BY s.kind`,
    store.db,
  );

  const scopes = await rows(
    sql`SELECT k.kind, sc.scope_key, sc.allowed, sc.metadata, sc.created_at,
          (SELECT cc.last_reconciled_at FROM connector_cursors cc
            WHERE cc.source_id=sc.source_id AND cc.scope_key=sc.scope_key) AS last_reconciled_at
        FROM source_scopes sc JOIN knowledge_sources k ON k.id=sc.source_id
        ORDER BY k.kind, sc.scope_key`,
    store.db,
  );

  const jobs = await rows(
    sql`SELECT kind, status, count(*)::int AS n, max(created_at) AS last_at
        FROM knowledge_jobs GROUP BY kind, status ORDER BY kind, status`,
    store.db,
  );

  const freshness = await rows(
    sql`SELECT k.kind, count(*)::int AS documents,
          max(v.source_occurred_at) AS newest_source_occurred,
          max(v.source_modified_at) AS newest_source_modified,
          max(d.updated_at) AS last_indexed
        FROM documents d JOIN knowledge_sources k ON k.id=d.source_id
        LEFT JOIN document_versions v ON v.id=d.current_version_id
        WHERE NOT d.deleted GROUP BY k.kind ORDER BY k.kind`,
    store.db,
  );

  const uploads = await rows(
    sql`SELECT state, count(*)::int AS n, max(created_at) AS last_at
        FROM knowledge_uploads GROUP BY state ORDER BY state`,
    store.db,
  );

  const answers = await rows(
    sql`SELECT status, count(*)::int AS n, max(created_at) AS last_at
        FROM answer_runs WHERE created_at > now() - interval '7 days'
        GROUP BY status ORDER BY status`,
    store.db,
  );

  process.stdout.write(
    JSON.stringify({ sources, scopes, jobs, freshness, uploads, answers }, null, 2) + '\n',
  );
} finally {
  await store.close();
}
