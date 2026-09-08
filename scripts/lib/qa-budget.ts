import { Store, sql, first } from '@meeting/db';
import { ProviderError, type SummaryUsage } from '@meeting/providers';
/** Reservations are conservative charges until usage is returned; unknown usage stays visible. */
export class QaBudget {
  constructor(
    private store: Store,
    private guildId: string,
    readonly campaign: string,
    private cap: number,
  ) {}
  private key(key: string) {
    return 'qa:' + this.campaign + ':' + key;
  }
  async reserve(key: string, provider: string, estimatedKrw: number) {
    await this.store.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.guildId + ':qa-budget'},0))`.execute(
        tx,
      );
      const config = await this.store.getConfig(this.guildId, tx);
      if (config.monthly_api_budget_krw === null)
        throw new ProviderError('QA_BUDGET_NOT_CONFIGURED', false);
      const total = await first(
        sql<{
          month: string;
          campaign: string;
        }>`SELECT coalesce(sum(cost_krw),0)::text AS month,coalesce(sum(cost_krw) FILTER(WHERE request_key LIKE ${'qa:' + this.campaign + ':%'}),0)::text AS campaign FROM usage_records WHERE guild_id=${this.guildId} AND NOT is_mock AND created_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
        tx,
      );
      const old = await first(
        sql`SELECT id FROM usage_records WHERE request_key=${this.key(key)}`,
        tx,
      );
      if (old) throw new ProviderError('QA_REQUEST_ALREADY_RESERVED', false);
      if (
        Number(total?.month ?? 0) + estimatedKrw > config.monthly_api_budget_krw ||
        Number(total?.campaign ?? 0) + estimatedKrw > this.cap
      )
        throw new ProviderError('QA_BUDGET_EXCEEDED', false);
      await sql`INSERT INTO usage_records(id,guild_id,request_key,provider,cost_krw) VALUES(gen_random_uuid(),${this.guildId},${this.key(key)},${provider + ':qa-reserved'},${estimatedKrw})`.execute(
        tx,
      );
    });
  }
  async beforeSummary(key: string, inputBytes: number, maxOutputTokens: number) {
    const config = await this.store.getConfig(this.guildId);
    await this.reserve(
      key,
      'upstage',
      ((inputBytes * 0.15 + maxOutputTokens * 0.6) / 1e6) * config.usd_krw,
    );
  }
  async summaryUsage(usage: SummaryUsage) {
    const config = await this.store.getConfig(this.guildId);
    await sql`UPDATE usage_records SET provider='upstage',cost_krw=${((usage.input_tokens * 0.15 + usage.output_tokens * 0.6) / 1e6) * config.usd_krw},input_tokens=${usage.input_tokens},output_tokens=${usage.output_tokens} WHERE request_key=${this.key(usage.key)}`.execute(
      this.store.db,
    );
  }
  async settleAudio(key: string, audioMs: number, costKrw = (audioMs / 3600000) * 1000) {
    await sql`UPDATE usage_records SET provider='returnzero',cost_krw=${costKrw},audio_ms=${Math.round(audioMs)} WHERE request_key=${this.key(key)}`.execute(
      this.store.db,
    );
  }
  async report() {
    return first(
      sql<{
        cost_krw: string;
        requests: string;
        estimated_requests: string;
      }>`SELECT coalesce(sum(cost_krw),0)::text AS cost_krw,count(*)::text AS requests,count(*) FILTER(WHERE provider LIKE '%:qa-reserved')::text AS estimated_requests FROM usage_records WHERE request_key LIKE ${'qa:' + this.campaign + ':%'}`,
      this.store.db,
    );
  }
}
