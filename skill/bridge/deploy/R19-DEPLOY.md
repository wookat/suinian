# R19 bridge 部署说明（文件消息入库）

本次 R19 只改了 bridge 代码（文件消息 → 上传 /api/ingest/media type=file → 回复「已存档：<文件名> + 一句话摘要」，失败兜底仅存档文件名），**未在本会话部署到 VPS**，由后续运维会话执行。

## 部署步骤

1. 拉取合并了 R19 的 main 分支。
2. 在 `skill/bridge` 目录执行既有部署脚本（无新增环境变量、无 systemd/service 变更）：

   ```bash
   BRIDGE_HOST=<VPS_IP[:port]> BRIDGE_USER=root ./deploy/deploy.sh
   # 密码登录时预先 export SSHPASS 并确保本机装有 sshpass
   ```

   `/etc/suinian-bridge.env` 已存在则无需改动。

## 部署后验证

1. `systemctl status suinian-bridge` 正常、`/var/log/suinian-bridge/bridge.log` 无报错。
2. 微信发送一个 PDF/txt/md/docx 文件（≤10MB），应回复「已存档：<文件名> · <一句话摘要>」。
3. 发送不支持的类型（如 zip），应兜底存档文件名（回复普通已记录文案）。
