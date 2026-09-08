import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Guild,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { Store, sql, rows, first, json, type MeetingRow } from '@meeting/db';
import { hash, loadConfig, type AppConfig } from '@meeting/providers';
import { DomainError } from '@meeting/domain';
import { Id, type ParticipantDTO, type GuildSettings, type GapDTO } from '@meeting/contracts';
import { Capture } from './capture.ts';
import { Episodes } from './episodes.ts';
const config = loadConfig();
if (config.PROVIDER_MODE === 'mock') {
  process.stdout.write(
    'Discord bot disabled in explicit mock mode. Use pnpm dev for the simulated feed.\n',
  );
  process.exit(0);
}
const store = new Store(config.DATABASE_URL),
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const owner = randomUUID(),
  episodes = new Episodes(store),
  captures = new Map<string, Capture>();
const starts = new Set<string>();
let shuttingDown = false;
const link = (id?: string) => config.APP_BASE_URL + '/meetings' + (id ? '/' + id : '');
const memberAdmin = (member: GuildMember, c: GuildSettings) =>
  member.id === member.guild.ownerId ||
  member.permissions.has(PermissionsBitField.Flags.Administrator) ||
  c.admin_user_ids.includes(member.id);
const memberTeam = (member: GuildMember, c: GuildSettings) =>
  member.guild.id === config.DISCORD_GUILD_ID && !member.user.bot;
