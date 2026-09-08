import { Store } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
import { Outbox } from '../apps/worker/src/outbox.ts';
import { Jobs } from '../apps/worker/src/jobs.ts';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
try {
  await new Jobs(store, config, new Outbox(store, config, 'retention-cli')).retention();
  process.stdout.write('Retention sweep completed.\n');
} finally {
  await store.close();
}
