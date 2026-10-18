import { execFile } from 'node:child_process';
import { cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { sha256Hex } from '@nopear/core/crypto';
import type { SaasStore } from './store';

/** 新设备一键安装：install.sh 脚本 + worker 安装包。 */

const run = promisify(execFile);
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const TARBALL_PATHS = ['package-lock.json', 'packages/protocol', 'packages/core', 'worker'] as const;
const TARBALL_WORKSPACES = ['packages/protocol', 'packages/core', 'worker'];
/** 不论是否被 git 跟踪都不下发的路径段（安装包无需鉴权即可下载）。 */
const DENIED_NAMES = new Set(['node_modules', '.nopear', '.saas', '.DS_Store']);

/** 路径段是否属于禁止下发的文件/目录：.env / .env.*（.env.example 除外）、*.pem、*.key、*.log 等。 */
export function isDeniedName(name: string): boolean {
  if (DENIED_NAMES.has(name)) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  return /\.(pem|key|log)$/i.test(name);
}

function isDeniedPath(rel: string): boolean {
  return rel.split(/[\\/]/).some(isDeniedName);
}

/** git 跟踪的文件（相对 repoRoot）；git 不可用 / 不是仓库 / 没有跟踪文件时返回 null。 */
async function trackedFiles(repoRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', ['-C', repoRoot, 'ls-files', '-z', '--', ...TARBALL_PATHS], { maxBuffer: 64 * 1024 * 1024 });
    const files = stdout.split('\0').filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** bash 单引号字面量（任意内容安全嵌入）。 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function invalidInstallScript(message: string): string {
  return `#!/usr/bin/env bash
echo ${shq(`[nopear] ${message}`)} >&2
exit 1
`;
}

export function renderInstallScript(o: { saasUrl: string; code: string; piVersion: string; label: string | null }): string {
  // .env 里的 label 用双引号包裹；去掉会破坏该行的字符
  const label = o.label?.replace(/["\r\n\\]/g, '').trim() || null;
  const labelVar = label ? `  WORKER_LABEL=${shq(label)}\n` : '';
  const labelEnv = label ? `    printf 'NOPEAR_LABEL="%s"\\n' "$WORKER_LABEL"\n` : '';
  // 整个脚本包在 main() 里、末行才调用：curl | bash 中途断流时不会执行半截脚本
  return `#!/usr/bin/env bash
# nopear worker 一键安装（由 SaaS 生成；安装码一次性，注册时消耗）
set -eo pipefail

say() { printf '\\n[nopear] %s\\n' "$*"; }
die() { printf '[nopear] %s\\n' "$*" >&2; exit 1; }

# 让 systemd 用户服务在注销后/开机后无登录也常驻；失败只提示，不中断安装
enable_linger() {
  local u="\${USER:-$(id -un)}"
  if loginctl show-user "$u" -p Linger 2>/dev/null | grep -q '=yes'; then return 0; fi
  if loginctl enable-linger "$u" 2>/dev/null || sudo loginctl enable-linger "$u"; then
    say "已为 $u 开启 linger（无登录会话时 worker 也保持运行）"
  else
    say "未能开启 linger：worker 仅在你登录期间运行。可稍后手动执行：sudo loginctl enable-linger $u"
  fi
  return 0
}

main() {
  SAAS_URL=${shq(o.saasUrl)}
  INSTALL_CODE=${shq(o.code)}
${labelVar}  DEST="$HOME/.nopear-worker"

  # 1) 支持 macOS 与 Linux（WSL2 或原生）
  OS="$(uname -s)"
  case "$OS" in
    Darwin|Linux) ;;
    *) die "仅支持 macOS 和 Linux（含 WSL2），当前系统：$OS" ;;
  esac
  IS_WSL=0
  if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi

  # 2) Node >= 22.13，缺则用 nvm 装 Node 22（用户级，无需 sudo）
  node_ok() {
    command -v node >/dev/null 2>&1 &&
      node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
  }
  if ! node_ok; then
    say "安装 Node 22（nvm，用户级）"
    export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    set +e
    . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22 >/dev/null
    set -e
    node_ok || die "Node >= 22.13 安装失败"
  fi
  NODE_BIN="$(dirname "$(command -v node)")"
  NPM="$NODE_BIN/npm"
  export PATH="$NODE_BIN:$PATH"
  say "Node $(node -v)（\${NODE_BIN}）"

  # 3) git（macOS 自带的 git 只是触发 Xcode 命令行工具安装的占位程序：缺了就提示，不中断）
  if [ "$OS" = "Darwin" ]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      say "未安装 Xcode 命令行工具（git 等）。agent 用到 git 时需要：可稍后执行 xcode-select --install"
    fi
  elif ! command -v git >/dev/null 2>&1; then
    say "安装 git"
    sudo apt-get update
    sudo apt-get install -y git
  fi

  # 4) pi CLI（版本与 worker 依赖一致）；系统 Node 的全局目录（如 /usr）不可写时改用用户级前缀
  NPM_PREFIX="$("$NPM" prefix -g)"
  if [ ! -w "$NPM_PREFIX" ] || { [ -d "$NPM_PREFIX/lib/node_modules" ] && [ ! -w "$NPM_PREFIX/lib/node_modules" ]; }; then
    say "npm 全局目录 $NPM_PREFIX 不可写，改用 $HOME/.npm-global"
    mkdir -p "$HOME/.npm-global"
    "$NPM" config set prefix "$HOME/.npm-global"
    NPM_PREFIX="$HOME/.npm-global"
    RC="~/.bashrc"; [ "$OS" = "Darwin" ] && RC="~/.zshrc"
    say "请把 $HOME/.npm-global/bin 加入 PATH（如在 \${RC} 中写入 export PATH=\\"$HOME/.npm-global/bin:\\$PATH\\"）"
  fi
  NPM_GLOBAL_BIN="$NPM_PREFIX/bin"
  export PATH="$NPM_GLOBAL_BIN:$PATH"
  say "安装 pi ${o.piVersion}"
  "$NPM" i -g ${shq(`${PI_PACKAGE}@${o.piVersion}`)}

  # 5) 下载并解压 worker 安装包
  say "下载 worker 到 $DEST"
  mkdir -p "$DEST"
  # GNU tar 才认 --warning=no-unknown-keyword（静默旧包里的未知 PAX 关键字告警）；其它 tar 照常解压
  TAR_QUIET=""
  if tar --version 2>/dev/null | grep -q GNU; then TAR_QUIET="--warning=no-unknown-keyword"; fi
  curl -fsSL "$SAAS_URL/install/worker.tgz" | tar $TAR_QUIET -xzf - -C "$DEST"

  # 6) 安装依赖（需要根 devDependencies 里的 tsx，故不 --omit=dev；锁文件不精确匹配，故不用 npm ci）
  say "安装依赖"
  cd "$DEST"
  npm install -w @nopear/worker --include-workspace-root

  # 7) 写 worker/.env（首次启动用安装码自动认领）
  {
    printf 'NOPEAR_SAAS_URL=%s\\n' "$SAAS_URL"
    printf 'NOPEAR_INSTALL_CODE=%s\\n' "$INSTALL_CODE"
    # 安装时指定了数据目录就沿用（默认 ~/.nopear）
    if [ -n "\${NOPEAR_HOME:-}" ]; then printf 'NOPEAR_HOME=%s\\n' "$NOPEAR_HOME"; fi
${labelEnv}  } > "$DEST/worker/.env"
  chmod 600 "$DEST/worker/.env"

  # 8) 后台服务：macOS 用 launchd（登录后常驻），Linux 用 systemd 用户服务；都不可用时给出手动启动方式
  if [ "$OS" = "Darwin" ]; then
    LABEL="dev.nopear.worker"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    say "注册 launchd 服务 $LABEL"
    mkdir -p "$HOME/Library/LaunchAgents"
    # 退出码 78 = 注册被永久拒绝：包装成正常退出，launchd 就不再拉起（KeepAlive 只在非正常退出时重启）
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>"$NPM" start -w @nopear/worker; c=\\$?; [ \\$c -eq 78 ] &amp;&amp; exit 0; exit \\$c</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_BIN:$NPM_GLOBAL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DEST/worker.log</string>
  <key>StandardErrorPath</key><string>$DEST/worker.log</string>
</dict>
</plist>
PLIST
    # 重复运行安装脚本时先卸载旧服务，再加载新代码
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    say "worker 已启动并设为登录后自动运行（日志：tail -f \"$DEST/worker.log\"）"
    say "提示：Mac 睡眠时 worker 会离线。要一直可用，请在「系统设置 → 电池/能耗」里关闭自动睡眠，或保持接通电源。"
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    say "注册 systemd 用户服务 nopear-worker.service"
    mkdir -p "$HOME/.config/systemd/user"
    # RestartPreventExitStatus=78：worker 注册被永久拒绝时以 78 退出，不再无限重启
    cat > "$HOME/.config/systemd/user/nopear-worker.service" <<UNIT
[Unit]
Description=nopear worker

[Service]
Type=simple
WorkingDirectory=%h/.nopear-worker
Environment="PATH=$NODE_BIN:$NPM_GLOBAL_BIN:/usr/local/bin:/usr/bin:/bin"
ExecStart="$NPM" start -w @nopear/worker
Restart=always
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable nopear-worker
    # restart 而非 start：重复运行安装脚本时加载新代码
    systemctl --user restart nopear-worker
    enable_linger
    say "worker 已启动：systemctl --user status nopear-worker（日志：journalctl --user -u nopear-worker -f）"
  else
    say "systemd 用户服务不可用，请手动启动 worker："
    echo "  cd \\"$DEST\\" && nohup \\"$NPM\\" start -w @nopear/worker > \\"$DEST/worker.log\\" 2>&1 &"
    if [ "$IS_WSL" = "1" ]; then
      echo
      echo "  WSL 也可开启 systemd 来托管 worker：在 /etc/wsl.conf 中写入"
      echo "    [boot]"
      echo "    systemd=true"
      echo "  然后在 Windows 中执行 wsl --shutdown 并重新打开 WSL。"
    fi
  fi

  # 9) 模型登录
  say "最后一步：执行 pi 完成模型登录（或把已配置机器上的 ~/.pi/agent/models.json、auth.json 复制到本机 ~/.pi/agent/），然后重启 worker。"
}

main "$@"
`;
}

/** worker/package.json 中 pi SDK 依赖的版本（写进安装脚本）。 */
export function readPiVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'worker', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const v = pkg.dependencies?.[PI_PACKAGE];
  if (!v) throw new Error(`worker/package.json has no ${PI_PACKAGE} dependency`);
  return v;
}

/**
 * 按实际 tar 实现（`tar --version` 输出）选打包参数：bsdtar → 不带 xattr / mac 元数据；GNU tar → 不带 xattr；
 * 其它（busybox 等，或探测失败传空串）→ 不加额外参数（它们不认这些选项）。
 */
export function tarFlagsFor(version: string): string[] {
  if (/bsdtar|libarchive/i.test(version)) return ['--no-xattrs', '--no-mac-metadata'];
  if (/GNU tar/i.test(version)) return ['--no-xattrs'];
  return [];
}

let tarFlagsProbe: Promise<string[]> | null = null;

/** 探测一次 PATH 上的 tar（结果缓存）。 */
function tarFlags(): Promise<string[]> {
  tarFlagsProbe ??= run('tar', ['--version']).then(
    ({ stdout }) => tarFlagsFor(stdout),
    () => [],
  );
  return tarFlagsProbe;
}

/**
 * 打包 worker 需要的仓库子集并改写根 workspaces。优先只取 git 跟踪的文件（allowlist）；
 * git 不可用时退回目录复制。两种方式都再过一遍 deny 过滤（.env*、密钥、日志、node_modules 等）。
 */
export async function buildWorkerTarball(repoRoot: string, outFile: string): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), 'nopear-worker-stage-'));
  try {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    rootPkg.workspaces = TARBALL_WORKSPACES;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(rootPkg, null, 2)}\n`);
    const tracked = await trackedFiles(repoRoot);
    if (tracked) {
      for (const rel of tracked) {
        const src = join(repoRoot, rel);
        // 已跟踪但工作区里删掉的文件跳过
        if (isDeniedPath(rel) || !existsSync(src) || lstatSync(src).isDirectory()) continue;
        mkdirSync(dirname(join(stage, rel)), { recursive: true });
        cpSync(src, join(stage, rel));
      }
    } else {
      for (const p of TARBALL_PATHS) {
        cpSync(join(repoRoot, p), join(stage, p), { recursive: true, filter: (src) => !isDeniedName(basename(src)) });
      }
    }
    // 不带扩展属性 / mac 元数据：否则 macOS bsdtar 会写入 LIBARCHIVE.xattr.com.apple.provenance 等 PAX 头，
    // GNU tar 解压时逐条告警（COPYFILE_DISABLE 只挡 AppleDouble ._ 文件，挡不住 provenance xattr）。
    // 参数按实际 tar 实现选（不按平台）：macOS 上 PATH 里可能是 GNU tar，Linux 上可能是 busybox tar
    const flags = await tarFlags();
    await run('tar', [...flags, '-czf', outFile, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

/** 未配置 SAAS_PUBLIC_URL 时从请求推导对外地址（反向代理下取 X-Forwarded-Proto / X-Forwarded-Host）。 */
export function requestBaseUrl(protocol: string, headers: IncomingHttpHeaders): string {
  const fwdProto = firstHeader(headers['x-forwarded-proto'])?.toLowerCase();
  const proto = fwdProto === 'http' || fwdProto === 'https' ? fwdProto : protocol;
  const host = firstHeader(headers['x-forwarded-host']) ?? headers.host;
  return `${proto}://${host}`;
}

