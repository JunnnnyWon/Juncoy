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
  getImageJobResult,
  claimImageJob,
} from '../image-openrouter.ts';
import type { UploadStorage } from '../uploads.ts';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { orderedImageReferences } from '../image-references.ts';
import { ImageBrief, ImageBriefDraft, imageBriefHashInput } from '@meeting/contracts';
import sharp from 'sharp';

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
      if (!ctx.model) throw new DomainError('MODEL_UNAVAILABLE', 'Solar 모델을 사용할 수 없습니다.', 503);
      const built = await buildImagePrompt(ctx.store, {
        projectId: ctx.projectId,
        request: q.request,
        embeddings: ctx.embeddings,
        acl: ctx.acl,
      });
      const drafted = await ctx.model.structured(ImageBriefDraft, { request: q.request, retrieved_evidence: built.prompt, approved_style: built.style_approved ? built.style_version : null, selected_reference_instructions: q.reference_instructions },
        '입력된 프로젝트 근거와 승인된 스타일만 사용해 GPT Image 2.5 Flare용 구체적인 prompt와 negative constraints를 작성한다. 인물/설정/권리 사실을 추정하지 않는다.');
      const prompt = drafted.result.prompt;
      const negative = drafted.result.negative_constraints.join(', ');
      const provider = imageProvider();
      if (!provider)
        // provider off → 프롬프트만 반환, 절대 "생성"으로 표시하지 않는다 (§17)
        return {
          mode: 'prompt_only',
          prompt,
          negative,
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
        target: { prompt_preview: prompt.slice(0, 400) },
        beforeHash: null,
        after: {
          prompt,
          negative,
          model: REQUIRED_IMAGE_MODEL,
          reference_upload_ids: q.reference_upload_ids,
          reference_instructions: q.reference_instructions,
          style_version: built.style_version,
          evidence: built.evidence,
        },
        expiresAt: new Date(Date.now() + ttl()),
      });
      return {
        approval_id: approvalId,
        summary: `이미지 생성: "${q.request.slice(0, 120)}"`,
        prompt,
        negative,
        evidence: built.evidence,
        style_approved: built.style_approved,
        style_version: built.style_version,
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
      const brief = ImageBrief.parse(after.image_brief);
      if (brief.schema_version !== 2 || !brief.plan) throw new DomainError('BRIEF_REVIEW_REQUIRED', '생성 조건이 업데이트되었습니다. 다시 생성 준비를 실행해 주세요.', 409);
      const plan = brief.plan;
      if (createHash('sha256').update(imageBriefHashInput(plan)).digest('hex') !== brief.plan_hash) throw new DomainError('BRIEF_HASH_MISMATCH', '생성 계획이 변경되었습니다.', 409);
      const briefHash = createHash('sha256').update(imageBriefHashInput(brief)).digest('hex');
      if (briefHash !== brief.brief_hash)
        throw new DomainError('BRIEF_HASH_MISMATCH', 'ImageBrief가 변경되었습니다. 다시 검토해야 합니다.', 409);
      if (after.model !== REQUIRED_IMAGE_MODEL || brief.model !== REQUIRED_IMAGE_MODEL)
        throw new DomainError('IMAGE_MODEL_MISMATCH', 'GPT Image 2.5 Flare만 사용할 수 있습니다.', 409);
      const board = await ctx.store.getArtBoard(ctx.projectId, ctx.userId, brief.board_id);
      if (!board || Number(board.current_revision) !== brief.board_revision)
        throw new DomainError('BRIEF_STALE', '보드가 변경되어 ImageBrief를 다시 검토해야 합니다.', 409);
      const style = await ctx.store.getApprovedStyleProfile(ctx.projectId);
      if ((style?.version ?? null) !== brief.art_bible_version)
        throw new DomainError('ART_BIBLE_STALE', 'Art Bible이 변경되어 ImageBrief를 다시 검토해야 합니다.', 409);
      const job = await createImageJob(ctx.store, {
        projectId: ctx.projectId,
        ownerId: ctx.userId,
        approvalId: approval.id,
        model: after.model,
        prompt: brief.prompt,
        negative: after.negative,
        evidence: brief.evidence,
        briefHash: brief.brief_hash,
        boardId: brief.board_id,
        boardRevision: brief.board_revision,
        artBibleVersion: brief.art_bible_version,
        idempotencyKey: `approval:${approval.id}`,
      });
      const jobId = job.id;
      const existingJob = await getImageJobResult(ctx.store, ctx.projectId, jobId);
      if (existingJob?.status === 'DONE' && existingJob.result_id)
        return { image_id: existingJob.result_id, model: after.model, reused: true };
      if (!job.created && existingJob?.status !== 'FAILED')
        return { job_id: jobId, model: after.model, status: existingJob.status, reused: true };
      const executionToken = await claimImageJob(ctx.store, jobId);
      if (!executionToken) {
        const current = await getImageJobResult(ctx.store, ctx.projectId, jobId);
        return { job_id: jobId, model: after.model, status: current?.status ?? 'RUNNING', reused: true };
      }
      try {
        const fetchedRefs = await ctx.store.getUploadsByIds(
          ctx.projectId,
          brief.references.map((ref) => ref.upload_id),
        );
        const refs = orderedImageReferences(brief.references.map((ref) => ref.upload_id), fetchedRefs);
        for (const ref of brief.references) {
          const row = refs.find((candidate: any) => candidate.id === ref.upload_id) as any;
          if (!row || row.sha256 !== ref.source_sha256 || (row.asset_id ?? null) !== ref.asset_id)
            throw new DomainError('BRIEF_REFERENCE_CHANGED', 'ImageBrief의 레퍼런스 원본이 변경되었습니다.', 409);
        }
        const referenceInputs = await Promise.all(
          refs.map(async (ref: any) => {
            const briefRef = brief.references.find((candidate) => candidate.upload_id === ref.id);
            let bytes = await storage.read(ref.storage_key);
            if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
              throw new DomainError('REFERENCE_HASH_MISMATCH', '레퍼런스 원본 hash가 변경되었습니다.', 409);
            if (briefRef?.crop) {
              const metadata = await sharp(bytes).metadata();
              if (!metadata.width || !metadata.height) throw new DomainError('REFERENCE_DIMENSIONS_UNKNOWN', '레퍼런스 크기를 확인할 수 없습니다.', 409);
              bytes = Buffer.from(await sharp(bytes).extract({
                left: Math.floor(briefRef.crop.left * metadata.width),
                top: Math.floor(briefRef.crop.top * metadata.height),
                width: Math.max(1, Math.floor((briefRef.crop.right - briefRef.crop.left) * metadata.width)),
                height: Math.max(1, Math.floor((briefRef.crop.bottom - briefRef.crop.top) * metadata.height)),
              }).png().toBuffer());
            }
            return {
            bytes,
            mime: ref.mime,
            role: briefRef ? briefRef.role.join(', ') : 'project reference',
            instruction: briefRef?.instruction,
            };
          }),
        );
        for (const [index, ref] of refs.entries()) {
          const briefRef = brief.references[index]!;
          await sql`INSERT INTO image_job_references(
            id, image_job_id, asset_id, upload_id, role_json, usage_strength, instruction, content_hash, acl_snapshot, asset_revision, source_sha256, crop
          ) VALUES (
            ${randomUUID()}, ${jobId}, ${ref.asset_id ?? null}, ${ref.id},
            ${JSON.stringify({ roles: briefRef.role, order: briefRef.order })},
            ${JSON.stringify(briefRef.usage)}, ${briefRef.instruction}, ${ref.sha256},
            ${JSON.stringify({ project_id: ctx.projectId, user_id: ctx.userId, canonical_state: ref.canonical_state ?? null, asset_state: ref.asset_state ?? null })}
            , ${briefRef.asset_revision}, ${briefRef.source_sha256}, ${briefRef.crop ? JSON.stringify(briefRef.crop) : null}::jsonb
          )`.execute(ctx.store.db);
        }
        let inputs = referenceInputs;
        if (plan.primary) {
          const parent = await first<any>(sql`SELECT r.storage_key, r.mime, r.sha256 FROM image_results r JOIN image_jobs j ON j.id=r.job_id WHERE r.id=${plan.primary.id} AND j.project_id=${ctx.projectId} AND j.owner_id=${ctx.userId}`, ctx.store.db);
          if (!parent) throw new DomainError('IMAGE_NOT_FOUND', '수정할 이미지를 찾을 수 없습니다.', 404);
          if (parent.sha256 !== plan.primary.hash) throw new DomainError('IMAGE_HASH_MISMATCH', '승인된 원본이 변경되었습니다.', 409);
          const bytes = await storage.read(parent.storage_key);
          if (parent.sha256 && createHash('sha256').update(bytes).digest('hex') !== parent.sha256) throw new DomainError('IMAGE_HASH_MISMATCH', '수정할 원본을 확인하지 못했습니다.', 409);
          inputs = [{ bytes, mime: parent.mime ?? 'image/png', role: plan.operation === 'edit' ? 'EDIT_SOURCE' : 'SCOPED_REFERENCE', instruction: plan.primary.purpose }];
          for (const reference of plan.supporting) {
            const row = await first<any>(sql`SELECT r.storage_key,r.mime,r.sha256 FROM image_results r JOIN image_jobs j ON j.id=r.job_id WHERE r.id=${reference.id} AND j.project_id=${ctx.projectId} AND j.owner_id=${ctx.userId}`, ctx.store.db);
            if (!row) throw new DomainError("IMAGE_NOT_FOUND", "보조 참고 이미지를 찾을 수 없습니다.", 404);
            if (row.sha256 !== reference.hash) throw new DomainError('IMAGE_HASH_MISMATCH', '보조 참고 원본이 변경되었습니다.', 409);
            const bytes = await storage.read(row.storage_key);
            if (row.sha256 && createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new DomainError("IMAGE_HASH_MISMATCH", "보조 원본을 확인하지 못했습니다.", 409);
            inputs.push({ bytes, mime: row.mime ?? "image/png", role: "SUPPORTING_REFERENCE", instruction: reference.purpose });
          }
          await sql`UPDATE image_jobs SET options=${JSON.stringify({ plan, parent_image_id: plan.primary.id, reference_images: plan.supporting, actual_inputs: [plan.primary, ...plan.supporting] })}::jsonb WHERE id=${jobId}`.execute(ctx.store.db);
        }
        if (!plan.primary) await sql`UPDATE image_jobs SET options=${JSON.stringify({ plan, actual_inputs: brief.references.map(ref => ({ upload_id: ref.upload_id, hash: ref.source_sha256, purpose: ref.purpose, usage: ref.usage, crop: ref.crop, order: ref.order })) })}::jsonb WHERE id=${jobId}`.execute(ctx.store.db);
        const out = await provider.generate(brief.prompt, after.negative, inputs);
        const buf = Buffer.from(out.b64, 'base64');
        const resultKey = `img-${randomUUID()}.png`;
        await storage.put(resultKey, buf);
        await finishImageJob(ctx.store, jobId, 'DONE', undefined, {
          storageKey: resultKey,
          bytes: buf.length,
          width: out.width,
          height: out.height,
          mime: out.mime ?? 'image/png',
          sha256: createHash('sha256').update(buf).digest('hex'),
          requestId: out.requestId,
          costUsd: out.costUsd,
        }, executionToken);
        const r = await first<{ id: string }>(
          sql`SELECT id FROM image_results WHERE job_id=${jobId}`,
          ctx.store.db,
        );
        return { image_id: r?.id, bytes: buf.length, model: after.model };
      } catch (err: any) {
        await finishImageJob(ctx.store, jobId, 'FAILED', String(err?.message ?? err), undefined, executionToken);
        throw err;
      }
    },
  });

  const preview = reg.get('image.preview_generation')!;
  reg.register({
    name: 'art.preview_image_brief', kind: 'preview',
    description: '프로젝트 RAG와 승인 Art Bible을 반영한 아트 ImageBrief 미리보기',
    input: preview.input, minRole: 'editor', auditKind: 'art.preview_image_brief',
    run: (ctx, input) => preview.run(ctx, input),
  });

  const generate = reg.get('image.generate')!;
  reg.register({
    name: 'art.generate', kind: 'commit',
    description: '승인된 ImageBrief를 같은 이미지 생성 검증 경로로 실행',
    input: generate.input, minRole: 'editor', auditKind: 'art.generate',
    run: (ctx, input) => generate.run(ctx, input),
  });
}
