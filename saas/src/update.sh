#!/usr/bin/env bash
# nopear worker 更新（SaaS 在 /update.sh 下发，占位符按请求填好）。
#   curl -fsSL <SaaS>/update.sh | bash              update; the worker restarts once no session is working
#   curl -fsSL <SaaS>/update.sh | bash -s -- --now  update and restart right away (interrupts running sessions)
# Keeps worker/.env, the worker identity and all sessions; only the code and its dependencies change.
# worker 自己（控制台「更新」）带 --from-worker 运行：只准备好新代码（~/.nopear-worker.new），
# worker 等会话空闲后自己换目录并重启。
set -eo pipefail

say() { printf '\n[nopear] %s\n' "$*"; }
die() { printf '[nopear] %s\n' "$*" >&2; exit 1; }

main() {
  SAAS_URL=__NOPEAR_SAAS_URL__
  PI_SPEC=__NOPEAR_PI_SPEC__
  DEST="$HOME/.nopear-worker"
  FROM_WORKER=0
  NOW=0
  for a in "$@"; do
    case "$a" in
      --from-worker) FROM_WORKER=1 ;;
      --now) NOW=1 ;;
      *) die "未知参数：${a}" ;;
    esac
  done
  OS="$(uname -s)"

  [ -f "$DEST/worker/.env" ] || die "没有找到一键安装的 worker（${DEST}/worker/.env 不存在）。请在控制台「机器 → 添加机器」生成安装命令来安装。"

  # Node (same rule as the installer): PATH first, then nvm
  node_ok() {
    command -v node >/dev/null 2>&1 &&
      node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
  }
  if ! node_ok; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      set +e
      . "$NVM_DIR/nvm.sh"
      nvm use 22 >/dev/null 2>&1
      set -e
    fi
  fi
  node_ok || die "找不到 Node >= 22.13，请在控制台重新生成安装命令运行一次。"
  NODE_BIN="$(dirname "$(command -v node)")"
  NPM="$NODE_BIN/npm"
  export PATH="$NODE_BIN:$PATH"

  # 1) new code next to the old one; the running worker keeps using the old directory until it restarts
  NEW="$DEST.new"
  rm -rf "$NEW"
  mkdir -p "$NEW"
  say "下载新版 worker"
  TAR_QUIET=""
  if tar --version 2>/dev/null | grep -q GNU; then TAR_QUIET="--warning=no-unknown-keyword"; fi
  curl -fsSL "$SAAS_URL/install/worker.tgz" | tar $TAR_QUIET -xzf - -C "$NEW"
  cp -p "$DEST/worker/.env" "$NEW/worker/.env"
  # start from the current dependencies so npm only fetches what changed
  if [ -d "$DEST/node_modules" ]; then cp -R "$DEST/node_modules" "$NEW/node_modules"; fi
  say "安装依赖"
  ( cd "$NEW" && "$NPM" install -w @nopear/worker --include-workspace-root --no-audit --no-fund )

  # 2) pi CLI (background subagents) follows the worker's pi SDK version
  WANT="${PI_SPEC##*@}"
  HAVE="$(pi --version 2>/dev/null | tail -1 || true)"
  if [ "$HAVE" != "$WANT" ]; then
    say "更新 pi CLI：${HAVE:-未安装} → ${WANT}"
    "$NPM" i -g "$PI_SPEC" || say "pi CLI 更新失败（后台子任务继续用旧版），可稍后手动执行：${NPM} i -g ${PI_SPEC}"
  fi

  # 3) 换上新代码：worker 还在跑时不动它的目录（它会懒加载模块），交给 worker 退出重启前自己换
  swap() {
    rm -rf "$DEST.old"
    mv "$DEST" "$DEST.old"
    mv "$NEW" "$DEST"
    if [ -f "$DEST.old/worker.log" ]; then mv "$DEST.old/worker.log" "$DEST/worker.log"; fi
  }
  BUILD="$(sed -n 's/.*"build" *: *"\([^"]*\)".*/\1/p' "$NEW/nopear-build.json" 2>/dev/null || true)"
  say "新代码已就位（构建 ${BUILD:-未知}）"
  if [ "$FROM_WORKER" = "1" ]; then exit 0; fi

  # 4) 重启：worker 在跑且由系统服务托管 → 发 SIGUSR2，它等会话都空闲后自己换代码并重启；--now 立即换并重启
  HOME_DIR="$(sed -n 's/^NOPEAR_HOME=//p' "$DEST/worker/.env" | tail -1 | tr -d '"')"
  [ -n "$HOME_DIR" ] || HOME_DIR="$HOME/.nopear"
  PID="$(cat "$HOME_DIR/worker.pid" 2>/dev/null || true)"
  RUNNING=0
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then RUNNING=1; fi
  SERVICE=""
  if [ "$OS" = "Darwin" ] && launchctl print "gui/$(id -u)/dev.nopear.worker" >/dev/null 2>&1; then SERVICE=launchd
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user cat nopear-worker >/dev/null 2>&1; then SERVICE=systemd
  fi
  restart_service() {
    case "$SERVICE" in
      launchd) launchctl kickstart -k "gui/$(id -u)/dev.nopear.worker" ;;
      systemd) systemctl --user restart nopear-worker ;;
    esac
  }
  if [ "$RUNNING" = "1" ] && [ -n "$SERVICE" ] && [ "$NOW" = "0" ]; then
    kill -USR2 "$PID"
    say "等所有会话都空闲后，worker 会自动换上新代码并重启（想立即重启：加 --now 再运行一次，会打断正在跑的会话）。"
  elif [ -n "$SERVICE" ]; then
    swap
    restart_service
    say "worker 已重启，用上新代码了。"
  else
    swap
    if [ "$RUNNING" = "1" ]; then kill "$PID" 2>/dev/null || true; fi
    say "worker 不是以系统服务方式运行的，请手动启动以加载新代码："
    echo "  cd \"${DEST}\" && nohup \"${NPM}\" start -w @nopear/worker > \"${DEST}/worker.log\" 2>&1 &"
  fi
}

main "$@"
