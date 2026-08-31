# MultiReviewer 的运行镜像。
#
# 选 slim(Debian/glibc)而非 alpine:依赖树里带平台专属的预编译产物,musl 下的解析
# 没有验证过,而镜像大小在这里不值得拿正确性去换。

# ── 前端构建阶段 ──────────────────────────────────────────────────────────
# 产物是纯静态文件,Vite 与 React 全套只活在这一层,不进运行镜像。dist 不进版本库,
# 每次构建镜像时在这里生成。
FROM node:24-slim AS webbuild
RUN npm install -g pnpm@11.21.0 \
 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @multireviewer/web
COPY web ./web
RUN pnpm --filter @multireviewer/web build \
 && rm -rf "$(pnpm store path)" /root/.cache /root/.npm

# ── 运行镜像 ─────────────────────────────────────────────────────────────
FROM node:24-slim

# 工作副本靠 git 命令准备(`src/git/worktree.ts` 直接 execFile "git"),基础镜像里没有
# 它。ca-certificates 是访问 Gitea 与各家模型 HTTPS 接口所需。
#
# ripgrep 与 fd-find 供 Reviewer 的 grep / find 工具用。缺了这两个二进制,Pi 会先去
# GitHub 下载,容器里下不动就各卡满 120 秒的超时再报 could not be downloaded,一轮
# Review Run 白等约 4 分钟。Debian 的 fd 装出来叫 `fdfind`,Pi 的工具查找按
# ["fd", "fdfind"] 两个名字依次探测(pi-coding-agent 的 utils/tools-manager.js),
# 命中 `fdfind` 就直接拿它 spawn,不用另做 `fd` 软链。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep fd-find \
 && rm -rf /var/lib/apt/lists/*

# 版本钉死到产出 pnpm-lock.yaml 的那一个,免得 lockfile 版本对不上。
RUN npm install -g pnpm@11.21.0 \
 && npm cache clean --force

WORKDIR /app

# 依赖层单独一层,只在依赖清单变化时才重装。web 的 package.json 要在场让 workspace
# 解析得开,--filter 限定只装服务端的运行时依赖——react 全家不进运行镜像。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --prod --frozen-lockfile --filter multireviewer \
 && rm -rf "$(pnpm store path)" /root/.cache /root/.npm

# 源码由 Node 直接运行,无构建步骤,拷进去就能跑。前端只要构建产物。
COPY src ./src
COPY --from=webbuild /app/web/dist ./web/dist

# 数据落这两处,compose 把宿主机目录绑上来。
ENV MULTIREVIEWER_DB=/data/multireviewer.db \
    MULTIREVIEWER_CACHE_DIR=/data/worktrees \
    MULTIREVIEWER_PANEL_DIST=/app/web/dist \
    MULTIREVIEWER_PORT=3000

# 容器内固定监听 3000,对外映射哪个端口由 compose 决定。
EXPOSE 3000

# 审查读的是半可信的 PR 代码,不用 root 跑。node 镜像自带这个用户,uid/gid 都是 1000。
# compose 会用 `user:` 覆盖成宿主机上那个部署用户的 uid,绑进来的目录因此天然可写。
# 实测在没有 passwd 条目的 uid 下照常工作:HOME 落到 /,而本服务不写 HOME。
USER node

CMD ["node", "src/main.ts"]
