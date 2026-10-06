import 'dotenv/config';
import { z } from 'zod';

// 지식 서비스 전용 config — spec §10: 기존 root config의 STT/음성 credential을
// 요구하지 않고 필요한 credential만 검증한다.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROVIDER_MODE: z.enum(['mock', 'real']).default('mock'),

  KNOWLEDGE_DATABASE_URL: z.string().min(1),
  KNOWLEDGE_API_PORT: z.coerce.number().default(3200),

  // 기능 flag — DISCORD_CONTEXT_ENABLED=false 상태에서 COMPLETE 답변 금지 (§16)
  KNOWLEDGE_ENABLED: z.enum(['true', 'false']).default('false'),
  DISCORD_CONTEXT_ENABLED: z.enum(['true', 'false']).default('false'),
  IMAGE_GENERATION_ENABLED: z.enum(['true', 'false']).default('false'),

  UPSTAGE_API_KEY: z.string().default(''),
  UPSTAGE_MODEL: z
    .string()
    .regex(/^solar-(?:pro|mini)\d+(?:-\d+)?$/)
    .default('solar-pro4-260806'),
  UPSTAGE_EMBEDDING_QUERY_MODEL: z.string().default('embedding-query'),
  UPSTAGE_EMBEDDING_DOCUMENT_MODEL: z.string().default('embedding-passage'),

  DISCORD_BOT_TOKEN: z.string().default(''),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/).default('1'),

  // 문답 live 확인 budget (§7: 기본 12초)
  ANSWER_LIVE_REFRESH_BUDGET_MS: z.coerce.number().int().min(1000).default(12_000),

  // 회의 DB 읽기 전용 수집기 — 별도 role, pool 2 (§16)
  MEETING_DATABASE_URL: z.string().optional(),

  // 내부 서비스 서명 키 — api → knowledge-api 서명 검증 (§14)
  INTERNAL_SIGNING_KEY: z.string().min(32).optional(),
});
export type KnowledgeConfig = z.infer<typeof schema>;

export function loadKnowledgeConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeConfig {
  const p = schema.safeParse(env);
  if (!p.success)
    throw new Error(
      'Invalid environment: ' + p.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  const c = p.data;
  if (c.PROVIDER_MODE === 'real') {
    const needed: string[] = ['KNOWLEDGE_DATABASE_URL', 'UPSTAGE_API_KEY'];
    if (c.DISCORD_CONTEXT_ENABLED === 'true') needed.push('DISCORD_BOT_TOKEN');
    const missing = needed.filter((k) => !c[k as keyof KnowledgeConfig]);
    if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);
  }
  return c;
}
