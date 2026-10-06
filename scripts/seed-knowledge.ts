import 'dotenv/config';
import { KnowledgeStore } from '@meeting/knowledge-db';
import { sql, first } from '@meeting/db';

// 지식 파일럿 시드 — 단일 프로젝트 + 4개 소스 + 스코프 등록 (멱등).
// KNOWLEDGE_DATABASE_URL 필수. Discord 채널은 DISCORD_CONTEXT_CHANNELS(csv)
// 가 있으면 그것만, 없으면 DISCORD_BOT_TOKEN+DISCORD_GUILD_ID로 길드 텍스트
// 채널을 전수 등록한다. 추후 source_scopes.allowed=false로 제외 가능.

const CHANNEL_LIST = process.env.DISCORD_CONTEXT_CHANNELS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const guildChannels = async (): Promise<string[]> => {
  if (CHANNEL_LIST?.length) return CHANNEL_LIST;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guild = process.env.DISCORD_GUILD_ID;
  if (!token || !guild) return [];
  const res = await fetch(`https://discord.com/api/v10/guilds/${guild}/channels`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`guild channels ${res.status}`);
  const channels = (await res.json()) as { id: string; type: number }[];
  return channels.filter((c) => c.type === 0 || c.type === 5).map((c) => c.id); // text + announcement
};

if (process.argv[1]?.endsWith('seed-knowledge.ts')) {
  const url = process.env.KNOWLEDGE_DATABASE_URL;
  if (!url) throw new Error('KNOWLEDGE_DATABASE_URL is required');
  const store = new KnowledgeStore(url);
  try {
    const project =
      (await first<{ id: string }>(
        sql`SELECT id FROM knowledge_projects ORDER BY created_at LIMIT 1`,
        store.db,
      )) ??
      (await first<{ id: string }>(
        sql`INSERT INTO knowledge_projects(id, name) VALUES (gen_random_uuid(), ${
          process.env.KNOWLEDGE_PROJECT_NAME ?? '23시 정시퇴근'
        }) RETURNING id`,
        store.db,
      ))!;
    console.log('project', project.id);

    const upsertSource = async (kind: string, authRef: string) => {
      const s = await first<{ id: string }>(
        sql`INSERT INTO knowledge_sources(id, project_id, kind, auth_ref)
            VALUES (gen_random_uuid(), ${project.id}, ${kind}, ${authRef})
            ON CONFLICT (project_id, kind, auth_ref) DO UPDATE SET status='ACTIVE'
            RETURNING id`,
        store.db,
      );
      return s!.id;
    };
    const upsertScope = async (sourceId: string, key: string, metadata: any = {}) => {
      await sql`INSERT INTO source_scopes(id, source_id, scope_key, metadata)
                VALUES (gen_random_uuid(), ${sourceId}, ${key}, ${JSON.stringify(metadata)})
                ON CONFLICT (source_id, scope_key) DO NOTHING`.execute(store.db);
    };

    const meeting = await upsertSource('meeting', 'MEETING_DATABASE_URL');
    const github = await upsertSource('github', 'GITHUB_APP');
    const notion = await upsertSource('notion', 'NOTION_TOKEN');
    const discord = await upsertSource('discord', 'DISCORD_BOT_TOKEN');

    // GitHub: 전 브랜치 scope (main + 작업 브랜치). ref:% 패턴이 수집 대상.
    const repo = process.env.GITHUB_REPO ?? 'JunnnnyWon/Team_23';
    for (const ref of (process.env.GITHUB_REFS ?? 'main,SideView,Stairs').split(','))
      await upsertScope(github, `ref:${ref.trim()}`, { repo });

    // Notion: 워크스페이스 루트 — integration 연결 범위 전체.
    await upsertScope(notion, 'root:workspace');

    // Discord: 지정되거나 열거된 텍스트 채널.
    const channels = await guildChannels();
    for (const id of channels) await upsertScope(discord, `channel:${id}`);

    console.log(
      `seeded meeting=${meeting} github=${github} notion=${notion} discord=${discord} channels=${channels.length}`,
    );
  } finally {
    await store.close();
  }
}
