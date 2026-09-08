import { randomUUID } from 'node:crypto';
import { Store, sql, first, rows, json, type Episode, type EpisodeBody } from '@meeting/db';
import { DomainError } from '@meeting/domain';
export class Episodes {
  constructor(private store: Store) {}
  async observe(
    guildId: string,
    channelId: string,
    members: EpisodeBody['members'],
    now = Date.now(),
  ) {
    return this.store.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId},0))`.execute(tx);
      const config = await this.store.getConfig(guildId, tx);
      let episode = await first(
        sql<Episode>`SELECT * FROM occupancy_episodes WHERE channel_id=${channelId} AND guild_id=${guildId} AND closed_at IS NULL FOR UPDATE`,
        tx,
      );
      if (!episode) {
        if (members.length < 2) return null;
        const id = randomUUID();
        const body: EpisodeBody = {
          members,
          stable_since: now,
          below_since: null,
          auto_sent: false,
          snooze_used: false,
          snooze_sent: false,
          meeting_id: null,
          restored: false,
          message_id: null,
          manual_ended: false,
        };
        await sql`INSERT INTO occupancy_episodes(id,guild_id,channel_id,state,body) VALUES(${id},${guildId},${channelId},'CANDIDATE',${json(body)})`.execute(
          tx,
        );
        await this.store.timer(tx, id, guildId, 'PROMPT', now + config.stabilize_ms);
        return id;
      }
      const b = episode.body;
      b.members = members.map((m) => ({
        ...m,
        joined_at: b.members.find((p) => p.user_id === m.user_id)?.joined_at ?? now,
      }));
      if (members.length < 2) {
        b.stable_since = null;
        if (b.below_since === null) {
          b.below_since = now;
          await this.store.timer(
            tx,
            episode.id,
            guildId,
            'CLOSE_EPISODE',
            now + config.episode_close_ms,
          );
        }
        if (episode.state === 'CANDIDATE')
          await this.store.cancelTimers(tx, episode.id, ['PROMPT']);
      } else {
        b.below_since = null;
        await this.store.cancelTimers(tx, episode.id, ['CLOSE_EPISODE']);
        if (b.stable_since === null) {
          b.stable_since = now;
          if (episode.state === 'CANDIDATE')
            await this.store.timer(tx, episode.id, guildId, 'PROMPT', now + config.stabilize_ms);
        }
      }
      await sql`UPDATE occupancy_episodes SET body=${json(b)} WHERE id=${episode.id}`.execute(tx);
      return episode.id;
    });
  }
  async choose(guildId: string, id: string, choice: 'SNOOZE' | 'SKIP', userId: string) {
    return this.store.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId},0))`.execute(tx);
      const e = await first(
        sql<Episode>`SELECT * FROM occupancy_episodes WHERE id=${id}::uuid AND guild_id=${guildId} AND closed_at IS NULL FOR UPDATE`,
        tx,
      );
      if (!e || e.body.meeting_id)
        throw new DomainError('STALE_CONTROL', '현재 회의 상태를 확인해 주세요.');
      if (!e.body.members.some((p) => p.user_id === userId && p.can_start))
        throw new DomainError('FORBIDDEN', '현재 음성방의 팀원만 선택할 수 있습니다.', 403);
      const c = await this.store.getConfig(guildId, tx);
      if (choice === 'SKIP') {
        e.state = 'SKIPPED';
        await this.store.cancelTimers(tx, id, ['PROMPT', 'REMIND', 'SNOOZE']);
      } else {
        if (e.body.snooze_used || e.state === 'SKIPPED')
          throw new DomainError('ALREADY_SNOOZED', '미루기는 대화당 한 번 사용할 수 있습니다.');
        e.state = 'SNOOZED';
        e.body.snooze_used = true;
        await this.store.cancelTimers(tx, id, ['REMIND']);
        await this.store.timer(tx, id, guildId, 'SNOOZE', Date.now() + c.snooze_ms);
      }
      await sql`UPDATE occupancy_episodes SET body=${json(e.body)},state=${e.state} WHERE id=${id}`.execute(
        tx,
      );
    });
  }
  async tick(now = Date.now()) {
    const due = await rows(
      sql<{
        id: string;
        guild_id: string;
      }>`SELECT id,guild_id FROM durable_timers WHERE status='PENDING' AND due_at<=${new Date(now)} AND kind IN ('PROMPT','REMIND','SNOOZE','CLOSE_EPISODE') ORDER BY due_at LIMIT 50`,
      this.store.db,
    );
    for (const row of due)
      await this.store.db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${row.guild_id},0))`.execute(tx);
        const timer = await first(
          sql<{
            id: string;
            entity_id: string;
            kind: string;
          }>`SELECT * FROM durable_timers WHERE id=${row.id} AND status='PENDING' AND due_at<=${new Date(now)} FOR UPDATE`,
          tx,
        );
        if (!timer) return;
        const e = await first(
          sql<Episode>`SELECT * FROM occupancy_episodes WHERE id=${timer.entity_id} AND closed_at IS NULL FOR UPDATE`,
          tx,
        );
        await sql`UPDATE durable_timers SET status='DONE' WHERE id=${timer.id}`.execute(tx);
        if (!e) return;
        const c = await this.store.getConfig(e.guild_id, tx),
          b = e.body;
        if (timer.kind === 'CLOSE_EPISODE') {
          if (
            b.members.length < 2 &&
            b.below_since !== null &&
            now - b.below_since >= c.episode_close_ms
          ) {
            await sql`UPDATE occupancy_episodes SET state='CLOSED',closed_at=${new Date(now)} WHERE id=${e.id}`.execute(
              tx,
            );
            await this.store.cancelTimers(tx, e.id, ['PROMPT', 'REMIND', 'SNOOZE']);
          }
          return;
        }
        if (
          e.state === 'SKIPPED' ||
          b.meeting_id ||
          b.members.length < 2 ||
          !c.notification_channel_id
        )
          return;
        const busy = await first(
          sql<{
            id: string;
          }>`SELECT id FROM meetings WHERE guild_id=${e.guild_id} AND deleted_at IS NULL AND status IN ('STARTING','RECORDING','PAUSED','DEGRADED','STOPPING')`,
          tx,
        );
        if (
          timer.kind === 'PROMPT' &&
          e.state === 'CANDIDATE' &&
          b.stable_since !== null &&
          now - b.stable_since >= c.stabilize_ms
        ) {
          e.state = 'PROMPTED';
          await this.store.post(tx, e.id, e.guild_id, 'PROMPT', 1, c.notification_channel_id, {
            episode_id: e.id,
            busy_meeting_id: busy?.id ?? null,
          });
          if (!busy) await this.store.timer(tx, e.id, e.guild_id, 'REMIND', now + c.remind_ms);
        }
        if (!busy && timer.kind === 'REMIND' && !b.auto_sent && !b.snooze_used) {
          b.auto_sent = true;
          await this.store.post(tx, e.id, e.guild_id, 'REMIND', 1, c.notification_channel_id, {
            episode_id: e.id,
          });
        }
        if (!busy && timer.kind === 'SNOOZE' && b.snooze_used && !b.snooze_sent) {
          b.snooze_sent = true;
          await this.store.post(tx, e.id, e.guild_id, 'REMIND', 2, c.notification_channel_id, {
            episode_id: e.id,
          });
        }
        await sql`UPDATE occupancy_episodes SET state=${e.state},body=${json(b)} WHERE id=${e.id}`.execute(
          tx,
        );
      });
  }
}
