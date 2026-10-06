import 'dotenv/config';
import { KnowledgeStore, sql, rows } from '@meeting/knowledge-db';
import { DiscordCollector, DiscordRest } from '@meeting/knowledge';
import { loadKnowledgeConfig } from '@meeting/providers';

// Discord 텍스트 수집 서비스 — spec §6.3.
// REST 백필 + 주기적 head 대조로 동작하며, Gateway 실시간(P3)과 동시에 canonical
// 이벤트를 만들지 않도록 이 프로세스가 Discord 문서의 유일한 작성자다.

const HEAD_RECONCILE_MS = 30_000;
const BACKFILL_SLICE = 500;

const main = async () => {
  const config = loadKnowledgeConfig();
  if (config.DISCORD_CONTEXT_ENABLED !== 'true' || !config.DISCORD_BOT_TOKEN) {
    process.stdout.write('discord-context disabled (DISCORD_CONTEXT_ENABLED/token)\n');
    return;
  }
  const store = new KnowledgeStore(config.KNOWLEDGE_DATABASE_URL);
  const rest = new DiscordRest(config.DISCORD_BOT_TOKEN);
  const collector = new DiscordCollector(store, rest, config.DISCORD_GUILD_ID);

  const discordSources = async () =>
    rows<{ id: string }>(
      sql`SELECT id FROM knowledge_sources WHERE kind='discord' AND status='ACTIVE'`,
      store.db,
    );
  const scopes = async (sourceId: string) =>
    rows<{ scope_key: string }>(
      sql`SELECT scope_key FROM source_scopes WHERE source_id=${sourceId} AND allowed`,
      store.db,
    );

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));

  while (!stop) {
    for (const src of await discordSources()) {
      for (const scope of await scopes(src.id)) {
        const channelId = scope.scope_key.startsWith('channel:')
          ? scope.scope_key.slice('channel:'.length)
          : scope.scope_key.startsWith('thread:')
            ? scope.scope_key.slice('thread:'.length)
            : null;
        if (!channelId) continue;
        try {
          // 스레드 발견 → 해당 채널의 하위 스레드도 scope로 자동 등록하지 않고
          // 허용 정책 내에서 수집한다 (신규 채널 무단 확장 방지, §5.2).
          const backfill = await collector.backfillChannel(src.id, channelId, {
            limit: BACKFILL_SLICE,
          });
          if (backfill.done) await collector.reconcileHead(src.id, channelId);
        } catch (e) {
          process.stderr.write(`discord-context ${scope.scope_key}: ${e}\n`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, HEAD_RECONCILE_MS));
  }
  await store.close();
};

main().catch((e) => {
  process.stderr.write(`discord-context fatal: ${e}\n`);
  process.exit(1);
});
