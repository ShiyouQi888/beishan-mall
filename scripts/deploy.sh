#!/bin/bash
# 一键部署：构建镜像 → 自动沿用原容器的端口与挂载重建。
#
# 为什么需要它：Docker 容器创建时就把镜像 ID 钉死了，之后 build 出新镜像
# 容器也不会变（重启无效），必须删掉重建。手敲 docker run 时最容易错的是
# -v 挂载路径和 -p 端口 —— 写错就等于换了个空数据库。
# 这个脚本直接从旧容器里读这两项，不给人填错的机会。
#
# 用法:
#   bash scripts/deploy.sh beishan-mall fixikang      # 重建指定容器
#   bash scripts/deploy.sh --dry-run beishan-mall     # 只看会执行什么
#
# 环境变量:
#   IMAGE=beishan-mall:latest   镜像名（默认）
#   CONTAINER_PORT=3300         容器内端口（默认 3300）
#   SKIP_BUILD=1                跳过构建，只用现有镜像重建

set -euo pipefail

IMAGE="${IMAGE:-beishan-mall:latest}"
CONTAINER_PORT="${CONTAINER_PORT:-3300}"
DRY_RUN=0
NAMES=()

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "未知参数：$arg" >&2; exit 1 ;;
    *) NAMES+=("$arg") ;;
  esac
done

if [ ${#NAMES[@]} -eq 0 ]; then
  echo "用法: bash scripts/deploy.sh [--dry-run] 容器名1 [容器名2 ...]" >&2
  exit 1
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] $*"
  else
    eval "$@"
  fi
}

# ---------- 1. 构建 ----------
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "==> 跳过构建（SKIP_BUILD=1）"
else
  echo "==> 构建镜像 $IMAGE"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] docker build -t $IMAGE ."
  else
    docker build -t "$IMAGE" .
  fi
fi

# ---------- 2. 校验镜像里的版本号 ----------
# 这一步是分水岭：镜像里版本不对，后面重建多少次都是白费。
echo "==> 校验镜像内容"
IMG_VER=$(docker run --rm "$IMAGE" sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1" 2>/dev/null || true)
if [ -z "$IMG_VER" ]; then
  echo "    ✗ 镜像里找不到版本号，构建可能不完整，中止" >&2
  exit 1
fi
echo "    ✓ 镜像版本 $IMG_VER"

# ---------- 3. 逐个重建 ----------
for NAME in "${NAMES[@]}"; do
  echo
  echo "==> 容器 $NAME"

  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    echo "    ✗ 容器不存在。首次部署请先手动 docker run 创建，之后再用本脚本更新"
    continue
  fi

  # 宿主机端口：只取映射到容器服务端口的那个
  HOST_PORT=$(docker inspect -f "{{range \$p, \$conf := .NetworkSettings.Ports}}{{if eq \$p \"${CONTAINER_PORT}/tcp\"}}{{range \$conf}}{{.HostPort}}{{end}}{{end}}{{end}}" "$NAME")
  if [ -z "$HOST_PORT" ]; then
    echo "    ✗ 读不到 $NAME 的 $CONTAINER_PORT 端口映射，中止（避免起在随机端口上）" >&2
    exit 1
  fi

  # /app/data 的挂载：命名卷取卷名，宿主机目录取路径
  DATA_MOUNT=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$NAME")
  if [ -z "$DATA_MOUNT" ]; then
    echo "    ✗ $NAME 没有挂载 /app/data，直接重建会让数据看起来丢失，中止" >&2
    echo "      请先手动确认数据目录再迁移" >&2
    exit 1
  fi

  echo "    端口 $HOST_PORT -> $CONTAINER_PORT ｜ 数据 $DATA_MOUNT -> /app/data"

  BACKUP="${NAME}_bak_$(date +%Y%m%d%H%M%S)"
  run "docker stop '$NAME'"
  run "docker rename '$NAME' '$BACKUP'"
  run "docker run -d --name '$NAME' --restart unless-stopped -p '${HOST_PORT}:${CONTAINER_PORT}' -v '${DATA_MOUNT}:/app/data' -e TZ=Asia/Shanghai '$IMAGE'"

  if [ "$DRY_RUN" != "1" ]; then
    sleep 3
    NEW_VER=$(docker exec "$NAME" sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1" 2>/dev/null || echo "读取失败")
    DB=$(docker exec "$NAME" sh -c "ls -lh /app/data/mall.db 2>/dev/null | awk '{print \$5}'" 2>/dev/null || echo "")
    echo "    ✓ 新容器版本 $NEW_VER ｜ 数据库 ${DB:-未找到}"
    echo "    回滚：docker rm -f $NAME && docker rename $BACKUP $NAME && docker start $NAME"
    echo "    旧容器保留为 $BACKUP，观察无误后手动删除（不要加 -v）"
  fi
done

echo
echo "==> 完成"
