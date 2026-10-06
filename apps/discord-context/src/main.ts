import 'dotenv/config';
import { KnowledgeStore, sql, rows, first } from '@meeting/knowledge-db';
import {
  DiscordCollector,
  DiscordRest,
  DiscordGateway,
  INTENTS,
} from '@meeting/knowledge';
import { documentKeys } from '@meeting/contracts';
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

  /** 채널/스레드 ID → 등록된 discord source. scope 없는 채널은 수집하지 않는다 (§5.2). */
  const sourceForChannel = async (channelId: string) => {
    const row = await first<{ source_id: string; scope_key: string }>(
      sql`SELECT source_id, scope_key FROM source_scopes
          WHERE allowed AND scope_key IN ('channel:' || ${channelId}, 'thread:' || ${channelId})
          LIMIT 1`,
      store.db,
    );
    return row ? { sourceId: row.source_id, scopeKey: row.scope_key } : null;
  };

  /**
   * 허용 채널 아래 발견된 스레드를 `thread:<id>` scope로 등록하고 그 소스 id를 돌려준다.
   * 부모 채널이 어떤 source에도 allowed가 아니면 등록하지 않는다 — 신규 채널의
   * 무단 범위 확장 방지(§5.2)는 유지되되, 허용 채널의 스레드는 명세대로 수집한다.
   */
  const registerThreadScopes = async (parentChannelId: string, threadIds: string[]) => {
    const src = await sourceForChannel(parentChannelId);
    if (!src) return null;
    for (const tid of threadIds)
      await sql`
        INSERT INTO source_scopes(id, source_id, scope_key, allowed, metadata)
        VALUES (${crypto.randomUUID()}, ${src.sourceId}, ${'thread:' + tid}, true,
          ${JSON.stringify({ parent: parentChannelId })}::jsonb)
        ON CONFLICT (source_id, scope_key) DO UPDATE SET allowed=true`.execute(store.db);
    return src.sourceId;
  };

  /** 스레드/채널 삭제 → 그 아래 메시지 문서를 prefix로 일괄 tombstone (RAG-010). */
  const tombstoneChannel = async (channelId: string, reason: string) => {
    const src = await sourceForChannel(channelId);
    if (!src) return;
    const prefix = `discord:${config.DISCORD_GUILD_ID}:${channelId}:`;
    const n = await store.applyTombstonesByPrefix(src.sourceId, prefix, reason);
    process.stdout.write(`tombstoned ${n} docs under ${channelId} (${reason})\n`);
  };

  // ── 실시간 Gateway (P3) — 같은 프로세스가 유일한 Discord 작성자 ──
  const reconcileAll = async () => {
    for (const src of await discordSources())
      for (const scope of await scopes(src.id)) {
        const channelId = scope.scope_key.split(':')[1];
        if (!channelId) continue;
        try {
          await collector.reconcileHead(src.id, channelId, { scopeKey: scope.scope_key });
        } catch (e) {
          process.stderr.write(`resync ${scope.scope_key}: ${e}\n`);
        }
      }
  };
  const gateway = new DiscordGateway(
    config.DISCORD_BOT_TOKEN,
    INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
    {
      onDispatch: async (t, d) => {
        if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
          const src = await sourceForChannel(d.channel_id);
          if (!src) return;
          // uncached UPDATE는 캐시된 payload를 믿지 않고 REST로 재조회한다 (§6.3).
          const full = await rest.message(d.channel_id, d.id);
          if (full.status === 200 && full.body) {
            await store.recordSourceEvent(
              src.sourceId,
              `gw:${t}:${d.id}:${full.body.edited_timestamp ?? 'new'}`,
              t.toLowerCase(),
              d,
            );
            await collector.ingestMessage(src.sourceId, d.channel_id, full.body, {
              scopeKey: src.scopeKey,
            });
          }
        } else if (t === 'MESSAGE_DELETE') {
          const src = await sourceForChannel(d.channel_id);
          if (!src) return;
          await store.applyTombstone(
            documentKeys.discordMessage(config.DISCORD_GUILD_ID, d.channel_id, d.id),
            src.sourceId,
            'discord_message_deleted',
          );
        } else if (t === 'MESSAGE_DELETE_BULK') {
          const src = await sourceForChannel(d.channel_id);
          if (!src || !Array.isArray(d.ids)) return;
          for (const mid of d.ids)
            await store.applyTombstone(
              documentKeys.discordMessage(config.DISCORD_GUILD_ID, d.channel_id, mid),
              src.sourceId,
              'discord_message_bulk_deleted',
            );
        } else if (t === 'CHANNEL_DELETE' || t === 'THREAD_DELETE') {
          // 부모 삭제 → 그 아래 메시지 문서 전부 tombstone (RAG-010).
          await tombstoneChannel(d.id, t.toLowerCase());
        } else if (t === 'CHANNEL_UPDATE') {
          // 권한/설정 변경 — head 재대조로 접근 상실(403)이면 access_lost로 남는다.
          const src = await sourceForChannel(d.id);
          if (src) await collector.reconcileHead(src.sourceId, d.id, { scopeKey: src.scopeKey });
        } else if (t === 'THREAD_CREATE' || t === 'THREAD_UPDATE') {
          const parent = d.parent_id;
          if (parent && (await sourceForChannel(parent))) {
            // 발견된 스레드를 scope로 등록하고 즉시 수집한다.
            const srcId = await registerThreadScopes(parent, [d.id]);
            if (srcId)
              await collector.backfillChannel(srcId, d.id, {
                limit: BACKFILL_SLICE,
                scopeKey: `thread:${d.id}`,
              });
          }
        } else if (t === 'THREAD_LIST_SYNC') {
          // guild-level 스레드 동기화 — 채널별로 발견 scope 등록 후 수집.
          for (const th of d.threads ?? []) {
            if (!th.parent_id) continue;
            const srcId = await registerThreadScopes(th.parent_id, [th.id]);
            if (srcId)
              await collector.backfillChannel(srcId, th.id, {
                limit: BACKFILL_SLICE,
                scopeKey: `thread:${th.id}`,
              });
          }
        }
      },
      onResyncNeeded: () => reconcileAll(),
      onStateChange: (s, d) => process.stdout.write(`gateway ${s}${d ? ' ' + d : ''}\n`),
    },
  );
  void gateway.run().catch((e) => {
    process.stderr.write(`gateway fatal: ${e}\n`);
    process.exit(1);
  });

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      stop = true;
      gateway.stop();
    });

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
          // 채널 scope일 때만 스레드를 발견한다 — 발견된 스레드는 자체
          // `thread:` scope로 등록되어 다음 루프부터 독립 수집된다 (RAG-010).
          if (scope.scope_key.startsWith('channel:')) {
            const threads = await collector.discoverThreads(channelId);
            if (threads.length) await registerThreadScopes(channelId, threads);
          }
          const backfill = await collector.backfillChannel(src.id, channelId, {
            limit: BACKFILL_SLICE,
            scopeKey: scope.scope_key,
          });
          if (backfill.done)
            await collector.reconcileHead(src.id, channelId, { scopeKey: scope.scope_key });
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
