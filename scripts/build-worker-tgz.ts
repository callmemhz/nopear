// 预先打好 worker 安装包（镜像构建期用；运行时 SaaS 经 SAAS_WORKER_TGZ 直接下发）。
// 用法：tsx scripts/build-worker-tgz.ts <out.tgz>
import { resolve } from 'node:path';
import { buildWorkerTarball } from '../saas/src/install';

const out = process.argv[2];
if (!out) {
  console.error('usage: tsx scripts/build-worker-tgz.ts <out.tgz>');
  process.exit(1);
}
const repoRoot = resolve(import.meta.dirname, '..');
await buildWorkerTarball(repoRoot, resolve(out));
console.log(`worker.tgz → ${resolve(out)}`);