async function participants(guild: Guild, m: MeetingRow) {
  const c = await store.getConfig(guild.id);
  const previous = (await store.snapshot(guild.id, m.id)).participants;
  const channel = guild.channels.cache.get(m.voice_channel_id);
  if (!channel?.isVoiceBased())
    return previous.map((p) => ({ ...p, present: false, recording_eligible: false }));
  const current: ParticipantDTO[] = [];
  for (const member of channel.members.values()) {
    if (member.user.bot) continue;
    const consent = await store.consented(guild.id, member.id);
    current.push({
      user_id: member.id,
      display_name: member.displayName,
      present: true,
      recording_eligible:
        (!c.require_consent || memberTeam(member, c)) &&
        consent &&
        (!c.shared_microphone_user_ids.includes(member.id) ||
          c.approved_shared_microphone_user_ids.includes(member.id)),
    });
  }
  return [
    ...current,
    ...previous
      .filter((p) => !current.some((x) => x.user_id === p.user_id))
      .map((p) => ({ ...p, present: false, recording_eligible: false })),
  ];
}
async function observe(guild: Guild) {
  const c = await store.getConfig(guild.id);
  const voiceIds = c.detect_all_voice_channels
    ? [...guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildVoice)
        .map((channel) => channel.id)
    : c.voice_channel_ids;
  for (const id of voiceIds) {
    if (id === guild.afkChannelId) continue;
    const channel = guild.channels.cache.get(id);
    if (!channel?.isVoiceBased()) continue;
    await episodes.observe(
      guild.id,
      id,
      [...channel.members.values()]
        .filter((m) => !m.user.bot)
        .map((m) => ({
          user_id: m.id,
          display_name: m.displayName,
          joined_at: Date.now(),
          facilitator: c.facilitator_role_ids.some((r) => m.roles.cache.has(r)),
          can_start: memberTeam(m, c),
        })),
    );
  }
  const active = await store.active(guild.id);
  if (active) {
    const ps = await participants(guild, active);
    captures.get(active.id)?.update(ps);
    await store.setParticipants(guild.id, active.id, ps);
  }
}
async function start(guild: Guild, member: GuildMember, interactionId: string, episodeId?: string) {
  const settings = await store.getConfig(guild.id);
  const fresh = await guild.members.fetch({ user: member.id, force: true });
  if (!memberTeam(fresh, settings) || !fresh.voice.channelId)
    throw new DomainError('FORBIDDEN', '대상 음성방의 팀원만 시작할 수 있습니다.', 403);
  if (episodeId) {
    const ep = await first(
      sql<{
        channel_id: string;
      }>`SELECT channel_id FROM occupancy_episodes WHERE id=${Id.parse(episodeId)} AND guild_id=${guild.id} AND closed_at IS NULL`,
      store.db,
    );
    if (!ep || ep.channel_id !== fresh.voice.channelId)
      throw new DomainError('STALE_CONTROL', '현재 음성방의 안내를 사용해 주세요.');
  }
  const channel = fresh.voice.channel!;
  if (channel.type !== ChannelType.GuildVoice || channel.id === guild.afkChannelId)
    throw new DomainError('INVALID_ARGUMENT', '일반 음성방에서 회의를 시작해 주세요.');
  const ps: ParticipantDTO[] = [];
  for (const p of channel.members.values()) {
    if (p.user.bot) continue;
    ps.push({
      user_id: p.id,
      display_name: p.displayName,
      present: true,
      recording_eligible:
        (!settings.require_consent || memberTeam(p, settings)) &&
        (await store.consented(guild.id, p.id)) &&
        (!settings.shared_microphone_user_ids.includes(p.id) ||
          settings.approved_shared_microphone_user_ids.includes(p.id)),
    });
  }
  const m = await store.begin({
    guildId: guild.id,
    channelId: channel.id,
    channelName: channel.name,
    userId: fresh.id,
    interactionId,
    owner,
    participants: ps,
    isMock: false,
  });
  if (m.owner !== owner || captures.has(m.id) || starts.has(m.id) || m.status !== 'STARTING')
    return m;
  starts.add(m.id);
  const capture = new Capture(store, config, m, guild, owner);
  captures.set(m.id, capture);
  void capture
    .start(ps)
    .catch(async () => {
      capture.abort();
      captures.delete(m.id);
      await store.transition(guild.id, m.id, 'FAILED').catch(() => {});
    })
    .finally(() => starts.delete(m.id));
  return m;
}
function meetingId(value: string | null) {
  if (!value) throw new DomainError('INVALID_ARGUMENT', '회의 링크가 필요합니다.');
  try {
    if (value.startsWith('http')) {
      const u = new URL(value);
      if (u.origin !== new URL(config.APP_BASE_URL).origin) throw new Error();
      return Id.parse(u.pathname.split('/')[2]);
    }
    return Id.parse(value);
  } catch {
    throw new DomainError('INVALID_ARGUMENT', '이 서비스의 회의 링크를 입력해 주세요.');
  }
}
async function handle(interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  if (!interaction.inGuild() || interaction.guildId !== config.DISCORD_GUILD_ID) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = async (content: string, components: any[] = []) => {
    await sql`INSERT INTO processed_interactions(interaction_id,guild_id,result) VALUES(${interaction.id},${interaction.guildId!},${json({ status: 'DONE', message: content })}) ON CONFLICT(interaction_id) DO UPDATE SET result=processed_interactions.result||EXCLUDED.result`.execute(
      store.db,
    );
    return interaction.editReply({ content, components, allowedMentions: { parse: [] } });
  };
  try {
    const guild = await client.guilds.fetch(interaction.guildId),
      member = await guild.members.fetch({ user: interaction.user.id, force: true }),
      c = await store.getConfig(guild.id);
    const button = interaction.isButton() ? interaction.customId.split(':') : null;
    const action =
      button?.[0] ?? (interaction.isChatInputCommand() ? interaction.options.getSubcommand() : '');
    if (!['시작', 'start'].includes(action)) {
      const claimed = await first(
        sql`INSERT INTO processed_interactions(interaction_id,guild_id,result) VALUES(${interaction.id},${guild.id},${json({ status: 'RUNNING' })}) ON CONFLICT DO NOTHING RETURNING interaction_id`,
        store.db,
      );
      if (!claimed) {
        const old = await first(
          sql<{
            result: { message?: string };
          }>`SELECT result FROM processed_interactions WHERE interaction_id=${interaction.id}`,
          store.db,
        );
        return interaction.editReply({
          content:
            old?.result.message ?? '같은 요청을 처리 중입니다. /회의 상태에서 확인해 주세요.',
          allowedMentions: { parse: [] },
        });
      }
    }
    if (action === '설정' && interaction.isChatInputCommand()) {
      return say(
        `감지: 모든 일반 음성방 (AFK·스테이지 제외)\n안내·요약: <#${c.bot_channel_id}>\n열람: 23팀 서버 구성원 전체\n시작: 음성방에서 /회의 시작\n동시에 기록하는 회의: 1개`,
      );
    }
    if (!memberTeam(member, c))
      throw new DomainError('FORBIDDEN', '23팀 서버 구성원만 사용할 수 있습니다.', 403);
    if (action === '시작' || action === 'start') {
      const m = await start(guild, member, interaction.id, button?.[1]);
      return say(`회의 상태: ${m.status}\n${link(m.id)}`);
    }
    if (action === 'snooze' || action === 'skip') {
      await episodes.choose(
        guild.id,
        Id.parse(button![1]),
        action === 'snooze' ? 'SNOOZE' : 'SKIP',
        member.id,
      );
      return say(
        action === 'skip'
          ? '이번 대화의 자동 안내를 건너뜁니다.'
          : '10분 뒤에 한 번 알려드리겠습니다.',
      );
    }
    if (action === '목록') return say(link());
    if (action === '용어' && interaction.isChatInputCommand()) {
      if (!memberAdmin(member, c)) throw new DomainError('FORBIDDEN', undefined, 403);
      const spoken = interaction.options.getString('발음', true),
        written = interaction.options.getString('표기', true),
        weight = interaction.options.getInteger('가중치') ?? 2;
      await store.setConfig(
        guild.id,
        {
          ...c,
          glossary: [...c.glossary.filter((g) => g.spoken !== spoken), { spoken, written, weight }],
          glossary_version: c.glossary_version + 1,
        },
        member.id,
      );
      return say('표기 사전을 저장했습니다. 다음 회의부터 적용됩니다.');
    }
    let m: MeetingRow | undefined;
    if (action === '정정' && interaction.isChatInputCommand()) {
      const u = new URL(interaction.options.getString('발언링크', true));
      m = await store.meeting(guild.id, meetingId(u.toString()));
      if (m.controller_id !== member.id && !memberAdmin(member, c))
        throw new DomainError('FORBIDDEN', undefined, 403);
      await store.correct(
        guild.id,
        m.id,
        Id.parse(u.searchParams.get('segment')),
        interaction.options.getString('내용', true),
        member.id,
      );
      return say('정정 이력을 저장했습니다. 기존 요약은 갱신 대기로 표시됩니다.');
    }
    if (button?.[1]) m = await store.meeting(guild.id, Id.parse(button[1]));
    else if (
      interaction.isChatInputCommand() &&
      ['보기', '재요약', '삭제', '재전사'].includes(action) &&
      interaction.options.getString('회의')
    )
      m = await store.meeting(guild.id, meetingId(interaction.options.getString('회의')));
    else m = await store.active(guild.id);
    if (!m) return say('현재 기록 중인 회의가 없습니다. ' + link());
    if (action === '상태' || action === '보기') return say(`회의 상태: ${m.status}\n${link(m.id)}`);
    if (action === '표시' || action === 'marker') {
      if (member.voice.channelId !== m.voice_channel_id)
        throw new DomainError('FORBIDDEN', undefined, 403);
      await store.marker(
        guild.id,
        m.id,
        member.id,
        interaction.isChatInputCommand() ? interaction.options.getString('메모') : null,
      );
      return say('중요 지점을 표시했습니다.');
    }
    if (m.controller_id !== member.id && !memberAdmin(member, c))
      throw new DomainError('FORBIDDEN', '진행자 또는 관리자만 제어할 수 있습니다.', 403);
    if (action === '삭제' || action === 'deleteconfirm') {
      if (!memberAdmin(member, c)) throw new DomainError('FORBIDDEN', undefined, 403);
      if (action === '삭제') {
        const b = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`deleteconfirm:${m.id}:1`)
            .setLabel('이 회의 기록 전체 삭제')
            .setStyle(ButtonStyle.Danger),
        );
        return say(
          `${m.view.title}\n전사·요약·원음·첨부·봇 게시물과 웹 접근을 삭제합니다. 백업 복원 시에도 삭제 상태를 적용합니다. 외부 공급사 사본은 공급사 보관 정책을 따릅니다.`,
          [b],
        );
      }
      const capture = captures.get(m.id);
      if (capture) {
        await capture.stop();
        captures.delete(m.id);
      }
      await store.deleteMeeting(guild.id, m.id, member.id);
      return say('접근을 차단했습니다. 저장 데이터와 게시물을 정리하고 있습니다.');
    }
    if (action === '재전사' && interaction.isChatInputCommand()) {
      const target = interaction.options.getUser('화자', true).id,
        startMs = interaction.options.getInteger('시작초', true) * 1000,
        endMs = interaction.options.getInteger('종료초', true) * 1000;
      const elapsed = m.view.started_at
        ? (m.view.ended_at ? Date.parse(m.view.ended_at) : Date.now()) -
          Date.parse(m.view.started_at)
        : 0;
      if (
        endMs <= startMs ||
        endMs > elapsed ||
        (['RECORDING', 'DEGRADED'].includes(m.status) && endMs > elapsed - 15000)
      )
        throw new DomainError(
          'INVALID_RANGE',
          '종료 시각은 시작 이후여야 하며 현재 수집 중인 마지막 15초는 제외해 주세요.',
        );
      const audio = await first(
        sql`SELECT 1 FROM audio_chunks WHERE meeting_id=${m.id}::uuid AND user_id=${target} AND start_ms<${endMs} AND end_ms>${startMs} AND expires_at>now()`,
        store.db,
      );
      if (!audio)
        throw new DomainError(
          'AUDIO_NOT_AVAILABLE',
          '해당 범위의 저장된 원음이 없거나 보관 기간이 지났습니다.',
        );
      const key = `manual-recovery:${m.id}:${target}:${hash(JSON.stringify([startMs, endMs, c.glossary]))}`;
      await store.enqueue(store.db, key, 'RETRANSCRIBE', m.id, {
        guild_id: guild.id,
        user_id: target,
        start_ms: startMs,
        end_ms: endMs,
        glossary: c.glossary,
        glossary_version: c.glossary_version,
      });
      await sql`UPDATE jobs SET status='PENDING',attempts=0,due_at=now(),provider_job_id=CASE WHEN error_code='RTZR_FILE_FAILED' THEN NULL ELSE provider_job_id END WHERE key=${key} AND status='FAILED'`.execute(
        store.db,
      );
      return say(
        '재전사를 예약했습니다. 동일 범위·설정의 완료 결과는 재사용하며 사람의 정정은 자동으로 덮어쓰지 않습니다.',
      );
    }
    if (action === '재요약') {
      if (!['COMPLETED', 'PARTIAL', 'FAILED', 'FINALIZING'].includes(m.status))
        throw new DomainError('INVALID_STATE', '회의 종료 후 재요약할 수 있습니다.');
      await store.enqueue(
        store.db,
        `manual-summary:${m.id}:${m.view.transcript_version}:${interaction.id}`,
        'FINALIZE',
        m.id,
        { guild_id: guild.id },
      );
      return say('현재 전사 버전의 회의록을 확인하고 필요한 요약 작업을 예약했습니다.');
    }
    if (['continue', 'extend'].includes(action)) {
      await store.extendCaptureDeadline(guild.id, m.id, action as 'continue' | 'extend', m.fencing);
      return say(
        action === 'continue'
          ? '1인 기록 시간을 10분 연장했습니다.'
          : '최대 기록 시간을 1시간 연장했습니다.',
      );
    }
    if (
      ['종료', 'stop', '일시정지', 'pause', '재개', 'resume'].includes(action) &&
      !['RECORDING', 'PAUSED', 'DEGRADED'].includes(m.status)
    )
      throw new DomainError(
        'MEETING_NOT_RECORDING',
        '종료되었거나 기록 중이 아닌 회의입니다. /회의 상태에서 확인해 주세요.',
        409,
      );
    const capture = captures.get(m.id);
    if (!capture) throw new DomainError('VOICE_RECOVERING', '음성 연결 복구 중입니다.', 503, true);
    if (action === '종료' || action === 'stop') {
      await store.transition(guild.id, m.id, 'STOPPING', m.fencing);
      await say('새 수집을 중단하고 남은 전사를 마감하고 있습니다. ' + link(m.id));
      await capture.stop();
      captures.delete(m.id);
      await sql`UPDATE occupancy_episodes SET body=jsonb_set(body,'{manual_ended}','true') WHERE body->>'meeting_id'=${m.id}`.execute(
        store.db,
      );
      return;
    }
    if (action === '일시정지' || action === 'pause') {
      await capture.pause();
      capture.meeting = await store.transition(guild.id, m.id, 'PAUSED', m.fencing);
      await store.gap(guild.id, m.id, {
        gap_id: randomUUID(),
        user_id: null,
        start_ms: Math.round(capture.now()),
        end_ms: null,
        reason: 'PAUSED',
        recoverable: false,
        resolved: false,
      });
      return say('일시정지했습니다. 이 구간의 새 음성은 저장·전송되지 않습니다.');
    }
    if (action === '재개' || action === 'resume') {
      await say('5초 뒤 참가자의 기록을 재개합니다.');
      await store.post(store.db, m.id, guild.id, 'NOTICE', Date.now(), c.notification_channel_id!, {
        meeting_id: m.id,
        text: '5초 뒤 참가자의 기록을 재개합니다.',
      });
      await new Promise((r) => setTimeout(r, 5000));
      capture.meeting = await store.transition(guild.id, m.id, 'RECORDING', m.fencing);
      for (const gap of (await store.snapshot(guild.id, m.id)).gaps.filter(
        (g) => g.reason === 'PAUSED' && g.end_ms === null,
      ))
        await store.gap(guild.id, m.id, { ...gap, end_ms: Math.round(capture.now()) });
      await capture.resume(await participants(guild, m));
      return;
    }
  } catch (e) {
    await say(
      e instanceof DomainError
        ? e.message
        : '요청을 처리하지 못했습니다. 설정과 현재 상태를 확인해 주세요.',
    ).catch(() => {});
  }
}
async function lifecycle(guild: Guild) {
  const m = await store.active(guild.id);
  if (!m) {
    for (const capture of captures.values()) capture.abort();
    captures.clear();
    return;
  }
  let capture = captures.get(m.id);
  if (!capture && !starts.has(m.id)) {
    const recovered = await store.reclaim(guild.id, m.id, owner);
    if (!recovered) return;
    const downtime = Date.now() - (m.lease_until?.getTime() ?? m.created_at.getTime());
    if (downtime > 120000 || m.status === 'STOPPING' || m.status === 'STARTING') {
      if (m.status !== 'STOPPING') await store.transition(guild.id, m.id, 'STOPPING');
      await store.clearDrafts(guild.id, m.id);
      await store.transition(guild.id, m.id, 'FINALIZING');
      return;
    }
    capture = new Capture(store, config, recovered, guild, owner);
    captures.set(m.id, capture);
    try {
      await capture.start(await participants(guild, recovered), true);
    } catch {
      capture.abort();
      captures.delete(m.id);
    }
    return;
  }
  if (!capture) return;
  const ps = await participants(guild, m),
    count = ps.filter((p) => p.present).length,
    now = Date.now();
  let stop = false;
  await store.withMeeting(guild.id, m.id, async (tx, current) => {
    if (!['RECORDING', 'PAUSED', 'DEGRADED'].includes(current.status)) return;
    const r = current.runtime;
    if (count === 0) {
      r.empty_since ??= now;
      if (now - r.empty_since >= 60000) stop = true;
    } else delete r.empty_since;
    if (count === 1) {
      r.one_since ??= now;
      r.one_deadline ??= r.one_since + 360000;
      if (now >= r.one_deadline - 60000 && r.one_warned !== r.one_deadline) {
        r.one_warned = r.one_deadline;
        await store.post(tx, m.id, guild.id, 'NOTICE', now, m.settings.notification_channel_id!, {
          meeting_id: m.id,
          text: '한 명만 남아 60초 후 기록을 종료합니다.',
          control: 'continue',
        });
      }
      if (now >= r.one_deadline) stop = true;
    } else {
      delete r.one_since;
      delete r.one_deadline;
      delete r.one_warned;
    }
    if (current.status === 'PAUSED') {
      const elapsed = now - Number(r.paused_at ?? now);
      if (elapsed >= 600000 && !r.pause_warned) {
        r.pause_warned = true;
        await store.post(tx, m.id, guild.id, 'NOTICE', now, m.settings.notification_channel_id!, {
          meeting_id: m.id,
          text: '기록이 일시정지되어 있습니다. 필요하면 재개해 주세요.',
        });
      }
      if (elapsed >= 1800000) stop = true;
    } else delete r.pause_warned;
    if (now >= Number(r.max_end_at) - 600000 && r.max_warned !== r.max_end_at) {
      r.max_warned = r.max_end_at;
      await store.post(tx, m.id, guild.id, 'NOTICE', now + 1, m.settings.notification_channel_id!, {
        meeting_id: m.id,
        text: '최대 기록 시간까지 10분 남았습니다.',
        control: 'extend',
      });
    }
    if (now >= Number(r.max_end_at)) stop = true;
    if (!ps.some((p) => p.user_id === current.controller_id && p.present)) {
      r.controller_absent ??= now;
      if (now - r.controller_absent >= 60000) {
        const eligible = ps.filter((p) => p.present && p.recording_eligible);
        eligible.sort(
          (a, b) =>
            Number(
              m.settings.facilitator_role_ids.some((id) =>
                guild.members.cache.get(b.user_id)?.roles.cache.has(id),
              ),
            ) -
            Number(
              m.settings.facilitator_role_ids.some((id) =>
                guild.members.cache.get(a.user_id)?.roles.cache.has(id),
              ),
            ),
        );
        if (eligible[0]) {
          await sql`UPDATE meetings SET controller_id=${eligible[0].user_id} WHERE id=${m.id}`.execute(
            tx,
          );
          delete r.controller_absent;
          await store.post(
            tx,
            m.id,
            guild.id,
            'NOTICE',
            now + 2,
            m.settings.notification_channel_id!,
            {
              meeting_id: m.id,
              text: `진행자가 ${eligible[0].display_name}님으로 변경되었습니다.`,
            },
          );
        }
      }
    } else delete r.controller_absent;
    await store.saveView(tx, current);
    if (stop) await store.transitionLocked(tx, current, 'STOPPING', m.fencing);
  });
  if (stop) {
    await capture.stop();
    captures.delete(m.id);
  }
}
client.on(Events.InteractionCreate, (i) => void handle(i).catch(() => {}));
client.on(Events.VoiceStateUpdate, (_old, next) => {
  if (next.guild.id === config.DISCORD_GUILD_ID) void observe(next.guild).catch(() => {});
});
for (const event of [Events.GuildRoleUpdate, Events.ChannelUpdate])
  client.on(
    event as any,
    () =>
      void sql`SELECT pg_notify('authz_invalidated',${config.DISCORD_GUILD_ID})`
        .execute(store.db)
        .catch(() => {}),
  );
let reconcile: NodeJS.Timeout, timer: NodeJS.Timeout, lifetime: NodeJS.Timeout;
let reconciling = false,
  ticking = false,
  cycling = false;
client.once(Events.ClientReady, async () => {
  const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
  await guild.channels.fetch();
  await observe(guild);
  process.stdout.write(
    'Discord Gateway ready (real mode). No audio is collected before meeting start.\n',
  );
  reconcile = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void observe(guild)
      .finally(() => {
        reconciling = false;
      })
      .catch(() => {});
  }, 30000);
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void episodes
      .tick()
      .finally(() => {
        ticking = false;
      })
      .catch(() => {});
  }, 500);
  lifetime = setInterval(() => {
    if (cycling) return;
    cycling = true;
    void lifecycle(guild)
      .then(() =>
        store.health('bot', owner, { captures: [...captures.values()].map((c) => c.metrics()) }),
      )
      .finally(() => {
        cycling = false;
      })
      .catch(() => {});
  }, 2000);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcile);
    clearInterval(timer);
    clearInterval(lifetime);
    void Promise.all([...captures.values()].map((c) => c.stop().catch(() => {}))).then(() => {
      client.destroy();
      return store.close();
    });
  });
await client.login(config.DISCORD_BOT_TOKEN);
