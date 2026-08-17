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

echo "构建 $IMAGE ($PLATFORM)"
# --push 而非 --load:buildx 构建非本机架构的镜像无法 load 进本地 daemon。
#
# --provenance=false:buildx 默认给镜像附一份 provenance attestation,它的配置 blob 是
# application/vnd.oci.empty.v1+json。阿里云 ACR 不认这个 media type,推送在最后一步失败,
# 报 "denied: unknown manifest class"——层都传完了才报,看起来像权限问题,其实不是。
docker buildx build --platform "$PLATFORM" --provenance=false --tag "$IMAGE" --push .

echo
echo "推送完成。服务器上更新:"
echo "  docker compose pull && docker compose up -d"
