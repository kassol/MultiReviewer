#!/usr/bin/env bash
#
# 在本机构建运行镜像并推到 registry。服务器那侧只需 `docker compose pull` 加
# `docker compose up -d`。
#
#   scripts/build-push.sh registry.example.com/team/multireviewer:latest
#
# 不带参数时读本机 `.env` 里的 MULTIREVIEWER_IMAGE。镜像地址属于部署环境,和凭据一样
# 留在不进版本库的 `.env` 里,不写死在脚本中。
#
# 每次推两个 tag:给的那一个(通常是 `:latest`),外加一个版本 tag `YYYY.MM.DD-N`(当天第 N
# 次发版,N 查 registry 里当天已有的 tag 递增)。前者给「拉最新的那一版」,后者给回滚——部署
# 目录的 `.env` 里 MULTIREVIEWER_IMAGE 写具体的版本 tag,回滚就是把那一行改回上一版再
# `docker compose up -d`,不必重新构建。版本 tag 看得出哪天发的、谁新谁旧;对应的提交写在
# 镜像的 `org.opencontainers.image.revision` label 上,要追代码时读它。
#
# 目标架构默认 linux/amd64。开发机是 arm64 而服务器是 amd64 时,漏掉这个平台参数
# 构建出的镜像在服务器上起不来,报的是 "exec format error"。服务器也是 arm64 时:
#
#   PLATFORM=linux/arm64 scripts/build-push.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${1:-}"
PLATFORM="${PLATFORM:-linux/amd64}"

if [[ -z "$IMAGE" && -f .env ]]; then
  IMAGE=$(grep -E '^MULTIREVIEWER_IMAGE=' .env | tail -n1 | cut -d= -f2- || true)
fi

if [[ -z "$IMAGE" ]]; then
  echo "用法: $0 <镜像引用>" >&2
  echo "或在 .env 里设 MULTIREVIEWER_IMAGE=<镜像引用>" >&2
  exit 1
fi

# 只在最后一段(镜像名)带冒号时才把它当 tag 切掉:`registry:5000/team/app` 那种端口里的
# 冒号不是 tag。
if [[ "${IMAGE##*/}" == *:* ]]; then REPO="${IMAGE%:*}"; else REPO="$IMAGE"; fi

# 版本 tag:当天日期加序号。序号从 1 起,registry 里已有(含 `-dirty` 那一份)就往上加;
# 查的是 registry 而不是本机记录,换一台开发机发版也接得上。只有 registry 明说 not found
# 才算这个号空着:网络或鉴权出错也当空号的话,会把已经发过的那一版覆盖掉,回滚点就没了。
tag_taken() {
  local out
  if out=$(docker buildx imagetools inspect "$1" 2>&1); then return 0; fi
  if [[ "$out" == *"not found"* ]]; then return 1; fi
  echo "查不了 registry 里有没有 $1:" >&2
  echo "$out" >&2
  exit 1
}
DAY=$(date +%Y.%m.%d)
N=1
while tag_taken "$REPO:$DAY-$N" || tag_taken "$REPO:$DAY-$N-dirty"; do
  N=$((N + 1))
done
VERSION="$DAY-$N"

# 对应的提交记进 label。工作区有改动时版本与 revision 都带 `-dirty`:这一份产物不等于任何
# 一个提交。不在 git 仓库里(只拿到源码包)时 revision 记 unknown。
SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
if [[ "$SHA" != unknown ]] && ! git diff --quiet HEAD 2>/dev/null; then
  SHA="$SHA-dirty"
  VERSION="$VERSION-dirty"
fi
VERSION_IMAGE="$REPO:$VERSION"

TAGS=(--tag "$IMAGE" --tag "$VERSION_IMAGE" --label "org.opencontainers.image.revision=$SHA" --label "org.opencontainers.image.version=$VERSION")
echo "构建 $IMAGE 与 $VERSION_IMAGE ($PLATFORM,提交 $SHA)"

# --push 而非 --load:buildx 构建非本机架构的镜像无法 load 进本地 daemon。
#
# --provenance=false:buildx 默认给镜像附一份 provenance attestation,它的配置 blob 是
# application/vnd.oci.empty.v1+json。阿里云 ACR 不认这个 media type,推送在最后一步失败,
# 报 "denied: unknown manifest class"——层都传完了才报,看起来像权限问题,其实不是。
docker buildx build --platform "$PLATFORM" --provenance=false "${TAGS[@]}" --push .

echo
echo "推送完成。服务器上更新:"
echo "  docker compose pull && docker compose up -d"
echo
echo "这一版是 ${VERSION}。部署目录 .env 的 MULTIREVIEWER_IMAGE 写成"
echo "  $VERSION_IMAGE"
echo "回滚时把那一行改回上一版的版本 tag,再 docker compose up -d。"
