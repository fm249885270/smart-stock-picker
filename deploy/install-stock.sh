#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/muge-tool
DATA_DIR=/var/lib/muge-tool
NGINX_CONF=/www/server/panel/vhost/nginx/fengmu.me.conf
SNIPPET="$SRC_DIR/deploy/stock.location.conf"

NODE_BIN=/usr/local/node/bin/node
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "NODE_MISSING"
  exit 1
fi

rm -rf "$APP_DIR"
install -d -m 0755 "$APP_DIR"
cp -a "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$APP_DIR/"
cp -a "$SRC_DIR/lib" "$APP_DIR/lib"
cp -a "$SRC_DIR/public" "$APP_DIR/public"

install -d -m 0750 "$DATA_DIR"
chown -R www:www "$DATA_DIR"

sed "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server.js#" \
  "$SRC_DIR/deploy/muge-tool-stock.service" > /etc/systemd/system/muge-tool.service
systemctl daemon-reload
systemctl enable muge-tool >/dev/null 2>&1 || true
systemctl restart muge-tool

if [ -f "$NGINX_CONF" ] && ! grep -q "location ^~ /stock/" "$NGINX_CONF"; then
  cp "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%s)"
  awk -v snip="$SNIPPET" '
    { lines[NR]=$0 }
    END {
      last=0
      for (i=1;i<=NR;i++) if (lines[i] ~ /^}/) last=i
      for (i=1;i<=NR;i++) {
        if (i==last) { while ((getline line < snip) > 0) print "    " line; close(snip) }
        print lines[i]
      }
    }' "$NGINX_CONF" > "$NGINX_CONF.tmp"
  mv "$NGINX_CONF.tmp" "$NGINX_CONF"
fi

nginx -t
nginx -s reload || systemctl reload nginx

sleep 2
echo "--- health ---"
curl -s -m 25 http://127.0.0.1:8787/api/health | head -c 400
echo
echo "--- service ---"
systemctl is-active muge-tool
echo "INSTALL_OK"