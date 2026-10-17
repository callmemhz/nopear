import { loadSaasConfig } from './config';
import { buildServer } from './server';
import { openStore } from './store';

const config = loadSaasConfig();
const store = await openStore(config.db);
const app = await buildServer({ config, store });
await app.listen({ port: config.port, host: '0.0.0.0' });
const addr = app.server.address();
const port = typeof addr === 'object' && addr ? addr.port : config.port;
console.log(`nopear saas listening on :${port} (public ${config.publicUrl}, dev login ${config.devLogin ? 'on' : 'off'})`);
if ((await store.allowlist.count()) === 0) console.warn('[nopear] 登录白名单未启用，任何能访问本服务的人都可登录');

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  // Last resort: never hang on shutdown.
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await app.close();
    await store.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
