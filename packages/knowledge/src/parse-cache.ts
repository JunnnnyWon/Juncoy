import { randomUUID } from 'node:crypto';
import { first, sql, type KnowledgeStore } from '@meeting/knowledge-db';

export interface ParseCacheKey {
  projectId: string; uploadId: string; sourceHash: string; parserProfile: string; optionsHash: string;
}
/** Completed results only; force refresh replaces a successful result only after success. */
export async function cachedParse<T extends { parseStatus: string }>(
  store: KnowledgeStore, key: ParseCacheKey, run: () => Promise<T>, force = false,
): Promise<T> {
  const owner = randomUUID();
  await sql`INSERT INTO document_parse_cache(project_id, upload_id, source_sha256, parser_profile, options_hash)
    VALUES (${key.projectId},${key.uploadId},${key.sourceHash},${key.parserProfile},${key.optionsHash})
    ON CONFLICT DO NOTHING`.execute(store.db);
  const claim = await store.db.transaction().execute(async (tx) => {
    const row = await first<any>(sql`SELECT result, owner, lease_until > now() AS leased
      FROM document_parse_cache WHERE project_id=${key.projectId} AND upload_id=${key.uploadId}
      AND source_sha256=${key.sourceHash} AND parser_profile=${key.parserProfile} AND options_hash=${key.optionsHash}
      FOR UPDATE`, tx);
    if (row.owner && row.leased) throw new Error('parse_cache_pending');
    if (!force && row.result) return { cached: { ...row.result, cacheHit: true } as T };
    await sql`UPDATE document_parse_cache SET owner=${owner}, lease_until=now()+interval '180 seconds'
      WHERE project_id=${key.projectId} AND upload_id=${key.uploadId} AND source_sha256=${key.sourceHash}
      AND parser_profile=${key.parserProfile} AND options_hash=${key.optionsHash}`.execute(tx);
    return { cached: null };
  });
  if (claim.cached) return claim.cached;
  try {
    const result = await run();
    const saved = await sql`UPDATE document_parse_cache SET
      result=CASE WHEN ${result.parseStatus === 'READY'} THEN ${JSON.stringify(result)}::jsonb ELSE result END,
      owner=null, lease_until=null, updated_at=now()
      WHERE project_id=${key.projectId} AND upload_id=${key.uploadId} AND source_sha256=${key.sourceHash}
      AND parser_profile=${key.parserProfile} AND options_hash=${key.optionsHash}
      AND owner=${owner} AND lease_until > now()`.execute(store.db);
    if (!Number(saved.numAffectedRows)) throw new Error('parse_cache_lease_lost');
    return { ...result, cacheHit: false };
  } finally {
    await sql`UPDATE document_parse_cache SET owner=null, lease_until=null
      WHERE project_id=${key.projectId} AND upload_id=${key.uploadId} AND source_sha256=${key.sourceHash}
      AND parser_profile=${key.parserProfile} AND options_hash=${key.optionsHash} AND owner=${owner}`.execute(store.db);
  }
}
