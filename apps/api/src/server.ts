import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Store, sql, rows, first, json, type MeetingRow } from '@meeting/db';
import { type AppConfig, hash, readEncrypted, flacToPcm } from '@meeting/providers';
import { randomUUID } from 'node:crypto';
import { DomainError, parseCursor, safeReturnTo } from '@meeting/domain';
import { Id, Snapshot, SummaryResult } from '@meeting/contracts';
import { Auth, type Session } from './auth.ts';
import { exportMarkdown, exportText } from './export.ts';
import { segmentAudio, type AudioChunk } from './segment-audio.ts';
import { registerKnowledgeRoutes } from './knowledge.ts';
export async function buildServer(config: AppConfig, store: Store) {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            serializers: {
              req: (req) => ({ method: req.method, path: req.url?.split('?')[0] }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
    trustProxy: 'loopback',
    bodyLimit: 16384,
  });
  const auth = new Auth(store, config);
  const origin = new URL(config.APP_BASE_URL).origin;
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: '1 minute',
    keyGenerator: async (req) => {
      if (req.cookies.session) {
        try {
          return 'user:' + (await auth.session(req.cookies.session)).user_id;
        } catch {}
      }
      return 'ip:' + req.ip;
    },
  });
  const cookieOptions = {
    httpOnly: true,
    secure: config.APP_BASE_URL.startsWith('https://'),
    sameSite: 'lax' as const,
    path: '/',
  };
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/auth'))
      reply.header('Cache-Control', 'private, no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin)
      throw new DomainError('INVALID_ORIGIN', '잘못된 요청입니다.', 403);
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as any;
    const known = e instanceof DomainError;
    const status = known
      ? e.status
      : e instanceof z.ZodError
        ? 400
        : e.statusCode === 429
          ? 429
          : 500;
    if (known && e.retryAfterSeconds) reply.header('Retry-After', String(e.retryAfterSeconds));
    reply.code(status).send({
      error: {
        code: known
          ? e.code
          : status === 400
            ? 'INVALID_ARGUMENT'
            : status === 429
              ? 'RATE_LIMITED'
              : 'TEMPORARY_FAILURE',
        message: known
          ? e.message
          : status === 400
            ? '요청 값을 확인해 주세요.'
            : '요청을 처리하지 못했습니다.',
        request_id: req.id,
        retryable: known ? e.retryable : status >= 500,
      },
    });
  });
  const checkMeeting = async (req: any) => {
    const session = await auth.session(req.cookies.session);
    await auth.check(session, config.DISCORD_GUILD_ID);
    const id = Id.parse(req.params.id);
    const meeting = await store.workspaceMeeting(config.DISCORD_GUILD_ID, id);
    const until = await auth.check(session, config.DISCORD_GUILD_ID);
    return { session, meeting, until };
  };
  app.get('/healthz', async () => {
    await sql`SELECT 1`.execute(store.db);
    return { ok: true, mode: config.PROVIDER_MODE };
  });
  app.get('/api/me', async (req) => {
    const s = await auth.session(req.cookies.session);
    await auth.check(s, config.DISCORD_GUILD_ID);
    return {
      user_id: s.user_id,
      display_name: s.display_name,
      mode: config.PROVIDER_MODE,
      expires_at: s.expires_at.toISOString(),
    };
  });
  app.get('/auth/discord', async (req, reply) => {
    const returnTo = safeReturnTo((req.query as any).return_to);
    if (config.PROVIDER_MODE === 'mock') {
      const settings = await store.getConfig(config.DISCORD_GUILD_ID);
      const id = settings.admin_user_ids[0];
      if (!id) throw new DomainError('DEMO_NOT_SEEDED', '데모 데이터를 먼저 준비해 주세요.', 503);
      const value = await auth.create(
        { id, username: '김준', global_name: '김준' },
        {
          access_token: 'mock',
          refresh_token: 'mock',
          expires_at: Date.now() + 43200000,
          mock: true,
        },
      );
      return reply
        .setCookie('session', value, { ...cookieOptions, maxAge: 43200 })
        .redirect(returnTo);
    }
    const state = randomBytes(32).toString('base64url'),
      browser = randomBytes(32).toString('base64url');
    await sql`INSERT INTO oauth_states(state_hash,browser_hash,return_to,expires_at) VALUES(${hash(state)},${hash(browser)},${returnTo},now()+interval '5 minutes')`.execute(
      store.db,
    );
    const query = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      redirect_uri: config.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds.members.read',
      state,
    });
    return reply
      .setCookie('oauth_browser', browser, { ...cookieOptions, maxAge: 300 })
      .redirect('https://discord.com/oauth2/authorize?' + query);
  });
  app.get('/auth/discord/callback', async (req, reply) => {
    const q = z.object({ code: z.string().max(512), state: z.string().max(128) }).parse(req.query);
    const browser = req.cookies.oauth_browser;
    if (!browser) throw new DomainError('INVALID_OAUTH_STATE', '로그인을 다시 시작해 주세요.', 400);
    const state = await first(
      sql<{
        return_to: string;
      }>`DELETE FROM oauth_states WHERE state_hash=${hash(q.state)} AND browser_hash=${hash(browser)} AND expires_at>now() RETURNING return_to`,
      store.db,
    );
    if (!state) throw new DomainError('INVALID_OAUTH_STATE', '로그인을 다시 시작해 주세요.', 400);
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.DISCORD_CLIENT_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: q.code,
        redirect_uri: config.DISCORD_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new DomainError('AUTHZ_UNAVAILABLE', 'Discord 로그인에 실패했습니다.', 503, true);
    const tokens = (await response.json()) as any;
    const u = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
      signal: AbortSignal.timeout(8000),
    });
    if (!u.ok) throw new DomainError('AUTHZ_UNAVAILABLE', undefined, 503, true);
    const user = (await u.json()) as any;
    const value = await auth.create(user, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });
    try {
      await auth.check(await auth.session(value), config.DISCORD_GUILD_ID);
    } catch (error) {
      await sql`DELETE FROM oauth_sessions WHERE id_hash=${hash(value)}`.execute(store.db);
      return reply
        .clearCookie('oauth_browser', { path: '/' })
        .clearCookie('session', { path: '/' })
        .redirect(
          '/login?access=' +
            (error instanceof DomainError && error.status === 403 ? 'denied' : 'unavailable'),
        );
    }
    return reply
      .clearCookie('oauth_browser', { path: '/' })
      .setCookie('session', value, { ...cookieOptions, maxAge: 43200 })
      .redirect(safeReturnTo(state.return_to));
  });
  app.post('/auth/logout', async (req, reply) => {
    if (req.cookies.session)
      await sql`DELETE FROM oauth_sessions WHERE id_hash=${hash(req.cookies.session)}`.execute(
        store.db,
      );
    auth.invalidate();
    return reply.clearCookie('session', { path: '/' }).send({ ok: true });
  });
  app.get('/api/meetings', async (req) => {
    const session = await auth.session(req.cookies.session);
    await auth.check(session, config.DISCORD_GUILD_ID);
    const q = z
      .object({
        q: z.string().max(100).optional(),
        status: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        cursor: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    let cursor: { at: string; id: string } | null = null;
    if (q.cursor) {
      try {
        cursor = z
          .object({ at: z.iso.datetime(), id: Id })
          .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      } catch {
        throw new DomainError('INVALID_CURSOR');
      }
    }
    const candidates = await rows(
      sql<MeetingRow>`SELECT * FROM meetings WHERE EXISTS(SELECT 1 FROM workspace_meetings w WHERE w.meeting_id=meetings.id AND w.workspace_guild_id=${config.DISCORD_GUILD_ID}) AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE meeting_id=meetings.id) ${q.q ? sql`AND strpos(lower(view->>'title'),lower(${q.q}))>0` : sql``} ${q.status ? sql`AND status=${q.status}` : sql``} ${q.date ? sql`AND (created_at AT TIME ZONE 'Asia/Seoul')::date=${q.date}::date` : sql``} ${cursor ? sql`AND (created_at,id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`,
      store.db,
    );
    const visible = candidates.slice(0, q.limit);
    const last = candidates[Math.min(q.limit, candidates.length) - 1];
    return {
      meetings: visible.map((m) => m.view),
      next_cursor:
        candidates.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.created_at.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
      mode: config.PROVIDER_MODE,
    };
  });
  app.get('/api/meetings/:id/snapshot', async (req) => {
    const { meeting } = await checkMeeting(req);
    return Snapshot.parse(await store.snapshot(meeting.guild_id, meeting.id));
  });
  const pageQuery = z.object({
    before: z.string().max(512).optional(),
    cursor: z.string().max(512).optional(),
    speaker: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  });
  app.get('/api/meetings/:id/transcript', async (req) => {
    const { meeting } = await checkMeeting(req);
    const q = pageQuery.parse(req.query);
    return store.transcript(meeting.guild_id, meeting.id, q);
  });
  app.get('/api/meetings/:id/search', async (req) => {
    const { meeting } = await checkMeeting(req);
    const q = pageQuery
      .extend({
        q: z.string().min(2).max(100),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return store.transcript(meeting.guild_id, meeting.id, { ...q, before: q.cursor ?? q.before });
  });
  app.get('/api/meetings/:id/segments/:segment_id', async (req) => {
    const { meeting } = await checkMeeting(req);
    const id = Id.parse((req.params as any).segment_id);
    const q = z
      .object({ transcript_version: z.coerce.number().int().nonnegative().optional() })
      .parse(req.query);
    return store.segmentContext(meeting.guild_id, meeting.id, id, q.transcript_version);
  });
  app.get('/api/meetings/:id/segments/:segment_id/audio', async (req, reply) => {
    const { meeting } = await checkMeeting(req);
    const q = z
      .object({ transcript_version: z.coerce.number().int().nonnegative().optional() })
      .parse(req.query);
    const context = await store.segmentContext(
      meeting.guild_id,
      meeting.id,
      Id.parse((req.params as any).segment_id),
      q.transcript_version ?? meeting.view.transcript_version,
    );
    const body = context.segment;
    if (!body?.is_final || body.end_ms === null)
      throw new DomainError('AUDIO_UNAVAILABLE', '확정된 발언의 원음만 재생할 수 있습니다.', 404);
    const chunks = await rows<AudioChunk>(
      sql`SELECT id,storage_ref,start_ms,end_ms FROM audio_chunks WHERE meeting_id=${meeting.id}::uuid AND user_id=${body.user_id} AND start_ms<${body.end_ms} AND end_ms>${body.start_ms} AND expires_at>now() ORDER BY start_ms LIMIT 513`,
      store.db,
    );
    const result = await segmentAudio(config, chunks, body.start_ms, body.end_ms);
    await checkMeeting(req);
    return reply
      .type('audio/wav')
      .header('Cache-Control', 'private, no-store')
      .header('X-Audio-Missing-Ms', String(Math.round(result.missingMs)))
      .send(result.data);
  });
  app.get('/api/meetings/:id/summary', async (req) => {
    const { meeting } = await checkMeeting(req);
    return SummaryResult.parse(await store.summary(meeting.guild_id, meeting.id));
  });
  app.get('/api/meetings/:id/export', async (req, reply) => {
    const { meeting } = await checkMeeting(req);
    const q = z
      .object({
        format: z.enum(['md', 'txt']),
        transcript_version: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(req.query);
    if (
      q.transcript_version !== undefined &&
      !(await first(
        sql`SELECT 1 FROM summaries WHERE meeting_id=${meeting.id}::uuid AND transcript_version=${q.transcript_version}`,
        store.db,
      ))
    )
      throw new DomainError('INVALID_ARGUMENT', '완료된 전사 버전만 지정할 수 있습니다.');
    const version = q.transcript_version ?? meeting.view.transcript_version;
    const segments = await store.allSegments(meeting.guild_id, meeting.id, version);
    const summary = await first(
      sql<{
        result: any;
        summary_version: number;
      }>`SELECT result,summary_version FROM summaries WHERE meeting_id=${meeting.id}::uuid AND transcript_version=${version} ORDER BY summary_version DESC LIMIT 1`,
      store.db,
    );
    const gaps = (await store.snapshot(meeting.guild_id, meeting.id)).gaps;
    const content =
      q.format === 'md'
        ? exportMarkdown(
            meeting.view,
            segments,
            summary?.result ?? null,
            gaps,
            config.APP_BASE_URL,
            version,
          )
        : exportText(meeting.view, segments, gaps, version);
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="meeting-${meeting.id}-v${version}.${q.format}"`,
      )
      .send(content);
  });
  const connections = new Set<{ userId: string; close: () => void }>();
  const tickCache = new Map<string, Promise<any>>();
  const clearCache = setInterval(() => tickCache.clear(), 100);
  clearCache.unref();
  app.get('/api/meetings/:id/events', async (req, reply) => {
    let { session, meeting, until } = await checkMeeting(req);
    if (
      connections.size >= 40 ||
      [...connections].filter((c) => c.userId === session.user_id).length >= 3
    )
      throw new DomainError(
        'RATE_LIMITED',
        '동시에 열 수 있는 기록 화면 수를 초과했습니다.',
        429,
        true,
      );
    const after = (req.headers['last-event-id'] ?? (req.query as any).after ?? '0') as string;
    let cursor: string;
    try {
      cursor = parseCursor(after);
    } catch {
      cursor = '-1';
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write('retry: 1500\n\n');
    let closed = false,
      busy = false,
      blockedSince = 0,
      authEpoch = auth.epoch;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      connections.delete(connection);
      res.end();
    };
    const control = (event: string, reason: string) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify({ reason })}\n\n`);
      close();
    };
    const connection = { userId: session.user_id, close };
    connections.add(connection);
    const pump = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        if (Date.now() >= until || authEpoch !== auth.epoch) {
          session = await auth.session(req.cookies.session);
          meeting = await store.workspaceMeeting(config.DISCORD_GUILD_ID, meeting.id);
          until = await auth.check(session, config.DISCORD_GUILD_ID);
          authEpoch = auth.epoch;
        }
        if (res.writableLength > 1_000_000 || (blockedSince && Date.now() - blockedSince > 30000)) {
          control('sync.required', 'SLOW_CONSUMER');
          return;
        }
        if (res.writableNeedDrain) {
          blockedSince ||= Date.now();
          return;
        }
        blockedSince = 0;
        const range = await store.eventRange(meeting.id);
        if (!range) {
          control('access.revoked', 'DELETED');
          return;
        }
        if (BigInt(cursor) < BigInt(range.floor_seq)) {
          control('sync.required', 'CURSOR_EXPIRED');
          return;
        }
        if (BigInt(cursor) > BigInt(range.last_seq)) {
          control('sync.required', 'INVALID_CURSOR');
          return;
        }
        const key = meeting.id + ':' + cursor;
        let pending = tickCache.get(key);
        if (!pending) {
          pending = store.events(meeting.id, cursor);
          tickCache.set(key, pending);
        }
        const events = await pending;
        for (const event of events) {
          if (closed || Date.now() >= until || authEpoch !== auth.epoch) break;
          const frame = `id: ${event.event_seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          if (Buffer.byteLength(frame) + res.writableLength > 1_000_000) {
            control('sync.required', 'SLOW_CONSUMER');
            break;
          }
          const ok = res.write(frame);
          cursor = event.event_seq;
          if (!ok) {
            blockedSince = Date.now();
            break;
          }
        }
      } catch (e) {
        if (e instanceof DomainError && [401, 403, 404].includes(e.status))
          control('access.revoked', e.status === 401 ? 'SESSION_EXPIRED' : 'PERMISSION_REMOVED');
        else control('service.unavailable', 'AUTHZ_UNAVAILABLE');
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void pump(), 150);
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n');
    }, 15000);
    res.on('close', close);
    res.on('error', close);
    if (cursor === '-1') control('sync.required', 'INVALID_CURSOR');
    else void pump();
  });
  const listener = await store.pool.connect();
  await listener.query('LISTEN authz_invalidated');
  listener.on('notification', (message) => {
    if (message.payload === config.DISCORD_GUILD_ID) auth.invalidate();
  });
  listener.on('error', () => auth.invalidate());
  app.addHook('onClose', async () => {
    clearInterval(clearCache);
    for (const connection of connections) connection.close();
    await listener.query('UNLISTEN *').catch(() => {});
    listener.release();
  });
  registerKnowledgeRoutes(app, { auth, config });
  const dist = resolve('apps/web/dist');
  if (existsSync(dist)) {
    await app.register(serveStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/auth'))
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
