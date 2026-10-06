import { randomBytes } from 'node:crypto';
import { Store, sql, first, json } from '@meeting/db';
import { hash, openJson, sealJson, type AppConfig } from '@meeting/providers';
import { DomainError } from '@meeting/domain';
export interface Session {
  id_hash: string;
  user_id: string;
  display_name: string;
  tokens: string;
  expires_at: Date;
}
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  mock?: boolean;
}
export class Auth {
  epoch = 0;
  private cache = new Map<string, { until: number; allowed: boolean }>();
  private pending = new Map<string, Promise<{ until: number; allowed: boolean }>>();
  private cooldowns = new Map<string, number>();
  constructor(
    private store: Store,
    private config: AppConfig,
  ) {}
  invalidate() {
    this.epoch++;
    this.cache.clear();
  }
  async session(cookie?: string) {
    if (!cookie || !/^[A-Za-z0-9_-]{40,100}$/.test(cookie))
      throw new DomainError('UNAUTHENTICATED', 'Discord 로그인이 필요합니다.', 401);
    const session = await first(
      sql<Session>`SELECT * FROM oauth_sessions WHERE id_hash=${hash(cookie)} AND expires_at>now()`,
      this.store.db,
    );
    if (!session) throw new DomainError('UNAUTHENTICATED', '세션이 만료되었습니다.', 401);
    return session;
  }
  async create(
    user: { id: string; username: string; global_name?: string | null },
    tokens: Tokens,
  ) {
    const cookie = randomBytes(32).toString('base64url'),
      idHash = hash(cookie);
    await sql`INSERT INTO oauth_sessions(id_hash,user_id,display_name,tokens,expires_at) VALUES(${idHash},${user.id},${user.global_name ?? user.username},${sealJson(tokens, this.config.TOKEN_ENCRYPTION_KEY, idHash)},now()+interval '12 hours')`.execute(
      this.store.db,
    );
    return cookie;
  }
  async tokens(session: Session): Promise<Tokens> {
    let tokens = openJson<Tokens>(
      session.tokens,
      this.config.TOKEN_ENCRYPTION_KEY,
      session.id_hash,
    );
    if (tokens.mock) {
      if (this.config.PROVIDER_MODE !== 'mock')
        throw new DomainError('UNAUTHENTICATED', undefined, 401);
      return tokens;
    }
    if (tokens.expires_at < Date.now() + 60000) {
      const response = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.DISCORD_CLIENT_ID,
          client_secret: this.config.DISCORD_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok)
        throw new DomainError('AUTHZ_UNAVAILABLE', '권한을 확인할 수 없습니다.', 503, true);
      const data = (await response.json()) as any;
      tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      session.tokens = sealJson(tokens, this.config.TOKEN_ENCRYPTION_KEY, session.id_hash);
      await sql`UPDATE oauth_sessions SET tokens=${session.tokens} WHERE id_hash=${session.id_hash} AND expires_at>now()`.execute(
        this.store.db,
      );
    }
    return tokens;
  }
  async check(session: Session, guildId: string, channelId?: string) {
    if (guildId !== this.config.DISCORD_GUILD_ID)
      throw new DomainError('MEETING_NOT_FOUND', undefined, 404);
    const key = session.id_hash + ':' + guildId + ':' + this.epoch;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return this.require(cached);
    const cooldown = this.cooldowns.get(key) ?? 0;
    if (cooldown > Date.now())
      throw new DomainError(
        'AUTHZ_RATE_LIMITED',
        'Discord 권한 확인을 잠시 기다리고 있습니다.',
        503,
        true,
        Math.ceil((cooldown - Date.now()) / 1000),
      );
    this.cooldowns.delete(key);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.evaluate(session, guildId, channelId)
        .then((result) => {
          this.cache.set(key, result);
          return result;
        })
        .catch((error) => {
          if (error instanceof DomainError && error.retryAfterSeconds)
            this.cooldowns.set(key, Date.now() + error.retryAfterSeconds * 1000);
          throw error;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return this.require(await pending);
  }
  private require(result: { until: number; allowed: boolean }) {
    if (!result.allowed)
      throw new DomainError(
        'WORKSPACE_FORBIDDEN',
        '23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.',
        403,
      );
    return result.until;
  }
  private async evaluate(session: Session, guildId: string, channelId?: string) {
    const verifiedAt = Date.now();
    const settings = await this.store.getConfig(guildId);
    const tokens = await this.tokens(session);
    if (tokens.mock && this.config.PROVIDER_MODE === 'mock')
      return {
        until: Math.min(verifiedAt + 10000, session.expires_at.getTime()),
        allowed: settings.admin_user_ids.includes(session.user_id),
      };
    const get = async (path: string, bearer = false) => {
      const response = await fetch('https://discord.com/api/v10' + path, {
        headers: {
          Authorization: bearer
            ? 'Bearer ' + tokens.access_token
            : 'Bot ' + this.config.DISCORD_BOT_TOKEN,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404 || response.status === 403 || response.status === 401)
        return null;
      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
        const seconds = Number(body.retry_after ?? response.headers.get('Retry-After') ?? 30);
        throw new DomainError(
          'AUTHZ_RATE_LIMITED',
          'Discord 권한 확인을 잠시 기다리고 있습니다.',
          503,
          true,
          Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 30,
        );
      }
      if (!response.ok)
        throw new DomainError(
          'AUTHZ_UNAVAILABLE',
          '현재 Discord 권한을 확인할 수 없습니다.',
          503,
          true,
        );
      return response.json() as Promise<any>;
    };
    try {
      const [identity, member] = await Promise.all([
        get('/users/@me', true),
        get(`/guilds/${guildId}/members/${session.user_id}`),
      ]);
      return {
        until: Math.min(verifiedAt + 10000, session.expires_at.getTime()),
        allowed: !!identity && identity.id === session.user_id && !!member,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('AUTHZ_UNAVAILABLE', '권한 확인이 지연되고 있습니다.', 503, true);
    }
  }
}
