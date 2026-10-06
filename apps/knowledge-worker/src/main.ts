import 'dotenv/config';
import { hostname } from 'node:os';
import { KnowledgeStore, sql, rows } from '@meeting/knowledge-db';
import {
  indexerTick,
  JuncoyCollector,
  MeetingReader,
  GitHubCollector,
  GitHubRest,
  InstallationTokenProvider,
  StaticTokenProvider,
  UpstageEmbeddings,
  ensureProfile,
} from '@meeting/knowledge';
import { loadKnowledgeConfig } from '@meeting/providers';

// 지식 워커 — spec §10/§16: 별도 큐(knowledge_jobs) 소비 + 출처별 폴링.
// extract 잡 → 청크 set 원자 교체, index 잡 → 활성 profile 임베딩.
// Juncoy 회의는 5초 polling, GitHub은 ref별 tree 대조 (webhook은 신호일 뿐).

const INDEX_MS = 3_000;
const JUNCOY_MS = 5_000;
const GITHUB_MS = 60_000;

const log = (m: string) => process.stdout.write(`knowledge-worker ${m}\n`);

const main = async () => {
  const config = loadKnowledgeConfig();
  if (config.KNOWLEDGE_ENABLED !== 'true') {
    log('disabled (KNOWLEDGE_ENABLED)');
    return;
  }
  const store = new KnowledgeStore(config.KNOWLEDGE_DATABASE_URL);
  const owner = `worker:${hostname()}:${process.pid}`;
  const embeddings = config.UPSTAGE_API_KEY
    ? new UpstageEmbeddings(
        config.UPSTAGE_API_KEY,
        config.UPSTAGE_EMBEDDING_QUERY_MODEL,
        config.UPSTAGE_EMBEDDING_DOCUMENT_MODEL,
      )
    : undefined;
  if (embeddings) {
    const id = await ensureProfile(
      store,
      'upstage',
      config.UPSTAGE_EMBEDDING_QUERY_MODEL,
      config.UPSTAGE_EMBEDDING_DOCUMENT_MODEL,
      4096,
    );
    log(`embedding profile ${id}`);
  }

  // ── 잡 인덱서 루프 ─────────────────────────────────────────────
  const runIndex = async () => {
    try {
      const r = await indexerTick(store, owner, { embeddings });
      if (r.extracted || r.embedded || r.failed)
        log(`indexer extracted=${r.extracted} embedded=${r.embedded} failed=${r.failed}`);
    } catch (e) {
      process.stderr.write(`indexer tick: ${e}\n`);
    }
  };
  setInterval(() => void runIndex(), INDEX_MS);
  void runIndex();

  // ── Juncoy 회의 동기화 루프 (§6.4, 5초) ────────────────────────
  if (config.MEETING_DATABASE_URL) {
    const reader = new MeetingReader(config.MEETING_DATABASE_URL, 2);
    const runMeetings = async () => {
      try {
        for (const src of await rows<{ id: string }>(
          sql`SELECT id FROM knowledge_sources WHERE kind='meeting' AND status='ACTIVE'`,
          store.db,
        )) {
          const collector = new JuncoyCollector(store, reader, config.DISCORD_GUILD_ID, src.id);
          const r = await collector.syncOnce();
          if (r.synced) log(`meeting sync ${src.id}: ${JSON.stringify(r)}`);
        }
      } catch (e) {
        process.stderr.write(`meeting sync: ${e}\n`);
      }
    };
    setInterval(() => void runMeetings(), JUNCOY_MS);
    void runMeetings();
  } else log('MEETING_DATABASE_URL unset — meeting collector off');

  // ── GitHub ref 대조 루프 (§6.2, 60초 — webhook 실시간은 신호로만) ──
  const ghKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const ghApp = process.env.GITHUB_APP_ID;
  const ghInstall = process.env.GITHUB_INSTALLATION_ID;
  const ghPat = process.env.GITHUB_TOKEN;
  if ((ghApp && ghKey && ghInstall) || ghPat) {
    const tokens =
      ghApp && ghKey && ghInstall
        ? new InstallationTokenProvider(ghApp, ghKey.replace(/\\n/g, '\n'), ghInstall)
        : new StaticTokenProvider(ghPat!);
    const rest = new GitHubRest(tokens);
    const runGitHub = async () => {
      try {
        const scopes = await rows<{ source_id: string; scope_key: string; metadata: any }>(
          sql`SELECT s.source_id, s.scope_key, s.metadata
              FROM source_scopes s JOIN knowledge_sources k ON k.id=s.source_id
              WHERE k.kind='github' AND k.status='ACTIVE' AND s.allowed
                AND s.scope_key LIKE 'ref:%'`,
          store.db,
        );
        for (const sc of scopes) {
          const repo = sc.metadata?.repo ?? process.env.GITHUB_REPO;
          const repoId = sc.metadata?.repo_id ?? repo;
          if (!repo) continue;
          const ref = sc.scope_key.slice('ref:'.length);
          try {
            await new GitHubCollector(store, rest, repo, repoId, sc.source_id).reconcileRef(ref);
          } catch (e) {
            process.stderr.write(`github ${repo}@${ref}: ${e}\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`github loop: ${e}\n`);
      }
    };
    setInterval(() => void runGitHub(), GITHUB_MS);
    void runGitHub();
  } else log('github auth unset — github collector off');
};

main().catch((e) => {
  process.stderr.write(`knowledge-worker fatal: ${e}\n`);
  process.exit(1);
});
