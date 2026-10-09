import { loadConfig } from '@meeting/providers';
import { sharedKnowledgeCtx } from '../apps/api/src/knowledge.ts';
import { finishImageJob } from '@meeting/knowledge';
import { first, sql } from '@meeting/knowledge-db';
const ctx = await sharedKnowledgeCtx(loadConfig())();
if (!ctx) throw new Error('knowledge_disabled');
try {
  const job = await first<any>(sql`SELECT * FROM image_jobs ORDER BY created_at DESC LIMIT 1`, ctx.store.db);
  console.log('job', job.id, job.status);
  const refs = await ctx.store.getUploadsByIds(job.project_id, (await ctx.store.getApproval(job.approval_id, job.project_id))!.after.image_brief.references.map((r: any) => r.upload_id));
  console.log('rights', refs.map((r: any) => ({ id: r.id, state: r.state, rights: Boolean(r.rights_note?.trim()) })));
  if (refs.some((r: any) => r.asset_id && !r.rights_note?.trim())) {
    await finishImageJob(ctx.store, job.id, 'FAILED', 'REFERENCE_RIGHTS_REQUIRED', undefined, job.execution_token);
    console.log('failed_job_recorded');
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await ctx.store.close(); }
