#!/bin/bash
# 部署碎念微信桥到服务器（systemd 常驻，开机自启 + 崩溃自动重启 + 日志落盘）
#
# 用法（在 skill/bridge 目录）：
#   BRIDGE_HOST=1.2.3.4[:port] BRIDGE_USER=root ./deploy/deploy.sh
#   密码登录时预先导出 SSHPASS 并确保本机装有 sshpass（脚本自动使用）。
#
# 首次部署需在服务器 /etc/suinian-bridge.env 写入（脚本会在缺失时用环境变量
# SUINIAN_API_URL / SUINIAN_TOKEN / SUINIAN_BRIDGE_TOKEN 生成，不落仓库明文）：
#   SUINIAN_API_URL=https://suinian-api.zalize.com
#   SUINIAN_TOKEN=sn_xxx
#   SUINIAN_BRIDGE_TOKEN=与 worker secret BRIDGE_TOKEN 一致（专用心跳凭证，R194 P2-5）
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BRIDGE_HOST:?需要 BRIDGE_HOST（IP[:端口]）}"
: "${BRIDGE_USER:?需要 BRIDGE_USER}"
HOST=${BRIDGE_HOST%%:*}
PORT=${BRIDGE_HOST##*:}; [ "$PORT" = "$HOST" ] && PORT=22

SSH="ssh -o StrictHostKeyChecking=accept-new -p $PORT $BRIDGE_USER@$HOST"
SCP_PORT="-P $PORT"
if [ -n "${SSHPASS:-}" ]; then SSH="sshpass -e $SSH"; SCP="sshpass -e scp $SCP_PORT"; else SCP="scp $SCP_PORT"; fi

echo "==> 本地构建"
npm ci
npm run build

echo "==> 打包上传"
TAR=/tmp/suinian-bridge.tar.gz
tar czf "$TAR" dist package.json package-lock.json deploy/suinian-bridge.service deploy/suinian-qr deploy/logrotate-suinian-bridge
$SCP "$TAR" "$BRIDGE_USER@$HOST:/tmp/suinian-bridge.tar.gz"

echo "==> 远端安装"
$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /opt/suinian-bridge /var/log/suinian-bridge /var/lib/suinian-bridge/wechatbot
tar xzf /tmp/suinian-bridge.tar.gz -C /opt/suinian-bridge && rm /tmp/suinian-bridge.tar.gz
cd /opt/suinian-bridge
npm ci --omit=dev --no-audit --no-fund
install -m 644 deploy/suinian-bridge.service /etc/systemd/system/suinian-bridge.service
install -m 755 deploy/suinian-qr /usr/local/bin/suinian-qr
install -m 644 deploy/logrotate-suinian-bridge /etc/logrotate.d/suinian-bridge
if [ ! -f /etc/suinian-bridge.env ]; then
  echo "[deploy] /etc/suinian-bridge.env 不存在，稍后由部署方写入" >&2
fi
systemctl daemon-reload
systemctl enable suinian-bridge
REMOTE

if [ -n "${SUINIAN_API_URL:-}" ] && [ -n "${SUINIAN_TOKEN:-}" ]; then
  echo "==> 写入 /etc/suinian-bridge.env（600 权限）"
  printf 'SUINIAN_API_URL=%s\nSUINIAN_TOKEN=%s\nSUINIAN_BRIDGE_TOKEN=%s\nLOG_LEVEL=info\nREPLY_INTERVAL_MS=3000\n' "$SUINIAN_API_URL" "$SUINIAN_TOKEN" "${SUINIAN_BRIDGE_TOKEN:-}" \
    | $SSH 'cat > /etc/suinian-bridge.env && chmod 600 /etc/suinian-bridge.env'
fi

echo "==> 启动服务"
$SSH 'systemctl restart suinian-bridge && sleep 3 && systemctl status suinian-bridge --no-pager -l | head -12 && tail -n 20 /var/log/suinian-bridge/bridge.log'
echo "==> 完成。绑定二维码：ssh 登录后运行 suinian-qr"
