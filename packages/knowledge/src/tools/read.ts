import { z } from 'zod';
import { sql, rows, first } from '@meeting/knowledge-db';
import type { ToolContext, ToolRegistry } from './registry.ts';
import { retrieve } from '../retrieve.ts';
import { answerQuestion } from '../answer.ts';
import type { GitHubRest } from '../github.ts';

// 읽기 도구 — spec §6. 전부 reader 최소 권한, 외부 상태를 바꾸지 않는다.

export function registerReadTools(reg: ToolRegistry) {
  reg.register({
    name: 'knowledge.search',
    kind: 'read',
    description: '프로젝트 코퍼스 하이브리드 검색 — 질문자 ACL 적용',
    minRole: 'reader',
    auditKind: 'KNOWLEDGE_SEARCH',
    input: z.object({
      query: z.string().min(1).max(2000),
      limit: z.number().int().max(40).default(20),
    }),
    run: async (ctx, q) =>
      retrieve(ctx.store, {
        projectId: ctx.projectId,
        query: q.query,
        embeddings: ctx.embeddings,
        limit: q.limit,
        acl: ctx.acl,
      }),
  });

  reg.register({
    name: 'knowledge.ask',
    kind: 'read',
    description: '근거 기반 문답 — coverage·재검증 포함, 기존 answer 파이프라인',
    minRole: 'reader',
    auditKind: 'KNOWLEDGE_ASK',
    input: z.object({ question: z.string().min(1).max(4000) }),
    run: async (ctx, q) => {
      if (!ctx.model) throw new Error('model_unavailable');
      return answerQuestion(
        {
          store: ctx.store,
          model: ctx.model,
          embeddings: ctx.embeddings,
          discordRead: ctx.discordRead,
          userId: ctx.userId,
          acl: ctx.acl,
        },
        ctx.projectId,
        { question: q.question, temporal_mode: 'current' },
      );
    },
  });

  reg.register({
    name: 'knowledge.get_evidence',
    kind: 'read',
    description: '저장된 답변의 근거 목록 — ACL 재검증된 항목만',
    minRole: 'reader',
    auditKind: 'KNOWLEDGE_EVIDENCE',
    input: z.object({ answer_id: z.string().uuid() }),
    run: async (ctx, q) =>
      rows<any>(
        sql`SELECT document_id, source, url, quote, observed_at FROM answer_evidence
            WHERE answer_run_id=${q.answer_id}`,
        ctx.store.db,
      ),
  });

  reg.register({
    name: 'discord.refresh_context',
    kind: 'read',
    description: '허용된 Discord 채널 head 재대조 — 실패 시 gap 보고',
    minRole: 'reader',
    auditKind: 'DISCORD_REFRESH',
    input: z.object({}),
    run: async (ctx) => {
      if (!ctx.discordRead) return { ok: false, gaps: ['discord_context_disabled'] };
      return ctx.discordRead(10_000);
    },
  });

  reg.register({
    name: 'meeting.search_transcript',
    kind: 'read',
    description: 'Juncoy 회의 전사 검색 — canonical 세그먼트만',
    minRole: 'reader',
    auditKind: 'MEETING_SEARCH',
    input: z.object({
      query: z.string().min(1).max(1000),
      limit: z.number().int().max(20).default(10),
    }),
    run: async (ctx, q) =>
      rows<any>(
        sql`SELECT d.stable_key, coalesce(d.metadata->>'title', d.stable_key) AS title,
              c.content, c.span
            FROM chunks c
            JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
            JOIN documents d ON d.id=s.document_id AND s.version_id=d.current_version_id
            JOIN knowledge_sources src ON src.id=d.source_id
            WHERE src.project_id=${ctx.projectId} AND src.kind='meeting'
              AND NOT d.deleted AND d.state='READY' AND NOT d.dirty
              AND c.content ILIKE ${'%' + q.query.replace(/[%_]/g, '') + '%'}
            ORDER BY d.updated_at DESC LIMIT ${q.limit}`,
        ctx.store.db,
      ),
  });

  reg.register({
    name: 'github.search_code',
    kind: 'read',
    description: 'Team_23 코드 검색 — 수집된 코퍼스에서',
    minRole: 'reader',
    auditKind: 'GITHUB_SEARCH',
    input: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().max(20).default(10),
    }),
    run: async (ctx, q) =>
      rows<any>(
        sql`SELECT d.stable_key, c.content, c.span
            FROM chunks c
            JOIN chunk_sets s ON s.id=c.chunk_set_id AND s.active
            JOIN documents d ON d.id=s.document_id AND s.version_id=d.current_version_id
            JOIN knowledge_sources src ON src.id=d.source_id
            WHERE src.project_id=${ctx.projectId} AND src.kind='github'
              AND NOT d.deleted AND d.state='READY' AND NOT d.dirty
              AND c.content ILIKE ${'%' + q.query.replace(/[%_]/g, '') + '%'}
            ORDER BY d.stable_key LIMIT ${q.limit}`,
        ctx.store.db,
      ),
  });

  reg.register({
    name: 'github.fetch_file',
    kind: 'read',
    description: 'GitHub 파일 내용 — repo/ref/path를 검증된 형식으로',
    minRole: 'reader',
    auditKind: 'GITHUB_FETCH',
    input: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      ref: z.string().regex(/^[\w./-]{1,100}$/),
      path: z.string().regex(/^[\w./-]{1,500}$/),
    }),
    run: async (ctx, q) => {
      const gh = ctx.deps.github as GitHubRest | undefined;
      if (!gh) throw new Error('github_connector_unavailable');
      const r = await gh.request(`/repos/${q.repo}/contents/${q.path}`, { ref: q.ref });
      if (r.status !== 200) throw new Error(`github_fetch_${r.status}`);
      const body = r.body as any;
      return {
        path: q.path,
        size: body.size,
        sha: body.sha,
        encoding: body.encoding,
        content: body.content
          ? Buffer.from(body.content, 'base64').toString('utf8').slice(0, 200_000)
          : null,
      };
    },
  });

  reg.register({
    name: 'file.get_ingestion_status',
    kind: 'read',
    description: '업로드 파일의 ingest 상태',
    minRole: 'reader',
    auditKind: 'FILE_STATUS',
    input: z.object({ upload_id: z.string().uuid() }),
    run: async (ctx, q) =>
      first<any>(
        sql`SELECT id, filename, mime, bytes, state, error, created_at FROM knowledge_uploads
            WHERE id=${q.upload_id} AND project_id=${ctx.projectId}`,
        ctx.store.db,
      ),
  });
}
