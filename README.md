# NoPear

在手机或浏览器上，远程给你自己机器上的 coding agent 派任务，实时看它输出、随时插话。

- **会话**：在任意一台已接入的机器上开会话（选工作目录、模型、思考档位），流式看回复、工具调用、思考过程；可中断、回退、分叉、排队插话，能发图片和文件。
- **看板**：卡片拖到哪台机器的「待开始」列，那台机器就以卡片内容开一个会话去做，做完进「待验收」，人工确认后完成。
- **协作记忆**：账号级的「全局记忆」和每个项目的「项目记忆」，会注入到带项目标签的会话里，agent 也能读写。
- **跨机器工具**：agent 可以查别的机器的会话、在别的机器上开会话（同一套工具也通过 MCP 暴露给 Claude Code、Cursor 等客户端）。
- **端到端加密（可选）**：开启后客户端和机器之间的数据只有两端能解密，中转服务器只看到密文。

Agent 运行时基于 [pi](https://github.com/earendil-works/pi-mono)（`@earendil-works/pi-coding-agent`），用你自己机器上的 pi 模型配置。

> 界面目前只有中文。

## 架构

```
web / mobile ──HTTPS（RPC + SSE）──▶ saas ◀──WebSocket 隧道（worker 主动拨出）── worker（你的机器，跑 pi）
```

- **saas**：账号登录、机器目录与认领、数据面中转、协作数据（项目、卡片、记忆、会话索引）、MCP 端点、静态托管 web。Fastify + SQLite。
- **worker**：跑在每台要被远程使用的机器上，负责会话宿主和卡片执行。**只往外拨出，不监听任何端口**，所以放在 NAT 或防火墙后面也能用。
- **web**：浏览器控制台，Vite + React + Tailwind，生产环境由 saas 托管。
- **mobile**：iOS/Android 客户端，Expo + React Native。

一个账号可以接多台机器，客户端会把所有机器的会话合在一起展示。

### 仓库结构

npm workspaces 单仓，全部 TypeScript，用 `tsx` 直接运行源码，不产出构建产物。

| 目录 | 说明 |
|---|---|
| `packages/protocol` | 所有类型、RPC、事件、隧道帧的**唯一事实源**。改接口先改这里，再改各端 |
| `packages/core` | 客户端共享核心：E2E 加密、SaaS 客户端、同步引擎、本地缓存（web 和 mobile 共用） |
| `saas/` | 服务端 |
| `worker/` | 机器端（`src/agent/` 会话宿主，`src/collab/` 看板执行与协作工具） |
| `web/` | 浏览器控制台 |
| `mobile/` | 移动端（`ios/`、`android/` 不进仓库，按需 `expo prebuild` 生成） |
| `scripts/` | `e2e.ts` 全链路测试；`build-worker-tgz.ts` 预打 worker 安装包 |

## ⚠️ 安全须知（务必先读）

- **worker 会直接执行 agent 的所有工具调用**（bash、编辑、写文件），没有逐条审批。能用你账号授权的任何客户端，就等于能在这台机器上执行任意代码。**只在你信任的机器、隔离环境或沙箱里运行 worker。**
- **文件浏览不做沙箱限制**：按会话工作目录解析，但可以用 `..` 或绝对路径访问到别处。这是有意的，因为授权客户端本来就能通过会话执行任意代码。
- **E2E 的信任前提是服务端诚实**。E2E 是账号级开关，由 saas 下发；被攻破的 saas 可以签发假的客户端授权，或者把 worker 切回明文。只有在 worker 上设 `NOPEAR_E2E=required` 才能硬性保证这台机器只收密文。协作数据（项目、卡片、记忆、会话标题和预览）**始终以明文**存在 saas。
- **卡片派发不受 E2E 影响**：任何持有 MCP token 的客户端，或任何 agent 会话（包括被提示词注入的），都可以建卡并把卡移到某台机器的「待开始」列，让那台机器执行任意提示词。开 E2E 或设 `NOPEAR_E2E=required` 都拦不住这条路。妥善保管登录态和 MCP token，不用就删。
- **协作记忆会注入所有带项目标签的会话**，agent 也能改写。一旦记忆被写入恶意指令，会在所有机器上持续生效，要定期检查。

## 快速开始（本地）

需要 **Node ≥ 22.13**（saas 用内置的 `node:sqlite`）。worker 所在机器要先配好 pi：`~/.pi/agent/models.json` 和 `~/.pi/agent/auth.json`。后台子任务还需要 `pi` CLI 在 `PATH` 上。

```bash
npm install

# 1. 启动 saas（开发登录：输入邮箱即可登录）
SAAS_DEV_LOGIN=1 npm start -w @nopear/saas          # http://localhost:8790

# 2. 构建 web，由 saas 托管
npm run build -w @nopear/web

# 3. 在要被远程使用的机器上启动 worker
NOPEAR_SAAS_URL=http://localhost:8790 npm start -w @nopear/worker
```

worker 第一次启动时会打印一条**认领链接**和终端二维码（10 分钟内有效）。在已登录的浏览器里打开链接、点确认，这台机器就归到你的账号下了。之后重启不用再认领。

开发 web 时可以用 Vite 热更新：`npm run dev -w @nopear/web`（`/api` 和 `/worker` 会代理到 `localhost:8790`，其他地址用 `SAAS_PROXY=...` 指定）。

### 导入本地 pi 会话

```bash
npm run import-pi -w @nopear/worker -- --dry-run   # 先看会导入哪些
npm run import-pi -w @nopear/worker                # 从 ~/.pi/agent/sessions 复制过来（源文件不动）
```

导入前先停掉这台机器上的 worker。

## 配置

saas 和 worker 都会读取各自目录下的 `.env`（参考 `saas/.env.example`、`worker/.env.example`）。**密钥不要放进仓库。**

### saas

| 变量 | 默认 | 说明 |
|---|---|---|
| `SAAS_PORT` | `8790` | 监听端口 |
| `SAAS_PUBLIC_URL` | 请求来源 | 对外地址：认领链接、OAuth 回跳、安装命令都用它 |
| `SAAS_DATA_DIR` | `./.saas` | SQLite 和自动生成的密钥存放目录 |
| `SAAS_SIGNING_KEY` | 自动生成 | 平台 Ed25519 签名密钥。**所有 worker 都会固定这把公钥，丢了要全部重新接入，务必备份** |
| `SAAS_SESSION_SECRET` | 自动生成 | 登录会话密钥 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 无 | Google 登录 |
| `SAAS_DEV_LOGIN` | `0` | `1` 开启「输入邮箱即登录」，**只用于本地开发** |
| `SAAS_BOOTSTRAP_TOKEN` | 无 | 设了之后，注册 worker 必须带同样的 token |
| `SAAS_BOOTSTRAP_ADMIN` | 无 | 登录白名单为空时，启动即把这个邮箱设为管理员 |
| `SAAS_REDIRECT_ALLOWLIST` | `nopear://` | 移动端 OAuth 回跳地址白名单 |
| `SAAS_BODY_LIMIT_MB` | `64` | 请求体上限 |
| `SAAS_WEB_DIR` | `../web/dist` | 托管的 web 构建产物 |
| `SAAS_WORKER_TGZ` | 无 | 预打好的 worker 安装包（Docker 镜像里已设） |

**登录白名单**：名单为空时任何人都能登录（启动时会打印警告）。在 web「设置 → 成员」里启用后，只有名单内的邮箱能登录。

### worker

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOPEAR_SAAS_URL` | 必填 | saas 地址 |
| `NOPEAR_HOME` | `~/.nopear` | 身份、会话、文件缓存目录 |
| `NOPEAR_LABEL` | 主机名 | 控制台里显示的机器名 |
| `NOPEAR_DEFAULT_CWD` | `$HOME` | 新会话的默认工作目录 |
| `NOPEAR_DEFAULT_MODEL` | 第一个可用模型 | `provider/modelId`，来自 pi 的 `models.json` |
| `NOPEAR_DEFAULT_THINKING` | `medium` | 默认思考档位 |
| `NOPEAR_PI_AUTH` / `NOPEAR_PI_MODELS` | `~/.pi/agent/…` | pi 的凭据和模型配置 |
| `NOPEAR_PERSONA` | `Claude Code` | agent 在系统提示词里的自称 |
| `NOPEAR_E2E` | `auto` | `auto` 跟随账号 E2E 开关；`required` 只收密文 |
| `NOPEAR_CARD_WIP` | `1` | 这台机器同时执行的卡片数上限 |
| `NOPEAR_IDLE_DISPOSE_MS` | `600000` | 空闲会话从内存释放的时间 |
| `NOPEAR_ASK_TIMEOUT_MS` | `0` | agent 提问的等待超时（`0` 为一直等） |
| `NOPEAR_DNS_ORDER` | `ipv4first` | 出站 DNS 顺序。IPv6 出口不稳时隧道会被静默掐断，默认优先 IPv4；纯 IPv6 主机设 `verbatim` |
| `NOPEAR_SAAS_BOOTSTRAP_TOKEN` | 无 | 对应 saas 的 `SAAS_BOOTSTRAP_TOKEN` |

账号级设置在 web「设置」页里改：端到端加密开关、**自动压缩上下文**（默认上下文到 300k tokens 时把较早内容压成摘要，避免超过模型上限整轮被拒）、个人 API token。

## 部署

### Docker

```bash
docker buildx build --platform linux/amd64 -t nopear-saas:latest .
docker run -d -p 8790:8790 -v nopear-data:/data \
  -e SAAS_PUBLIC_URL=https://nopear.example.com \
  -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  nopear-saas:latest
```

镜像里已经包含 web 构建产物和 worker 安装包。前面需要一层终止 TLS 的反向代理，并且要放行 WebSocket（`/worker/connect`）和 SSE（不要缓冲）。数据都在 `/data`，务必挂载持久卷；SQLite 只允许单实例，不要同时跑两个容器。

### 新机器一键安装（Linux / WSL2）

在 web「机器 → 添加机器」里生成一条命令（安装码一次性，30 分钟内有效）：

```bash
curl -fsSL 'https://nopear.example.com/install.sh?code=…' | bash
```

脚本会按需安装 Node 和 pi CLI，下载 worker 到 `~/.nopear-worker`，注册成 systemd 用户服务，并自动认领到生成命令的账号。**模型凭据不会自动复制**：装完后在新机器上登录 pi，或者把 `models.json`、`auth.json` 拷到 `~/.pi/agent/`，再重启 worker。

macOS 和原生 Windows 没有一键安装，按上面「快速开始」手动启动 worker。

## 移动端

```bash
cd mobile
npx expo start                                    # Expo Go / 模拟器
NOPEAR_SAAS_URL=https://nopear.example.com \
NOPEAR_IOS_BUNDLE_ID=com.you.nopear \
NOPEAR_APPLE_TEAM_ID=XXXXXXXXXX \
npx expo run:ios --device                          # 真机构建
```

登录页可以改 SaaS 地址，`NOPEAR_SAAS_URL` 只是默认值。URL scheme 是 `nopear://`（OAuth 回跳和认领深链）。Google 登录需要 dev build（Expo Go 不注册自定义 scheme）。

## MCP

saas 的 `POST /mcp` 是一个无状态的 MCP（Streamable HTTP）端点，提供项目、卡片、记忆、机器、会话这些工具。在 web「设置 → 个人 API token」里生成 token（只显示一次，只能访问 `/mcp`），然后配置到客户端：

```json
{
  "mcpServers": {
    "nopear": {
      "type": "http",
      "url": "https://nopear.example.com/mcp",
      "headers": { "Authorization": "Bearer <你的 token>" }
    }
  }
}
```

## 开发

```bash
npm run typecheck          # 所有 workspace 的类型检查
npm test                   # 所有单测（core/web/mobile 用 vitest，saas/worker 用 node:test）
npm run e2e                # 全链路：真 saas + 真 worker + 假模型，最后打印 "E2E OK"
npm run build -w @nopear/web
cd mobile && npx expo export
```

**改协议的规矩**：类型、RPC、事件、帧都定义在 `packages/protocol/src/index.ts`。任何一端要改字段或接口，先改这里，再同步改 saas、worker、core、web、mobile。

## License

[MIT](LICENSE)
