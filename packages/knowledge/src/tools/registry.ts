import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AssistantRole, AssistantToolName } from '@meeting/contracts';
import type { KnowledgeStore } from '@meeting/knowledge-db';
import type { AclInput } from '../retrieve.ts';
import type { ChatModel } from '../answer.ts';
import type { UpstageEmbeddings } from '../embeddings.ts';
import type { DiscordLiveRead } from '../answer.ts';

// 도구 레지스트리 — spec §6: 모든 외부 접근은 서버가 검증한 도구를 통해서만.
// 모델은 도구 이름과 입력만 고른다. URL·토큰·임의 SQL은 입력으로 받지 않는다.

export interface ToolContext {
  store: KnowledgeStore;
  projectId: string;
  userId: string;
  role: AssistantRole;
  acl?: AclInput;
  model?: ChatModel;
  embeddings?: UpstageEmbeddings;
  discordRead?: DiscordLiveRead;
  /** connector adapter는 호출 시점에 주입 — registry 자체는 무상태. */
  deps: Record<string, unknown>;
}

export type ToolKind = 'read' | 'preview' | 'commit';

export interface ToolDef<I = unknown, O = unknown> {
  name: AssistantToolName;
  kind: ToolKind;
  description: string;
  input: z.ZodType<I>;
  /** 필요 최소 역할. reader=조회만, editor=preview+commit, admin=파괴적 commit. */
  minRole: AssistantRole;
  auditKind: string;
  run: (ctx: ToolContext, input: I) => Promise<O>;
}

const RANK: Record<AssistantRole, number> = { reader: 0, editor: 1, admin: 2 };

export class ToolRegistry {
  private tools = new Map<string, ToolDef<any, any>>();

  register(def: ToolDef<any, any>) {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  names() {
    return [...this.tools.keys()];
  }

  /** 권한 + 입력 검증 후 실행. 미등록/권한 부족/스키마 불일치는 모두 거부. */
  async execute(ctx: ToolContext, name: string, rawInput: unknown, idempotencyKey?: string) {
    const def = this.tools.get(name);
    if (!def) return { ok: false as const, error: `unknown_tool:${name}` };
    if (RANK[ctx.role] < RANK[def.minRole])
      return { ok: false as const, error: `role_required:${def.minRole}` };
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success)
      return { ok: false as const, error: `bad_input:${parsed.error.issues[0]?.path.join('.')}` };
    const inputSchemaHash = createHash('sha256')
      .update(JSON.stringify(z.toJSONSchema(def.input, { target: 'draft-7' })))
      .digest('hex')
      .slice(0, 16);
    try {
      const result = await def.run(ctx, parsed.data as any);
      return { ok: true as const, result, inputSchemaHash, auditKind: def.auditKind, idempotencyKey };
    } catch (e) {
      // 커넥터 미설정·provider 오류·타임아웃 같은 도구 내부 예외가 run 전체를
      // 죽이지 않게 구조화된 실패로 변환한다 (QA 10-12). 원본 메시지만 남기고
      // 스택·시크릿이 섞인 오류 객체는 노출하지 않는다.
      return {
        ok: false as const,
        error: `tool_error:${String((e as any)?.message ?? e).slice(0, 200)}`,
      };
    }
  }
}
