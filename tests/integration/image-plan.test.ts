import { it, expect, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';
import { ToolRegistry, registerImageTools, UploadStorage } from '@meeting/knowledge';
import { imageBriefHashInput } from '@meeting/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('v2 stores exact empty UI inputs, result and unknown cost; rejects legacy approvals', async () => {
  if (!process.env.KNOWLEDGE_DATABASE_URL) throw new Error('knowledge DB required');
  const admin = new KnowledgeStore(process.env.KNOWLEDGE_DATABASE_URL);
  const schema = 'imageqa_' + randomUUID().replaceAll('-', '');
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin.db);
  const url = new URL(process.env.KNOWLEDGE_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const store = new KnowledgeStore(url.toString());
  const dir = await mkdtemp(join(tmpdir(), 'imageqa-'));
  const env = { key: process.env.OPENROUTER_API_KEY, enabled: process.env.IMAGE_GENERATION_ENABLED, model: process.env.OPENROUTER_IMAGE_MODEL };
  try {
    await store.migrate();
    const projectId = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${projectId},'test')`.execute(store.db);
    const boardId = await store.createArtBoard(projectId, 'qa');
    await store.saveArtBoardRevision({ projectId, ownerId: 'qa', boardId, baseRevision: 0, snapshot: { references: [] }, snapshotHash: 'test' });
    const plan = { operation: 'new', output: 'ui', preserve: [], change: ['UI 설계'], free: ['구도'], primary: null, supporting: [] };
    const hash = (data: unknown) => createHash('sha256').update(imageBriefHashInput(data)).digest('hex');
    const brief = { schema_version: 2, request: 'UI', plan, plan_hash: hash(plan), role_directives: [], negative_constraints: [], board_id: boardId, board_revision: 1, art_bible_version: null, references: [], evidence: [], coverage: Object.fromEntries(['notion','github','discord','meeting'].map(s => [s, { read_status: 'NOT_CONFIGURED', latest_at: null, gaps: [] }])), provider: 'openrouter', model: 'openai/gpt-image-2.5-flare', prompt: 'UI without character', prompt_hash: createHash('sha256').update('UI without character').digest('hex') };
    const approvalId = await store.createApproval({ projectId, userId: 'qa', kind: 'image_generate', target: {}, after: { image_brief: { ...brief, brief_hash: hash(brief) }, model: brief.model }, expiresAt: new Date(Date.now()+600000) });
    process.env.OPENROUTER_API_KEY='test'; process.env.IMAGE_GENERATION_ENABLED='true'; process.env.OPENROUTER_IMAGE_MODEL=brief.model;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'cG5n' }], id: 'qa-request' })));
    vi.stubGlobal('fetch', fetcher);
    const reg = new ToolRegistry(); registerImageTools(reg, new UploadStorage(dir));
    const ctx = { store, projectId, userId: 'qa', role: 'editor' as const, deps: {} };
    const result = await reg.execute(ctx, 'image.generate', { approval_id: approvalId });
    expect(result.ok).toBe(true);
    const job = await first<any>(sql`SELECT * FROM image_jobs WHERE approval_id=${approvalId}`,store.db);
    expect(job.status).toBe('DONE'); expect(job.options.actual_inputs).toEqual([]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).input_references).toEqual([]);
    expect((await first<any>(sql`SELECT cost_status FROM image_results WHERE job_id=${job.id}`,store.db)).cost_status).toBe('UNKNOWN');
    await reg.execute(ctx, 'image.generate', { approval_id: approvalId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const original = await first<any>(sql`SELECT * FROM image_results WHERE job_id=${job.id}`, store.db);
    for (const operation of ['edit', 'variant', 'recompose']) {
      const editPlan = { ...plan, operation, preserve: operation === 'edit' ? ['인물', '구도'] : operation === 'recompose' ? ['HUD'] : ['화풍'], change: ['조명'], primary: { id: original.id, hash: original.sha256, purpose: operation === 'recompose' ? 'HUD만 참고' : operation === 'variant' ? '화풍만 참고' : '인물·구도 유지, 조명 변경' }, supporting: [] };
      const editBrief = { ...brief, plan: editPlan, plan_hash: hash(editPlan) };
      const editId = await store.createApproval({ projectId, userId: 'qa', kind: 'image_generate', target: {}, after: { image_brief: { ...editBrief, brief_hash: hash(editBrief) }, model: brief.model }, expiresAt: new Date(Date.now()+600000) });
      await reg.execute(ctx, 'image.generate', { approval_id: editId });
      const editJob = await first<any>(sql`SELECT * FROM image_jobs WHERE approval_id=${editId}`, store.db);
      expect(editJob.options.actual_inputs).toEqual([editPlan.primary]);
      expect((await first<any>(sql`SELECT count(*)::int AS count FROM image_job_references WHERE image_job_id=${editJob.id}`, store.db)).count).toBe(0);
      const payload = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
      expect(payload.input_references).toHaveLength(1);
      expect(payload.prompt).toContain(editPlan.primary.purpose);
    }
    const legacy = { ...brief, schema_version: 1 }; delete (legacy as any).plan; delete (legacy as any).plan_hash;
    const oldId = await store.createApproval({ projectId, userId: 'qa', kind: 'image_generate', target: {}, after: { image_brief: { ...legacy, brief_hash: hash(legacy) }, model: brief.model }, expiresAt: new Date(Date.now()+600000) });
    await expect(reg.execute(ctx, 'image.generate', { approval_id: oldId })).rejects.toThrow('다시 생성 준비');
  } finally {
    vi.unstubAllGlobals();
    for (const [k,v] of Object.entries({ OPENROUTER_API_KEY:env.key, IMAGE_GENERATION_ENABLED:env.enabled, OPENROUTER_IMAGE_MODEL:env.model })) { if(v===undefined) delete process.env[k]; else process.env[k]=v; }
    await store.close(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin.db); await admin.close(); await rm(dir,{recursive:true,force:true});
  }
});
