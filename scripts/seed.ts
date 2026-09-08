import 'dotenv/config';
import { Store, sql, first, json, type Job } from '@meeting/db';
import { loadConfig, emptySummary, PROMPT_HASH } from '@meeting/providers';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
export const DEMO_GUILD = '100000000000000001';
export const demoPeople = [
  '김준',
  '이서연',
  '박도윤',
  '정하린',
  '최민수',
  '한지우',
  '윤수빈',
  '오시온',
  '강지호',
  '배유진',
  '임서우',
  '권도현',
].map((name, i) => ({
  user_id: String(100000000000000010n + BigInt(i)),
  display_name: name,
  present: i < 6,
  recording_eligible: i < 6,
}));
export const demoLines = [
  '이번 스프린트는 전투의 손맛을 먼저 맞추면 좋겠습니다.',
  '회피 직후 공격으로 연결되는 구간을 조금 더 부드럽게 다듬어야 해요.',
  '플레이테스트에서 보스의 선행 동작이 잘 안 보인다는 의견이 있었어요.',
  '그 부분은 이펙트의 밝기와 타이밍을 같이 확인해 볼게요.',
  '회피 쿨타임은 2초로 확정합니다. 다음 테스트에서 체감 난이도를 확인합시다.',
  '제가 애니메이션 전환과 입력 버퍼를 정리하겠습니다.',
  'QA 빌드에는 히트박스 표시 옵션도 넣어 주시면 확인하기 편할 것 같아요.',
  'UI 쪽은 체력 표시와 피격 피드백이 겹치지 않게 조정해 볼까요?',
  '오디오도 강한 타격과 일반 타격을 구분할 수 있도록 샘플을 준비하겠습니다.',
  '다음 회의에서는 수정한 빌드를 함께 플레이해 봅시다.',
];
export async function seed(store: Store) {
  const existing = await first(
    sql<{
      id: string;
    }>`SELECT id FROM meetings WHERE guild_id=${DEMO_GUILD} AND deleted_at IS NULL AND status='RECORDING'`,
    store.db,
  );
  if (existing) return existing.id;
  await store.setConfig(
    DEMO_GUILD,
    {
      voice_channel_ids: ['100000000000000002'],
      notification_channel_id: '100000000000000003',
      record_channel_id: '100000000000000004',
      admin_user_ids: demoPeople.map((p) => p.user_id),
      team_role_ids: ['100000000000000005'],
      monthly_api_budget_krw: 50000,
    },
    demoPeople[0]!.user_id,
  );
  for (const p of demoPeople) await store.consent(DEMO_GUILD, p.user_id, true);
  const begin = async (title: string) => {
    const m = await store.begin({
      guildId: DEMO_GUILD,
      channelId: '100000000000000002',
      channelName: title,
      userId: demoPeople[0]!.user_id,
      interactionId: 'demo:' + randomUUID(),
      owner: 'demo',
      participants: demoPeople,
      isMock: true,
    });
    await store.transition(DEMO_GUILD, m.id, 'RECORDING');
    await store.withMeeting(DEMO_GUILD, m.id, async (tx, current) => {
      current.view.started_at = new Date(Date.now() - 2100000).toISOString();
      await store.saveView(tx, current);
      await sql`UPDATE meetings SET lease_until=now()+interval '1 hour' WHERE id=${m.id}`.execute(
        tx,
      );
    });
    return m;
  };
  const completed = await begin('플레이테스트 리뷰');
  for (let i = 0; i < 10; i++) {
    const p = demoPeople[i % 6]!;
    await store.upsertTranscript({
      guildId: DEMO_GUILD,
      meetingId: completed.id,
      userId: p.user_id,
      displayName: p.display_name,
      sourceKey: 'demo:' + i,
      start: i * 30000,
      end: i * 30000 + 5000,
      text: demoLines[i]!,
      final: true,
    });
  }
  await store.transition(DEMO_GUILD, completed.id, 'STOPPING');
  await store.transition(DEMO_GUILD, completed.id, 'FINALIZING');
  const segments = await store.allSegments(DEMO_GUILD, completed.id);
  const summary = emptySummary('플레이테스트 리뷰', ['데모 데이터입니다.']);
  summary.summary = [demoLines[0]!, demoLines[4]!, demoLines[9]!];
  summary.decisions = [
    { decision: demoLines[4]!, reason: null, evidence_segment_ids: [segments[4]!.segment_id] },
  ];
  summary.action_items = [
    {
      task: demoLines[5]!,
      owner_user_id: segments[5]!.user_id,
      due_date: null,
      due_date_text: null,
      evidence_segment_ids: [segments[5]!.segment_id],
    },
  ];
  summary.topics = [
    {
      category: '프로그래밍',
      title: '회피와 공격의 연결감',
      discussion: demoLines[1]!,
      evidence_segment_ids: [segments[1]!.segment_id],
    },
    {
      category: 'QA',
      title: '다음 테스트 준비',
      discussion: demoLines[6]!,
      evidence_segment_ids: [segments[6]!.segment_id],
    },
  ];
  const jobId = randomUUID();
  await sql`INSERT INTO jobs(id,key,kind,meeting_id,payload,status,generation,lease_until) VALUES(${jobId},${jobId},'SEED',${completed.id},'{}','RUNNING',1,now()+interval '1 hour')`.execute(
    store.db,
  );
  await store.adoptSummary(
    DEMO_GUILD,
    completed.id,
    10,
    summary,
    'mock-solar',
    PROMPT_HASH,
    false,
    {
      id: jobId,
      key: jobId,
      kind: 'SEED',
      meeting_id: completed.id,
      payload: {},
      attempts: 1,
      generation: 1,
      provider_job_id: null,
    },
  );
  await sql`UPDATE jobs SET status='DONE' WHERE meeting_id=${completed.id}`.execute(store.db);
  await sql`UPDATE meetings SET created_at=now()-interval '2 days' WHERE id=${completed.id}`.execute(
    store.db,
  );
  const active = await begin('전투 시스템 스프린트');
  for (let i = 0; i < 220; i++) {
    const p = demoPeople[i % 6]!;
    await store.upsertTranscript({
      guildId: DEMO_GUILD,
      meetingId: active.id,
      userId: p.user_id,
      displayName: p.display_name,
      sourceKey: 'demo-seed:' + i,
      start: i * 9000,
      end: i * 9000 + 5200,
      text:
        i === 0
          ? '장기보관 검색 검증: 네온벚꽃 테스트 안건입니다.'
          : demoLines[i % demoLines.length]!,
      final: true,
    });
  }
  await store.marker(DEMO_GUILD, active.id, demoPeople[0]!.user_id, '회피 쿨타임 결정');
  await store.gap(DEMO_GUILD, active.id, {
    gap_id: randomUUID(),
    user_id: null,
    start_ms: 780000,
    end_ms: 810000,
    reason: 'PAUSED',
    recoverable: false,
    resolved: false,
  });
  return active.id;
}
if (process.argv[1]?.endsWith('seed.ts')) {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production');
  const store = new Store(config.DATABASE_URL);
  try {
    const id = await seed(store);
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/demo.json',
      JSON.stringify({ meeting_id: id, guild_id: DEMO_GUILD }, null, 2),
    );
    process.stdout.write('Mock meeting ready: ' + id + '\n');
  } finally {
    await store.close();
  }
}
