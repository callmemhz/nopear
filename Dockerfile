# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
# 全部工作区的 package.json 都要在：npm ci 按整份锁文件校验
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY saas/package.json saas/
COPY worker/package.json worker/
COPY web/package.json web/
COPY mobile/package.json mobile/
RUN npm ci --workspace=@nopear/saas --workspace=@nopear/web --include-workspace-root --no-audit --no-fund
COPY . .
RUN npm run build -w @nopear/web
# 镜像内没有 git：buildWorkerTarball 走目录复制 + isDeniedName 过滤分支
RUN node --import tsx scripts/build-worker-tgz.ts /app/worker.tgz

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/saas ./saas
COPY --from=build /app/web/dist ./web/dist
# registerInstall 的 readPiVersion 读 worker/package.json（repoRoot = saas/src/../.. = /app）
COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/worker.tgz ./worker.tgz
RUN mkdir -p /data && chown node:node /data
USER node
ENV SAAS_PORT=8790 SAAS_DATA_DIR=/data SAAS_WEB_DIR=/app/web/dist SAAS_WORKER_TGZ=/app/worker.tgz
WORKDIR /app/saas
EXPOSE 8790
# node 直接做 PID 1（不经 npm），SIGTERM 由 main.ts 的 shutdown 处理
CMD ["node", "--import", "tsx", "src/main.ts"]
