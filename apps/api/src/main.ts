import { loadConfig } from '@meeting/providers';
import { Store } from '@meeting/db';
import { buildServer } from './server.ts';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
const app = await buildServer(config, store);
await app.listen({ host: '0.0.0.0', port: config.API_PORT });
const timer = setInterval(
  () => void store.health('api', String(process.pid), {}).catch(() => {}),
  10000,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    void app.close().then(() => store.close());
  });
