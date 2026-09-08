import { REST, Routes } from 'discord.js';
import { Store, sql, rows, first, json, type MeetingRow, type Episode } from '@meeting/db';
import { hash, type AppConfig } from '@meeting/providers';
import { boundedText, DomainError } from '@meeting/domain';
interface Item {
  id: string;
  entity_id: string;
  guild_id: string;
  kind: string;
  revision: string;
  channel_id: string;
  payload: Record<string, any>;
  status: string;
  message_id: string | null;
  created_at: Date;
  attempts: number;
}
const button = (label: string, id: string, style = 2) => ({ type: 2, label, custom_id: id, style });
export class Outbox {
  readonly rest: REST;
  private editing = new Map<string, string>();
  constructor(
    private store: Store,
    private config: AppConfig,
    private owner: string,
  ) {
    this.rest = new REST({ version: '10', timeout: 15000, retries: 2 }).setToken(
      config.DISCORD_BOT_TOKEN,
    );
  }
  private footer(item: Item) {
    return `Juncoy · ${Buffer.from(item.id.replaceAll('-', ''), 'hex').toString('base64url')}`;
  }
  async payload(item: Item): Promise<any | null> {
    const base = this.config.APP_BASE_URL;
    const link = (id: string) => ({
      type: 2,
      label: '웹에서 실시간 기록 보기',
      style: 5,
      url: `${base}/meetings/${id}`,
    });
    const embed: any = { color: 0x7387fb, footer: { text: this.footer(item) } };
    let components: any[] = [],
      content: string | undefined,
      mentions: string[] = [];
    if (item.kind === 'BUDGET') {
      const c = await this.store.getConfig(item.guild_id);
      const user = c.admin_user_ids[0];
      mentions = user ? [user] : [];
      content = user ? `<@${user}>` : undefined;
      embed.title = `월 API 예산 ${item.payload.threshold}% 알림`;
      embed.description = `이번 달 추정 사용액 ${Math.round(item.payload.used).toLocaleString('ko-KR')}원 / 예산 ${Math.round(item.payload.budget).toLocaleString('ko-KR')}원\n${item.payload.threshold === 100 ? '새 회의 시작을 제한합니다. 진행 중 회의의 전사·복구·요약은 마무리합니다.' : '사용량을 확인해 주세요. 진행 중인 회의는 계속 기록합니다.'}`;
      embed.color = 0xe5a553;
    } else if (item.kind === 'PROMPT' || item.kind === 'REMIND') {
      const e = await first(
        sql<Episode>`SELECT * FROM occupancy_episodes WHERE id=${item.entity_id}::uuid AND closed_at IS NULL`,
        this.store.db,
      );
      if (!e || e.state === 'SKIPPED' || e.body.meeting_id || e.body.members.length < 2)
        return null;
      const active = await this.store.active(item.guild_id);
      if (item.kind === 'REMIND' && active) return null;
      if (active) {
        embed.title = '다른 회의를 기록 중이에요';
        embed.description = '현재 회의가 종료되면 이 방에서 기록을 시작할 수 있습니다.';
        components = [{ type: 1, components: [link(active.id)] }];
      } else {
        embed.title = '회의 중이신가요?';
        embed.description = `<#${e.channel_id}> · ${e.body.members.length}명이 모였어요.\n발언자별 실시간 전사와 회의 요약을 남겨드릴게요.\n\n아직 기록하지 않고 있어요. 시작 전 대화는 저장되지 않아요.`;
        components = [
          {
            type: 1,
            components: [
              button('실시간 회의기록 하기', `start:${e.id}:1`, 1),
              button('10분 뒤 알림', `snooze:${e.id}:1`),
              button('이번 대화는 건너뛰기', `skip:${e.id}:1`),
            ],
          },
        ];
      }
      if (item.kind === 'REMIND') {
        const target = e.body.members
          .filter((m) => m.can_start)
          .sort(
            (a, b) => Number(b.facilitator) - Number(a.facilitator) || a.joined_at - b.joined_at,
          )[0];
        mentions = target ? [target.user_id] : [];
        content =
          (target ? `<@${target.user_id}> ` : '') +
          '회의 기록이 필요하신가요?' +
          (e.body.message_id
            ? ` https://discord.com/channels/${item.guild_id}/${item.channel_id}/${e.body.message_id}`
            : '');
        components = [];
      }
    } else {
      let m: MeetingRow;
      try {
        m = await this.store.meeting(item.guild_id, item.entity_id);
      } catch {
        return null;
      }
      if (item.kind === 'SUMMARY') {
        const s = await first(
          sql<{
            result: any;
            transcript_version: number;
            summary_version: number;
            partial: boolean;
            verification_run_id: string | null;
          }>`SELECT * FROM summaries WHERE meeting_id=${m.id}::uuid AND summary_version=${Number(item.payload.summary_version)}`,
          this.store.db,
        );
        if (
          !s ||
          m.view.summary_status !== 'READY' ||
          s.transcript_version !== m.view.transcript_version ||
          s.summary_version !== m.view.summary_version
        )
          return null;
        if (m.runtime.mode === 'real') {
          const verified =
            s.verification_run_id &&
            (await first(
              sql`SELECT 1 FROM summary_runs WHERE id=${s.verification_run_id}::uuid AND meeting_id=${m.id}::uuid AND transcript_version=${s.transcript_version} AND status='VERIFIED' AND result=${json(s.result)}`,
              this.store.db,
            ));
          if (!verified) return null;
        }
        embed.title = boundedText(s.result.title, 200);
        embed.color = s.partial ? 0xe5a553 : 0x70b998;
        embed.description = boundedText(
          s.result.summary.map((x: string) => '• ' + x).join('\n') ||
            '확정 전사가 부족해 요약할 내용이 없습니다.',
          3400,
        );
        embed.fields = [
          { name: '검토 상태', value: '자동 요약 · 검토 전', inline: true },
          { name: '기록 상태', value: s.partial ? '부분 회의록' : '마감 완료', inline: true },
        ];
        components = [{ type: 1, components: [{ ...link(m.id), label: '회의록과 근거 보기' }] }];
      } else if (item.kind === 'NOTICE') {
        embed.title = '회의 기록 안내';
        embed.description = boundedText(item.payload.text ?? '', 3400);
        if (item.payload.control && !['RECORDING', 'PAUSED', 'DEGRADED'].includes(m.status)) {
          embed.description = '이 회의는 종료되었거나 기록 중이 아닙니다.';
          components = [{ type: 1, components: [link(m.id)] }];
        } else if (item.payload.control)
          components = [
            {
              type: 1,
              components: [
                button(
                  item.payload.control === 'continue' ? '계속 기록' : '1시간 연장',
                  `${item.payload.control}:${m.id}:1`,
                  1,
                ),
                link(m.id),
              ],
            },
          ];
      } else {
        const counts = await first(
          sql<{
            present: string;
            eligible: string;
          }>`SELECT count(*) FILTER(WHERE (body->>'present')::boolean) AS present,count(*) FILTER(WHERE (body->>'present')::boolean AND (body->>'recording_eligible')::boolean) AS eligible FROM meeting_participants WHERE meeting_id=${m.id}::uuid`,
          this.store.db,
        );
        const names: Record<string, string> = {
          STARTING: '5초 고지 후 회의 기록을 시작합니다',
          RECORDING: '회의를 기록하고 있어요',
          PAUSED: '회의 기록이 일시정지되어 있어요',
          DEGRADED: '전사 지연 또는 수신 장애가 있어요',
          STOPPING: '전사를 마감하고 있어요',
          FINALIZING: '회의록을 만들고 있어요',
          COMPLETED: '회의 기록이 완료되었어요',
          PARTIAL: '부분 회의록이 준비되었어요',
          FAILED: '회의 기록에 문제가 발생했어요',
        };
        embed.title = names[m.status];
        embed.color =
          m.status === 'RECORDING'
            ? 0x70b998
            : m.status === 'FAILED'
              ? 0xe57878
              : ['DEGRADED', 'PAUSED', 'PARTIAL'].includes(m.status)
                ? 0xe5a553
                : 0x7387fb;
        embed.description = `${m.view.voice_channel_name} · 참여 ${counts?.present ?? 0}명 · 기록 대상 ${counts?.eligible ?? 0}명\n${m.view.started_at ? '시작 ' + new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(new Date(m.view.started_at)) : '기록 고지 후 참가자의 음성을 수집합니다.'}\n${m.view.last_final_at ? '마지막 확정 발언 ' + Math.max(0, Math.round(((m.view.ended_at ? Date.parse(m.view.ended_at) : Date.now()) - Date.parse(m.view.last_final_at)) / 1000)) + '초 전' : '아직 확정된 발언이 없습니다.'}`;
        components = [{ type: 1, components: [link(m.id)] }];
        if (['RECORDING', 'DEGRADED', 'PAUSED'].includes(m.status)) {
          components[0].components.push(button('중요 지점 표시', `marker:${m.id}:1`));
          components.push({
            type: 1,
            components: [
              button(
                m.status === 'PAUSED' ? '재개' : '일시정지',
                `${m.status === 'PAUSED' ? 'resume' : 'pause'}:${m.id}:1`,
              ),
              button('종료하고 요약', `stop:${m.id}:1`, 4),
            ],
          });
        }
      }
    }
    return {
      content,
      embeds: [embed],
      components,
      allowed_mentions: { parse: [], users: mentions, replied_user: false },
    };
  }
  private async existing(item: Item) {
    let before: string | undefined;
    const since = item.created_at.getTime() - 10000;
    for (let page = 0; page < 10000; page++) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const messages = (await this.rest.get(Routes.channelMessages(item.channel_id), {
        query,
      })) as any[];
      const found = messages.find(
        (m) =>
          m.author?.id === this.config.DISCORD_CLIENT_ID &&
          m.embeds?.some((e: any) => e.footer?.text === this.footer(item)),
      );
      if (found) return found.id as string;
      if (
        messages.length < 100 ||
        !messages.length ||
        Date.parse(messages[messages.length - 1].timestamp) < since
      )
        return null;
      before = messages[messages.length - 1].id;
    }
    return null;
  }
  private async sendVerifiedSummary(item: Item) {
    try {
      await this.store.withMeeting(item.guild_id, item.entity_id, async (tx) => {
        const owned = await first(
          sql`SELECT id FROM outbox WHERE id=${item.id}::uuid AND owner=${this.owner} AND status='RUNNING' AND lease_until>now() FOR UPDATE`,
          tx,
        );
        if (!owned) return;
        const payload = await this.payload(item);
        if (!payload) {
          await sql`UPDATE outbox SET status='CANCELLED',lease_until=NULL WHERE id=${item.id}`.execute(
            tx,
          );
          return;
        }
        const previous = await first(
          sql<{
            message_id: string;
          }>`SELECT message_id FROM outbox WHERE entity_id=${item.entity_id}::uuid AND kind='SUMMARY' AND status='SENT' AND message_id IS NOT NULL ORDER BY revision DESC LIMIT 1`,
          tx,
        );
        let id: string;
        if (previous) {
          await this.rest.patch(Routes.channelMessage(item.channel_id, previous.message_id), {
            body: payload,
          });
          id = previous.message_id;
        } else {
          const nonce = BigInt('0x' + hash(item.id).slice(0, 15)).toString();
          const response = (await this.rest.post(Routes.channelMessages(item.channel_id), {
            body: { ...payload, nonce, enforce_nonce: true },
          })) as { id: string };
          id = response.id;
        }
        await sql`UPDATE outbox SET status='SENT',message_id=${id},lease_until=NULL,updated_at=now() WHERE id=${item.id}::uuid AND owner=${this.owner} AND status='RUNNING'`.execute(
          tx,
        );
      });
    } catch (e: any) {
      if (e?.code !== 'MEETING_NOT_FOUND') throw e;
      await sql`UPDATE outbox SET status='CANCELLED',lease_until=NULL WHERE id=${item.id}::uuid AND owner=${this.owner} AND status='RUNNING'`.execute(
        this.store.db,
      );
    }
  }
  async tick() {
    if (this.config.PROVIDER_MODE === 'mock') return;
    const item = await this.store.db.transaction().execute(async (tx) => {
      const picked = await first(
        sql<Item>`SELECT * FROM outbox WHERE guild_id=${this.config.DISCORD_GUILD_ID} AND (status='PENDING' OR (status='RUNNING' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        tx,
      );
      if (!picked) return;
      await sql`UPDATE outbox SET status='RUNNING',owner=${this.owner},lease_until=now()+interval '60 seconds',attempts=attempts+1,updated_at=now() WHERE id=${picked.id}`.execute(
        tx,
      );
      return picked;
    });
    if (!item) return;
    const renew = setInterval(
      () =>
        void sql`UPDATE outbox SET lease_until=now()+interval '60 seconds' WHERE id=${item.id} AND owner=${this.owner} AND status='RUNNING'`
          .execute(this.store.db)
          .catch(() => {}),
      15000,
    );
    try {
      let messageId = item.message_id;
      if (item.status === 'RUNNING' || item.attempts > 0) {
        messageId = await this.existing(item);
        if (!messageId) {
          await sql`UPDATE outbox SET status='NEEDS_RECONCILIATION',error_code='AMBIGUOUS_DELIVERY',lease_until=NULL WHERE id=${item.id} AND owner=${this.owner} AND status='RUNNING'`.execute(
            this.store.db,
          );
          return;
        }
      }
      if (!messageId && item.kind === 'SUMMARY') {
        await this.sendVerifiedSummary(item);
        return;
      }
      if (!messageId) {
        const payload = await this.payload(item);
        if (!payload) {
          await sql`UPDATE outbox SET status='CANCELLED' WHERE id=${item.id} AND owner=${this.owner} AND status='RUNNING'`.execute(
            this.store.db,
          );
          return;
        }
        const previous =
          item.kind === 'SUMMARY'
            ? await first(
                sql<{
                  message_id: string;
                }>`SELECT message_id FROM outbox WHERE entity_id=${item.entity_id}::uuid AND kind='SUMMARY' AND status='SENT' AND message_id IS NOT NULL ORDER BY revision DESC LIMIT 1`,
                this.store.db,
              )
            : null;
        if (previous) {
          await this.rest.patch(Routes.channelMessage(item.channel_id, previous.message_id), {
            body: payload,
          });
          messageId = previous.message_id;
        } else {
          const nonce = BigInt('0x' + hash(item.id).slice(0, 15)).toString();
          const message = (await this.rest.post(Routes.channelMessages(item.channel_id), {
            body: { ...payload, nonce, enforce_nonce: true },
          })) as any;
          messageId = message.id;
        }
      }
      await sql`UPDATE outbox SET status='SENT',message_id=${messageId},lease_until=NULL,updated_at=now() WHERE id=${item.id} AND owner=${this.owner} AND status='RUNNING'`.execute(
        this.store.db,
      );
      if (item.kind === 'PROMPT')
        await sql`UPDATE occupancy_episodes SET body=jsonb_set(body,'{message_id}',${json(messageId)}) WHERE id=${item.entity_id}`.execute(
          this.store.db,
        );
    } catch (e) {
      const code = (e as any)?.status;
      await sql`UPDATE outbox SET status=${code === 429 ? 'PENDING' : 'NEEDS_RECONCILIATION'},error_code=${code ? 'DISCORD_HTTP_' + code : 'DELIVERY_UNCERTAIN'},attempts=CASE WHEN ${code === 429} THEN greatest(attempts-1,0) ELSE attempts END,lease_until=NULL WHERE id=${item.id} AND owner=${this.owner} AND status='RUNNING'`.execute(
        this.store.db,
      );
    } finally {
      clearInterval(renew);
    }
  }
  async refresh() {
    if (this.config.PROVIDER_MODE === 'mock') return;
    const items = await rows(
      sql<Item>`SELECT o.* FROM outbox o JOIN meetings m ON m.id=o.entity_id WHERE o.guild_id=${this.config.DISCORD_GUILD_ID} AND (o.kind='RECORDING' OR (o.kind='NOTICE' AND o.payload->>'control' IS NOT NULL)) AND o.status='SENT' AND m.deleted_at IS NULL `,
      this.store.db,
    );
    for (const item of items) {
      const payload = await this.payload(item);
      const fingerprint = hash(JSON.stringify(payload));
      if (!payload || this.editing.get(item.id) === fingerprint) continue;
      try {
        await this.rest.patch(Routes.channelMessage(item.channel_id, item.message_id!), {
          body: payload,
        });
        this.editing.set(item.id, fingerprint);
        const m = await this.store.meeting(item.guild_id, item.entity_id);
        if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(m.status))
          await sql`UPDATE outbox SET status='ARCHIVED' WHERE id=${item.id}`.execute(this.store.db);
      } catch {}
    }
  }
  async restoreDeletedCards() {
    if (this.config.PROVIDER_MODE === 'mock') return;
    const items = await rows(
      sql<Item>`SELECT o.* FROM outbox o WHERE o.guild_id=${this.config.DISCORD_GUILD_ID} AND o.status='SENT' AND o.kind IN ('PROMPT','RECORDING') AND o.message_id IS NOT NULL AND o.created_at>now()-interval '1 day'`,
      this.store.db,
    );
    for (const item of items) {
      try {
        await this.rest.get(Routes.channelMessage(item.channel_id, item.message_id!));
        continue;
      } catch (e) {
        if ((e as any)?.status !== 404) continue;
      }
      await this.store.db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${item.guild_id},0))`.execute(tx);
        if (item.kind === 'PROMPT') {
          const e = await first(
            sql<Episode>`SELECT * FROM occupancy_episodes WHERE id=${item.entity_id}::uuid AND closed_at IS NULL FOR UPDATE`,
            tx,
          );
          if (
            !e ||
            e.body.restored ||
            e.body.meeting_id ||
            e.state === 'SKIPPED' ||
            e.body.members.length < 2
          )
            return;
          e.body.restored = true;
          await sql`UPDATE occupancy_episodes SET body=${json(e.body)} WHERE id=${e.id}`.execute(
            tx,
          );
        } else {
          const m = await first(
            sql<MeetingRow>`SELECT * FROM meetings WHERE id=${item.entity_id}::uuid AND deleted_at IS NULL FOR UPDATE`,
            tx,
          );
          if (
            !m ||
            m.runtime.card_restored ||
            !['STARTING', 'RECORDING', 'PAUSED', 'DEGRADED'].includes(m.status)
          )
            return;
          m.runtime.card_restored = true;
          await this.store.saveView(tx, m);
        }
        await sql`UPDATE outbox SET status='MISSING' WHERE id=${item.id}`.execute(tx);
        await this.store.post(
          tx,
          item.entity_id,
          item.guild_id,
          item.kind,
          Number(item.revision) + 1,
          item.channel_id,
          item.payload,
        );
      });
    }
  }
  async removeMessages(meetingId: string) {
    if (this.config.PROVIDER_MODE === 'mock') return;
    const ambiguous = await rows(
      sql<Item>`SELECT * FROM outbox WHERE entity_id=${meetingId}::uuid AND message_id IS NULL AND attempts>0 AND error_code IN ('DELIVERY_UNCERTAIN','AMBIGUOUS_DELIVERY')`,
      this.store.db,
    );
    for (const item of ambiguous) {
      const id = await this.existing(item);
      if (!id) throw new DomainError('MESSAGE_DELETION_UNCERTAIN');
      await sql`UPDATE outbox SET message_id=${id} WHERE id=${item.id}::uuid`.execute(
        this.store.db,
      );
    }
    const items = await rows(
      sql<{
        channel_id: string;
        message_id: string;
      }>`SELECT DISTINCT channel_id,message_id FROM outbox WHERE entity_id=${meetingId}::uuid AND message_id IS NOT NULL`,
      this.store.db,
    );
    for (const item of items) {
      try {
        await this.rest.delete(Routes.channelMessage(item.channel_id, item.message_id));
      } catch (e) {
        if ((e as any)?.status !== 404) throw e;
      }
    }
  }
}
