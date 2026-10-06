import { z } from 'zod';
import { sql } from 'kysely';
import { first } from '@meeting/knowledge-db';
import { DomainError } from '@meeting/domain';
import type { ToolRegistry, ToolContext } from './registry.ts';
import type { UploadStorage } from '../uploads.ts';

// 파일 삭제/교체 — spec §5: 삭제는 preview→approval→commit을 거친다.
// commit은 before_hash 재검증 + tombstone + 저장소 파일 제거를 한 단계로.

const ttl = () => Number(process.env.ASSISTANT_APPROVAL_TTL_MS ?? 600_000);

async function uploadOrThrow(ctx: ToolContext, uploadId: string) {
  const u = await ctx.store.getUpload(ctx.projectId, uploadId);
  if (!u || u.state === 'DELETED')
    throw new DomainError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  return u;
}

export function registerFileTools(reg: ToolRegistry, storage: UploadStorage) {
  reg.register({
    name: 'file.preview_delete_or_replace',
    kind: 'preview',
    description: '업로드 파일 삭제 미리보기 — 승인 시 문서 tombstone + 저장소 삭제',
    input: z.strictObject({ upload_id: z.string().uuid() }),
    minRole: 'editor',
    auditKind: 'file.preview_delete',
    async run(ctx, input) {
      const u = await uploadOrThrow(ctx, input.upload_id);
      const doc = u.document_id
        ? await first<{ content_hash: string | null }>(
            sql`SELECT v.content_hash FROM documents d
                LEFT JOIN document_versions v ON v.id=d.current_version_id
                WHERE d.id=${u.document_id}`,
            ctx.store.db,
          )
        : null;
      const approval = await ctx.store.createApproval({
        projectId: ctx.projectId,
        userId: ctx.userId,
        kind: 'file_delete',
        target: {
          upload_id: u.id,
          filename: u.filename,
          document_id: u.document_id ?? null,
        },
        beforeHash: doc?.content_hash ?? null,
        after: null,
        expiresAt: new Date(Date.now() + ttl()),
      });
      return {
        approval_id: approval,
        summary: `파일 "${u.filename}"을(를) 삭제합니다. 지식 검색에서도 제거되며 되돌릴 수 없습니다.`,
        current: { filename: u.filename, mime: u.mime, bytes: u.bytes, state: u.state },
        after: null,
      };
    },
  });

  reg.register({
    name: 'file.commit_delete_or_replace',
    kind: 'commit',
    description: '승인된 파일 삭제를 실행한다',
    input: z.strictObject({ approval_id: z.string().uuid(), after: z.any() }),
    minRole: 'editor',
    auditKind: 'file.commit_delete',
    async run(ctx, input) {
      const approval = await ctx.store.getApproval(input.approval_id, ctx.projectId);
      if (!approval) throw new DomainError('NOT_FOUND', '승인을 찾을 수 없습니다.', 404);
      const uploadId = approval.target.upload_id;
      const u = await uploadOrThrow(ctx, uploadId);
      // before_hash 재검증 — 문서가 preview 이후 바뀌었으면 충돌 (§10.7)
      if (approval.before_hash && u.document_id) {
        const doc = await first<{ content_hash: string | null }>(
          sql`SELECT v.content_hash FROM documents d
              LEFT JOIN document_versions v ON v.id=d.current_version_id
              WHERE d.id=${u.document_id}`,
          ctx.store.db,
        );
        if (doc?.content_hash !== approval.before_hash)
          throw new DomainError(
            'CONFLICT',
            '파일이 변경되었습니다. 미리보기를 다시 생성해 주세요.',
            409,
          );
      }
      if (u.document_id) {
        const src = await first<{ source_id: string }>(
          sql`SELECT source_id FROM documents WHERE id=${u.document_id}`,
          ctx.store.db,
        );
        if (src)
          await ctx.store.applyTombstone(
            `upload:${u.id}`,
            src.source_id,
            '사용자 삭제 (assistant)',
          );
      }
      await ctx.store.updateUpload(u.id, { state: 'DELETED' });
      if (u.storage_key) await storage.remove(u.storage_key).catch(() => {});
      return { deleted: true, filename: u.filename };
    },
  });
}
