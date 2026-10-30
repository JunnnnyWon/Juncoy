// QA 세션 발급 — 가장 최근 유효 oauth_sessions의 토큰을 복제해 새 쿠키를 만든다.
// 서버 측 디버깅/QA 전용 (DATABASE_URL + TOKEN_ENCRYPTION_KEY 필요).
//   node --import tsx scripts/qa-session.ts
import { loadConfig, openJson } from '@meeting/providers';
import { Store, sql, first } from '@meeting/db';
import { Auth } from '../apps/api/src/auth.ts';

const config = loadConfig();
const store = new Store(config.DATABASE_URL);
const auth = new Auth(store, config);

const userFilter = process.argv[2]; // optional Discord user id
const sess = await first<{
  id_hash: string;
  user_id: string;
  display_name: string;
  tokens: string;
}>(
  userFilter
    ? sql`SELECT id_hash, user_id, display_name, tokens FROM oauth_sessions
          WHERE user_id=${userFilter} AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`
    : sql`SELECT id_hash, user_id, display_name, tokens FROM oauth_sessions
          WHERE expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
  store.db,
);
if (!sess) {
  console.error('no valid oauth_sessions row');
  process.exit(1);
}
const tokens = openJson<{ expires_at: number }>(
  sess.tokens,
  config.TOKEN_ENCRYPTION_KEY,
  sess.id_hash,
);
if (tokens.expires_at < Date.now() + 60000)
  console.error('warning: cloned access token near expiry (will refresh on use)');
const cookie = await auth.create(
  { id: sess.user_id, username: sess.display_name },
  tokens as any,
);
console.log(JSON.stringify({ cookie, user_id: sess.user_id, display_name: sess.display_name }));
await store.db.destroy();
