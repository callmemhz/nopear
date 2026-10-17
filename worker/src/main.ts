// @nopear/worker entry: pi session host + sync log, reachable only through the SaaS tunnel
// (no listening port). Boot order: config → identity → models → meta → collab hooks →
// host → gateway → tunnel → collab attach (tools/memory/auto-tag/index/card executor). Unclaimed workers
// print a one-time claim link + terminal QR.
import { setDefaultResultOrder } from 'node:dns';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config';
import { loadOrCreateIdentity } from './identity';
import { createModelRuntime } from './agent/models';
import { MetaStore } from './agent/meta-store';
import { BlobStore } from './agent/blobs';
import { createSendFileTool } from './agent/send-file';
import { SessionHost } from './agent/host';
import { createOps } from './ops';
import { Gateway } from './gateway';
import { PlatformKeyMismatchError, RegisterRejectedError, TunnelClient } from './tunnel';
import { createCollab } from './collab/index';

/** EX_CONFIG (sysexits.h): permanent registration failure (rejected register, pinned platform key mismatch).
 *  The systemd unit sets RestartPreventExitStatus=78 so it is not restarted in a loop. */
const EXIT_CONFIG = 78;
const isPermanent = (err: unknown): err is Error =>
  err instanceof RegisterRejectedError || err instanceof PlatformKeyMismatchError;

async function main(): Promise<void> {
  const config = loadConfig();
  // Before any socket is opened: a flaky IPv6 path to the SaaS edge silently kills the tunnel (close 1006).
  setDefaultResultOrder(config.dnsOrder);
  const identity = loadOrCreateIdentity(config.home, config.saasUrl);
  // createModelRuntime registers the scripted faux provider (model faux/echo) when NOPEAR_TEST_FAUX=1.
  const models = await createModelRuntime(config);
  const meta = new MetaStore(join(config.home, 'sessions.json'));
  await meta.load();
  const blobs = new BlobStore(config.blobsDir);

  // Hooks resolve the tunnel lazily: sessions built before attach just see SaaS as unreachable.
  const collab = createCollab({ config, workerId: identity.workerId });
  const host = new SessionHost({ config, meta, blobs, models, workerId: identity.workerId, ...collab.hooks,
    extraTools: (m) => [...collab.hooks.extraTools(m), createSendFileTool({ cwd: m.cwd, blobs })] });
  await host.init();

  const { ops, watches } = createOps({ config, host, blobs });
  const gateway = new Gateway({ identity, ops, watches, e2eMode: config.e2e });
  const tunnel = new TunnelClient({
    config, identity, gateway,
    // Account auto-compaction rides on every authz push; unclaimed (no settings) falls back to the defaults.
    onAuthz: (f) => host.setAutoCompact(f.claimed ? f.autoCompact : undefined),
    onClaimLink: (url) => {
      console.log('\n[nopear] 本机尚未认领。登录 SaaS 后打开下面的链接（或扫码）认领这台机器（10 分钟内有效）：');
      console.log(url);
      qrcode.generate(url, { small: true }, (qr) => console.log(qr));
    },
    onState: (s) => console.log(`[nopear] tunnel ${s}`),
    onFatal: (err) => {
      console.error(`[nopear] fatal: ${err.message}`);
      void shutdown('fatal', isPermanent(err) ? EXIT_CONFIG : 1);
    },
  });
  const detach = collab.attach(tunnel, host);

  let closing = false;
  const shutdown = async (sig: string, code = 0) => {
    if (closing) return;
    closing = true;
    console.log(`[nopear] ${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      detach();
      await tunnel.stop();
      await host.shutdown();
    } catch (err) {
      console.warn(`[nopear] shutdown error: ${(err as Error)?.message ?? err}`);
    }
    process.exit(code);
  };
  // Install before tunnel.start(): first-boot register may retry for a long time while SaaS is down.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`[nopear] worker ${identity.workerId} (${config.label}) → ${config.saasUrl}`);
  console.log(`[nopear] home=${config.home} defaultModel=${config.defaultModel} defaultCwd=${config.defaultCwd}`);
  try {
    await tunnel.start();
  } catch (err) {
    // Permanent register rejection (bad bootstrap token / install code, 409 conflict, platform key mismatch):
    // retrying can't help — exit EX_CONFIG so systemd does not restart-loop.
    if (!isPermanent(err)) throw err;
    console.error(`[nopear] fatal: ${err.message}`);
    closing = true;
    detach();
    await host.shutdown().catch(() => {});
    process.exit(EXIT_CONFIG);
  }
}

// Defense in depth: a stray background rejection is logged, never fatal (Node would otherwise exit the worker).
// Log the error object only — never request/config payloads (secrets).
process.on('unhandledRejection', (e) => console.error('[nopear] unhandled rejection', e));

main().catch((err: unknown) => {
  console.error(`[nopear] fatal: ${(err as Error)?.stack ?? err}`);
  process.exit(1);
});
