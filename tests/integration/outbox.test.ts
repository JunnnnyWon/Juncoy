import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { fixture, guild, channel } from './helpers';
import { sql, first, rows } from '@meeting/db';
import { Outbox } from '../../apps/worker/src/outbox';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});
it('AT-07 a successful Discord post followed by a crash is found rather than sent again', async () => {
  await f.begin();
  const outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'new-worker');
  const item = await first(sql<any>`SELECT * FROM outbox LIMIT 1`, f.store.db);
  const payload = await outbox.payload(item);
  await sql`UPDATE outbox SET status='RUNNING',attempts=1,lease_until=now()-interval '1 second' WHERE id=${item.id}`.execute(
    f.store.db,
  );
  vi.spyOn(outbox.rest, 'get').mockResolvedValue([
    {
      id: '900000000000000080',
      author: { id: f.config.DISCORD_CLIENT_ID },
      timestamp: new Date().toISOString(),
      embeds: payload.embeds,
    },
  ]);
  const post = vi.spyOn(outbox.rest, 'post').mockRejectedValue(new Error('must not post'));
  await outbox.tick();
  expect(post).not.toHaveBeenCalled();
  const result = await first(sql<any>`SELECT * FROM outbox WHERE id=${item.id}`, f.store.db);
  expect(result.status).toBe('SENT');
  expect(result.message_id).toBe('900000000000000080');
});
it('AT-07 an ambiguous missing response is quarantined without a blind resend', async () => {
  await f.begin();
  const outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'new-worker');
  await sql`UPDATE outbox SET status='RUNNING',attempts=1,lease_until=now()-interval '1 second'`.execute(
    f.store.db,
  );
  vi.spyOn(outbox.rest, 'get').mockResolvedValue([]);
  const post = vi.spyOn(outbox.rest, 'post').mockRejectedValue(new Error('must not post'));
  await outbox.tick();
  expect(post).not.toHaveBeenCalled();
  expect((await first(sql<any>`SELECT status FROM outbox`, f.store.db)).status).toBe(
    'NEEDS_RECONCILIATION',
  );
});
it('a confirmed deleted recording card is restored only once', async () => {
  await f.begin();
  const outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'worker');
  await sql`UPDATE outbox SET status='SENT',message_id='900000000000000080'`.execute(f.store.db);
  vi.spyOn(outbox.rest, 'get').mockRejectedValue({ status: 404 });
  await outbox.restoreDeletedCards();
  expect((await rows(sql`SELECT * FROM outbox`, f.store.db)).length).toBe(2);
  await sql`UPDATE outbox SET status='SENT',message_id='900000000000000081' WHERE revision=2`.execute(
    f.store.db,
  );
  await outbox.restoreDeletedCards();
  expect((await rows(sql`SELECT * FROM outbox`, f.store.db)).length).toBe(2);
});
it('closed meetings remove old recording and extension controls', async () => {
  const m = await f.begin();
  await f.store.post(f.store.db, m.id, guild, 'NOTICE', 99, channel, {
    text: '종료 안내',
    control: 'continue',
  });
  const outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'worker');
  await f.store.transition(guild, m.id, 'STOPPING');
  await f.store.transition(guild, m.id, 'FINALIZING');
  await f.store.transition(guild, m.id, 'COMPLETED');
  await sql`UPDATE outbox SET status='SENT',message_id='900000000000000082'`.execute(f.store.db);
  const patch = vi.spyOn(outbox.rest, 'patch').mockResolvedValue({});
  await outbox.refresh();
  expect(patch).toHaveBeenCalledTimes(2);
  for (const call of patch.mock.calls) {
    const components = (call[1] as any).body.components;
    expect(components.flatMap((row: any) => row.components).every((b: any) => b.style === 5)).toBe(
      true,
    );
  }
  expect(
    (await rows(sql<any>`SELECT status FROM outbox`, f.store.db)).every(
      (r) => r.status === 'ARCHIVED',
    ),
  ).toBe(true);
});

it('deletion waits for a summary delivery receipt and then removes that exact message', async () => {
  const m = await f.begin();
  await f.store.transition(guild, m.id, 'STOPPING');
  await f.store.transition(guild, m.id, 'FINALIZING');
  await sql`UPDATE jobs SET due_at=now()`.execute(f.store.db);
  const job = (await f.store.claimJob('test'))!;
  const result = {
    title: '검증된 회의록',
    summary: [],
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    blockers: [],
    next_agenda: [],
    quality_notes: [],
  };
  await f.store.adoptSummary(guild, m.id, 0, result, 'mock', 'mock', false, job);
  await sql`UPDATE outbox SET status='ARCHIVED' WHERE kind<>'SUMMARY'`.execute(f.store.db);
  const outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'delivery-test');
  let entered!: () => void, respond!: (value: any) => void;
  const sending = new Promise<void>((r) => (entered = r));
  vi.spyOn(outbox.rest, 'post').mockImplementation(async () => {
    entered();
    return new Promise((r) => (respond = r));
  });
  const tick = outbox.tick();
  await sending;
  let deleted = false;
  const deletion = f.store.deleteMeeting(guild, m.id, 'admin').then(() => {
    deleted = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(deleted).toBe(false);
  respond({ id: '900000000000000099' });
  await tick;
  await deletion;
  const message = await first(
    sql<{
      message_id: string;
      status: string;
    }>`SELECT message_id,status FROM outbox WHERE kind='SUMMARY'`,
    f.store.db,
  );
  expect(message!.message_id).toBe('900000000000000099');
  await expect(f.store.meeting(guild, m.id)).rejects.toThrow(
    '회의를 찾을 수 없거나 열람 권한이 없습니다.',
  );
  const remove = vi.spyOn(outbox.rest, 'delete').mockResolvedValue(undefined);
  await outbox.removeMessages(m.id);
  expect(remove).toHaveBeenCalledWith(expect.stringContaining('900000000000000099'));
});

it('deletion reconciles a missing receipt and refuses to declare an ambiguous delivery deleted', async () => {
  const m = await f.begin(),
    outbox = new Outbox(f.store, { ...f.config, PROVIDER_MODE: 'real' }, 'worker');
  const item = await first(sql<any>`SELECT * FROM outbox LIMIT 1`, f.store.db),
    payload = await outbox.payload(item);
  await sql`UPDATE outbox SET status='CANCELLED',attempts=1,error_code='DELIVERY_UNCERTAIN' WHERE id=${item.id}`.execute(
    f.store.db,
  );
  const get = vi.spyOn(outbox.rest, 'get').mockResolvedValue([]),
    del = vi.spyOn(outbox.rest, 'delete').mockResolvedValue(undefined);
  await expect(outbox.removeMessages(m.id)).rejects.toThrow('MESSAGE_DELETION_UNCERTAIN');
  expect(del).not.toHaveBeenCalled();
  get.mockResolvedValue([
    {
      id: '900000000000000088',
      author: { id: f.config.DISCORD_CLIENT_ID },
      timestamp: new Date().toISOString(),
      embeds: payload.embeds,
    },
  ]);
  await outbox.removeMessages(m.id);
  expect(del).toHaveBeenCalledWith(expect.stringContaining('900000000000000088'));
});
