import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {KnowledgeStore,sql} from '@meeting/knowledge-db';
import {ToolRegistry,registerReadTools} from '@meeting/knowledge';
it('reads live commits only from the current project allowed active repository and branch',async()=>{
  if(!process.env.KNOWLEDGE_DATABASE_URL) throw new Error('knowledge DB required');
  const admin=new KnowledgeStore(process.env.KNOWLEDGE_DATABASE_URL);
  const schema='commitqa_'+randomUUID().replaceAll('-','');
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin.db);
  const url=new URL(process.env.KNOWLEDGE_DATABASE_URL); url.searchParams.set('options','-c search_path='+schema+',public');
  const store=new KnowledgeStore(url.toString());
  try {
    await store.migrate();
    const project=randomUUID(), other=randomUUID(), source=randomUUID(), otherSource=randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'qa'),(${other},'other')`.execute(store.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref) VALUES(${source},${project},'github','qa'),(${otherSource},${other},'github','other')`.execute(store.db);
    for(const [id,key,repo,allowed] of [[source,'ref:main','org/game',true],[source,'ref:secret','org/game',false],[otherSource,'ref:main','org/private',true]] as const)
      await sql`INSERT INTO source_scopes(id,source_id,scope_key,metadata,allowed) VALUES(${randomUUID()},${id},${key},${JSON.stringify({repo})}::jsonb,${allowed})`.execute(store.db);
    const request=vi.fn().mockResolvedValue({status:200,body:[{sha:'a'.repeat(40),commit:{message:'fix game\nextra',author:{name:'Team',date:'2026-10-10T03:00:00Z'}}}]});
    const ctx={store,projectId:project,userId:'qa',role:'reader' as const,deps:{github:{request}}};
    const reg=new ToolRegistry();registerReadTools(reg);
    const result=await reg.execute(ctx,'github.list_commits',{});
    expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
    expect(result.result).toMatchObject({status:'OK',repo:'org/game',ref:'main',commits:[{title:'fix game'}]});
    expect(request).toHaveBeenCalledWith('/repos/org/game/commits',{sha:'main',per_page:'10'});
    await expect(reg.execute(ctx,'github.list_commits',{repo:'org/private'})).rejects.toThrow('not_allowed');
    await expect(reg.execute(ctx,'github.list_commits',{ref:'secret'})).rejects.toThrow('not_allowed');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({status:403,body:{message:'denied'}});
    const failed=await reg.execute(ctx,'github.list_commits',{});expect(failed.ok && failed.result).toMatchObject({status:'UNAVAILABLE',provider_status:403});
    request.mockResolvedValue({status:200,body:[]});
    const empty=await reg.execute(ctx,'github.list_commits',{});expect(empty.ok && empty.result).toMatchObject({status:'OK',commits:[]});
    await sql`UPDATE knowledge_sources SET status='DISABLED' WHERE id=${source}`.execute(store.db);
    const disabled=await reg.execute(ctx,'github.list_commits',{});expect(disabled.ok && disabled.result).toMatchObject({status:'NOT_CONFIGURED'});
  } finally {await store.close();await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin.db);await admin.close();}
});
