import { z } from 'zod';
import { sql, first } from '@meeting/knowledge-db';
import { DomainError } from '@meeting/domain';
import type { ToolContext, ToolRegistry } from './registry.ts';
import { buildImagePrompt } from '../image-prompt.ts';
import {
  OpenRouterImages,
  createImageJob,
  finishImageJob,
  imageCountToday,
} from '../image-openrouter.ts';
import type { UploadStorage } from '../uploads.ts';
import { randomUUID } from 'node:crypto';

// 이미지 생성 — spec §12: preview는 프롬프트 합성만, generate는 명시적 승인 후 실행.
// provider 미설정이면 "생성됐다"고 거짓 보고하지 않고 prompt_only로 보고한다.

const ttl = () => Number(process.env.ASSISTANT_APPROVAL_TTL_MS ?? 600_000);
const REQUIRED_IMAGE_MODEL = 'openai/gpt-image-2.5-flare';

function imageProvider(): OpenRouterImages | null {
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_IMAGE_MODEL ?? REQUIRED_IMAGE_MODEL;
  if (!key || process.env.IMAGE_GENERATION_ENABLED !== 'true') return null;
  if (model !== REQUIRED_IMAGE_MODEL) return null;
  return new OpenRouterImages(key, REQUIRED_IMAGE_MODEL, Number(process.env.IMAGE_CONCURRENCY ?? 2));
}

export function registerImageTools(reg: ToolRegistry, storage: UploadStorage) {
  reg.register({
    name: 'image.preview_generation',
    kind: 'preview',
    description: '이미지 생성 미리보기 — 근거 기반 프롬프트 합성, 생성은 승인 후',
    input: z.strictObject({
      request: z.string().min(1).max(2000),
      reference_upload_ids: z.array(z.string().uuid()).max(16).default([]),
      reference_instructions: z.record(z.string(), z.string()).default({}),
    }),
    minRole: 'editor',
    auditKind: 'image.preview',
    async run(ctx, q) {
      const built = await buildImagePrompt(ctx.store, {
        projectId: ctx.projectId,
        request: q.request,
        embeddings: ctx.embeddings,
        acl: ctx.acl,
      });
      const provider = imageProvider();
      if (!provider)
        // provider off → 프롬프트만 반환, 절대 "생성"으로 표시하지 않는다 (§17)
        return {
          mode: 'prompt_only',
          prompt: built.prompt,
          negative: built.negative,
          evidence: built.evidence,
          reference_upload_ids: q.reference_upload_ids,
          reference_instructions: q.reference_instructions,
          style_approved: built.style_approved,
          note: '이미지 provider가 설정되지 않았습니다. 프롬프트만 생성됩니다.',
        };
      const approvalId = await ctx.store.createApproval({
        projectId: ctx.projectId,
        userId: ctx.userId,
        kind: 'image_generate',
        target: { prompt_preview: built.prompt.slice(0, 400) },
        beforeHash: null,
        after: {
          prompt: built.prompt,
          negative: built.negative,
          model: REQUIRED_IMAGE_MODEL,
          evidence: built.evidence,
        },
        expiresAt: new Date(Date.now() + ttl()),
      });
      return {
        approval_id: approvalId,
        summary: `이미지 생성: "${q.request.slice(0, 120)}"`,
        prompt: built.prompt,
        negative: built.negative,
        evidence: built.evidence,
        style_approved: built.style_approved,
        mode: 'preview',
      };
    },
  });

  reg.register({
    name: 'image.generate',
    kind: 'commit',
    description: '승인된 이미지 생성을 OpenRouter로 실행한다',
    input: z.strictObject({ approval_id: z.string().uuid(), after: z.any().optional() }),
    minRole: 'editor',
    auditKind: 'image.generate',
    async run(ctx, q) {
      const provider = imageProvider();
      if (!provider)
        throw new DomainError('PROVIDER_OFF', '이미지 생성이 비활성화되어 있습니다.', 503);
      const approval = await ctx.store.getApproval(q.approval_id, ctx.projectId);
      if (!approval) throw new DomainError('NOT_FOUND', '승인을 찾을 수 없습니다.', 404);
      const limit = Number(process.env.IMAGE_DAILY_LIMIT ?? 50);
      const today = await imageCountToday(ctx.store, ctx.projectId);
      if (today >= limit)
        throw new DomainError('QUOTA_EXCEEDED', `일일 생성 한도(${limit}장)에 도달했습니다.`, 429);

      const after = approval.after as any;
      if (after.model !== REQUIRED_IMAGE_MODEL)
        throw new DomainError('IMAGE_MODEL_MISMATCH', 'GPT Image 2.5 Flare만 사용할 수 있습니다.', 409);
      const jobId = await createImageJob(ctx.store, {
        projectId: ctx.projectId,
        ownerId: ctx.userId,
        approvalId: approval.id,
        model: after.model,
        prompt: after.prompt,
        negative: after.negative,
        evidence: after.evidence,
        idempotencyKey: `approval:${approval.id}`,
      });
      try {
        const refs = await ctx.store.getUploadsByIds(
          ctx.projectId,
          after.reference_upload_ids ?? [],
        );
        const missing = (after.reference_upload_ids ?? []).filter(
          (id: string) => !refs.some((ref: any) => ref.id === id),
        );
        if (missing.length)
          throw new DomainError('REFERENCE_NOT_FOUND', '이미지 레퍼런스를 찾을 수 없습니다.', 409);
        const referenceInputs = await Promise.all(
          refs.map(async (ref: any) => ({
            bytes: await storage.read(ref.storage_key),
            mime: ref.mime,
            role: 'project reference',
            instruction: after.reference_instructions?.[ref.id],
          })),
        );
        const out = await provider.generate(after.prompt, after.negative, referenceInputs);
        const buf = Buffer.from(out.b64, 'base64');
        const resultKey = `img-${randomUUID()}.png`;
        await storage.put(resultKey, buf);
        await finishImageJob(ctx.store, jobId, 'DONE', undefined, {
          storageKey: resultKey,
          bytes: buf.length,
          width: out.width,
          height: out.height,
        });
        const r = await first<{ id: string }>(
          sql`SELECT id FROM image_results WHERE job_id=${jobId}`,
          ctx.store.db,
        );
        return { image_id: r?.id, bytes: buf.length, model: after.model };
      } catch (err: any) {
        await finishImageJob(ctx.store, jobId, 'FAILED', String(err?.message ?? err));
        throw err;
      }
    },
  });
}
