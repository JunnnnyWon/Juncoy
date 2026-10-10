import { randomUUID } from 'node:crypto';
import { Store, sql, first } from '@meeting/db';
import { loadConfig, ProviderError } from '@meeting/providers';
import { DomainError, backoff } from '@meeting/domain';
import { Outbox } from './outbox.ts';
import { Jobs } from './jobs.ts';
import { checkBudgets } from './budget.ts';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL),
  owner = randomUUID(),
  outbox = new Outbox(store, config, owner),
  jobs = new Jobs(store, config, outbox);
let stopping = false,
  busy = 0,
  posting = false,
  refreshing = false;
const jobTimer = setInterval(() => {
  if (busy >= (config.STT_PROVIDER === "soniox" ? config.SONIOX_CONCURRENCY : 1) || stopping) return;
  busy++;
  void (async () => {
    const job = await store.claimJob(owner, config.DISCORD_GUILD_ID);
    if (!job) return;
    let lost = false;
    const lease = setInterval(
      () =>
        void store
          .renewJob(job)
          .then((ok) => {
            lost = !ok;
          })
          .catch(() => {
            lost = true;
          }),
      15000,
    );
    try {
      await jobs.run(job);
      if (!lost) await store.finishJob(job);
    } catch (e) {
      const code = e instanceof DomainError || e instanceof ProviderError ? e.code : 'JOB_FAILED';
      const retryable =
        e instanceof ProviderError
          ? e.retryable
          : job.kind === 'FINALIZE' && e instanceof DomainError
            ? e.retryable
            : !(
                e instanceof DomainError &&
                [
                  'STALE_JOB',
                  'MEETING_NOT_FOUND',
                  'HUMAN_CORRECTION_CONFLICT',
                  'CONSENT_WITHDRAWN',
                  'RECOVERY_NO_TRANSCRIPT',
                  'SONIOX_SUBMISSION_UNCERTAIN',
                ].includes(e.code)
              );
      const retry = retryable && job.attempts < 3 ? Math.max(backoff(job.attempts), Number((e as any)?.retryAfterSeconds ?? 0) * 1000) : undefined;
      if (
        retry === undefined &&
        job.kind === 'FINALIZE' &&
        !['STALE_JOB', 'STALE_SUMMARY_OWNER', 'SUMMARY_RUN_BUSY'].includes(code)
      )
        await store.failSummaryJob(job, code).catch(() => {});
      await store.finishJob(job, code, retry);
    } finally {
      clearInterval(lease);
    }
  })()
    .catch(() => {})
    .finally(() => {
      busy--;
    });
}, 400);
const postTimer = setInterval(() => {
  if (posting || stopping) return;
  posting = true;
  void outbox
    .tick()
    .finally(() => {
      posting = false;
    })
    .catch(() => {});
}, 300);
const refreshTimer = setInterval(() => {
  if (refreshing || stopping) return;
  refreshing = true;
  void outbox
    .refresh()
    .finally(() => {
      refreshing = false;
    })
    .catch(() => {});
}, 3000);
const healthTimer = setInterval(
  () => void store.health('worker', owner, { busy }).catch(() => {}),
  10000,
);
const repairTimer = setInterval(() => void outbox.restoreDeletedCards().catch(() => {}), 30000);
const budgetTimer = setInterval(() => void checkBudgets(store).catch(() => {}), 10000);
const retentionTimer = setInterval(
  () =>
    void store
      .enqueue(
        store.db,
        'retention:' + new Date().toISOString().slice(0, 13),
        'RETENTION',
        null,
        {},
      )
      .catch(() => {}),
  60000,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    [
      jobTimer,
      postTimer,
      refreshTimer,
      healthTimer,
      retentionTimer,
      budgetTimer,
      repairTimer,
    ].forEach(clearInterval);
    const wait = setInterval(() => {
      if (!busy && !posting && !refreshing) {
        clearInterval(wait);
        void store.close();
      }
    }, 100);
  });
process.stdout.write(`Worker ready (${config.PROVIDER_MODE}).\n`);
