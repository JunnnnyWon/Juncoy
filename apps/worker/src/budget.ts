import { randomUUID } from 'node:crypto';
import { Store, sql, rows, first, json } from '@meeting/db';
import { GuildConfig } from '@meeting/contracts';
export async function checkBudgets(store: Store) {
  const configs = await rows(
    sql<{ guild_id: string; config: unknown }>`SELECT guild_id,config FROM guild_configs`,
    store.db,
  );
  for (const entry of configs) {
    const c = GuildConfig.parse(entry.config);
    if (!c.monthly_api_budget_krw || !c.record_channel_id) continue;
    const usage = await first(
      sql<{
        used: string;
        month: string;
      }>`SELECT coalesce(sum(cost_krw),0) AS used,to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM') AS month FROM usage_records WHERE guild_id=${entry.guild_id} AND NOT is_mock AND created_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
      store.db,
    );
    const used = Number(usage?.used ?? 0);
    for (const threshold of [80, 100])
      if (used >= (c.monthly_api_budget_krw * threshold) / 100)
        await store.db.transaction().execute(async (tx) => {
          const id = randomUUID();
          const inserted = await first(
            sql<{
              id: string;
            }>`INSERT INTO audit_events(id,guild_id,kind,data) VALUES(${id},${entry.guild_id},${'BUDGET_' + threshold},${json({ month: usage!.month })}) ON CONFLICT DO NOTHING RETURNING id`,
            tx,
          );
          if (inserted)
            await store.post(tx, id, entry.guild_id, 'BUDGET', threshold, c.record_channel_id!, {
              threshold,
              used,
              budget: c.monthly_api_budget_krw,
            });
        });
  }
}
