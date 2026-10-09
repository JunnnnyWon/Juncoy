import { loadConfig } from '@meeting/providers';
import { sharedKnowledgeCtx } from '../apps/api/src/knowledge.ts';
import { buildImagePrompt } from '@meeting/knowledge';
import { ImageBriefDraft } from '@meeting/contracts';
const ctx = await sharedKnowledgeCtx(loadConfig())();
if (!ctx) throw new Error('knowledge_disabled');
try {
  console.log('rag_start');
  const rag = await buildImagePrompt(ctx.store, { projectId: '0f11f66f-bc96-4c3d-b41f-738ebf797186', request: '현재 보드 기준 캐릭터 컨셉 아트', embeddings: ctx.embeddings });
  console.log('rag_ok', rag.evidence.length);
  const drafted = await ctx.model.structured(ImageBriefDraft, { request: '레퍼런스 보드의 공간 컨셉 아트', project_evidence: rag.prompt }, '프로젝트 근거로 이미지 생성용 prompt, negative_constraints, role_directives를 작성한다.');
  console.log('draft_ok', drafted.result.prompt.length);
} catch (error) { console.error('preview_failure', error); process.exitCode = 1; }
finally { await ctx.store.close(); }
