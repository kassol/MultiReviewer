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
# 每次推两个 tag:给的那一个(通常是 `:latest`),外加当前提交的短 sha。前者给「拉最新的
# 那一版」,后者给回滚——部署目录的 `.env` 里 MULTIREVIEWER_IMAGE 写具体的 sha tag,回滚
# 就是把那一行改回上一个 sha 再 `docker compose up -d`,不必重新构建。
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

# 回滚用的那个 tag:当前提交的短 sha。工作区有改动时带上 `-dirty`,免得一个 sha 指向两份
# 不一样的产物。不在 git 仓库里(只拿到源码包)时只推给定的那一个 tag。
SHA=$(git rev-parse --short HEAD 2>/dev/null || true)
if [[ -n "$SHA" ]] && ! git diff --quiet HEAD 2>/dev/null; then
  SHA="$SHA-dirty"
fi

TAGS=(--tag "$IMAGE")
if [[ -n "$SHA" ]]; then
  # 只在最后一段(镜像名)带冒号时才把它当 tag 切掉:`registry:5000/team/app` 那种端口
  # 里的冒号不是 tag。
  if [[ "${IMAGE##*/}" == *:* ]]; then SHA_IMAGE="${IMAGE%:*}:$SHA"; else SHA_IMAGE="$IMAGE:$SHA"; fi
  TAGS+=(--tag "$SHA_IMAGE")
  echo "构建 $IMAGE 与 $SHA_IMAGE ($PLATFORM)"
else
  echo "构建 $IMAGE ($PLATFORM;不在 git 仓库里,不推 sha tag)"
fi

# --push 而非 --load:buildx 构建非本机架构的镜像无法 load 进本地 daemon。
#
# --provenance=false:buildx 默认给镜像附一份 provenance attestation,它的配置 blob 是
# application/vnd.oci.empty.v1+json。阿里云 ACR 不认这个 media type,推送在最后一步失败,
# 报 "denied: unknown manifest class"——层都传完了才报,看起来像权限问题,其实不是。
docker buildx build --platform "$PLATFORM" --provenance=false "${TAGS[@]}" --push .

echo
echo "推送完成。服务器上更新:"
echo "  docker compose pull && docker compose up -d"
if [[ -n "$SHA" ]]; then
  echo
  echo "这一版的回滚点:把部署目录 .env 的 MULTIREVIEWER_IMAGE 写成"
  echo "  $SHA_IMAGE"
  echo "再 docker compose up -d 即可换回这一版。"
fi
