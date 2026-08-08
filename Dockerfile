# MultiReviewer 的运行镜像。
#
# 选 slim(Debian/glibc)而非 alpine:依赖树里带平台专属的预编译产物,musl 下的解析
# 没有验证过,而镜像大小在这里不值得拿正确性去换。
FROM node:24-slim

# 工作副本靠 git 命令准备(`src/git/worktree.ts` 直接 execFile "git"),基础镜像里没有
# 它。ca-certificates 是访问 Gitea 与各家模型 HTTPS 接口所需。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 版本钉死到产出 pnpm-lock.yaml 的那一个,免得 lockfile 版本对不上。
RUN npm install -g pnpm@11.12.0

WORKDIR /app

# 依赖层单独一层,只在依赖清单变化时才重装。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# 源码由 Node 直接运行,无构建步骤,拷进去就能跑。
COPY src ./src

# 数据落这两处,compose 把宿主机目录绑上来。配置文件同样由 compose 绑入。
ENV MULTIREVIEWER_DB=/data/multireviewer.db \
    MULTIREVIEWER_CACHE_DIR=/data/worktrees \
    MULTIREVIEWER_CONFIG=/app/multireviewer.config.json \
    MULTIREVIEWER_PORT=3000

# 容器内固定监听 3000,对外映射哪个端口由 compose 决定。
EXPOSE 3000

# 审查读的是半可信的 PR 代码,不用 root 跑。node 镜像自带这个用户,uid/gid 都是 1000。
# compose 会用 `user:` 覆盖成宿主机上那个部署用户的 uid,绑进来的目录因此天然可写。
# 实测在没有 passwd 条目的 uid 下照常工作:HOME 落到 /,而本服务不写 HOME。
USER node

CMD ["node", "src/main.ts"]
