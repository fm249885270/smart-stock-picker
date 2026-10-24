#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/install.sh"
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/muge-tool"
DATA_DIR="/var/lib/muge-tool"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 20 或更高版本。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 版本过低，需要 20 或更高版本；当前：$(node -v)"
  exit 1
fi

install -d -m 0755 "$APP_DIR/lib" "$APP_DIR/public"
cp -a "$SRC_DIR/server.js" "$APP_DIR/server.js"
cp -a "$SRC_DIR/package.json" "$APP_DIR/package.json"
cp -a "$SRC_DIR/lib/." "$APP_DIR/lib/"
cp -a "$SRC_DIR/public/." "$APP_DIR/public/"
install -d -o www-data -g www-data -m 0750 "$DATA_DIR"

NODE_BIN="$(command -v node)"
sed "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server.js#" \
  "$SRC_DIR/deploy/muge-tool.service" > /etc/systemd/system/muge-tool.service
install -m 0644 "$SRC_DIR/deploy/nginx-stock.fengmu.me.conf" /etc/nginx/conf.d/stock.fengmu.me.conf

systemctl daemon-reload
systemctl enable muge-tool
systemctl restart muge-tool
nginx -t
systemctl reload nginx

echo ""
echo "智能选股已启动：http://127.0.0.1:8787"
echo "请确认 stock.fengmu.me 已解析到本服务器，再配置 HTTPS。"