export function registerInstall(
  app: FastifyInstance,
  deps: { store: SaasStore; repoRoot: string; publicUrl: string | null; workerTgz: string | null },
): void {
  const piVersion = readPiVersion(deps.repoRoot);
  let tarball: string;
  let built: Promise<boolean>;
  if (deps.workerTgz) {
    // 预先打好的包（镜像内 SAAS_WORKER_TGZ）：直接下发，不现场打包、关闭时不删除
    tarball = deps.workerTgz;
    const ok = existsSync(tarball);
    if (!ok) console.error(`[nopear] SAAS_WORKER_TGZ not found: ${tarball}`);
    built = Promise.resolve(ok);
  } else {
    const outDir = mkdtempSync(join(tmpdir(), 'nopear-saas-install-'));
    tarball = join(outDir, 'worker.tgz');
    built = buildWorkerTarball(deps.repoRoot, tarball).then(
      () => true,
      (e: unknown) => {
        console.error('[nopear] failed to build worker.tgz', e);
        return false;
      },
    );
    app.addHook('onClose', async () => {
      await built;
      rmSync(outDir, { recursive: true, force: true });
    });
  }

  app.get('/install.sh', async (req, reply) => {
    reply.type('text/x-shellscript; charset=utf-8');
    const code = (req.query as { code?: unknown }).code;
    const row = typeof code === 'string' && code ? await deps.store.installCodes.get(sha256Hex(code)) : null;
    if (!row || row.usedBy !== null || row.expiresAt <= Date.now()) {
      return invalidInstallScript('安装码无效、已过期或已被使用，请在控制台重新生成安装命令。');
    }
    const saasUrl = (deps.publicUrl ?? requestBaseUrl(req.protocol, req.headers)).replace(/\/+$/, '');
    return renderInstallScript({ saasUrl, code: code as string, piVersion, label: row.label });
  });

  app.get('/install/worker.tgz', async (_req, reply) => {
    if (!(await built)) return reply.code(500).send({ error: { code: 'internal', message: 'worker package unavailable' } });
    return reply.type('application/gzip').send(createReadStream(tarball));
  });
}
