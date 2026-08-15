# 老板真机验收步骤（微信入口 · 约 10 分钟）

前提：bridge 已部署在国内服务器并常驻运行（systemd 服务 `suinian-bridge`），处于「等待扫码」状态。

## 8 步验收

1. **登录服务器**：`ssh <CN_VPS_USER>@<CN_VPS_HOST>`（凭证见密钥库 CN_VPS_HOST / CN_VPS_USER / CN_VPS_PASSWORD）。
2. **显示二维码**：运行 `suinian-qr`，终端显示 ASCII 二维码（约 60 秒有效，过期重跑一次即可；也会打印 liteapp 链接，可手机直接打开）。
3. **微信扫码**：用微信「扫一扫」扫码 → 手机上确认绑定。终端/日志出现「已上线，等待微信消息…」即绑定成功（`tail -f /var/log/suinian-bridge/bridge.log` 可观察）。
4. **发第一条消息**：在微信里给该 bot 联系人发一句想法，如「碎念收件箱要支持语音转写」。
   - ✅ 预期：几秒内回复「已存：想法 #…」之类确认文案。
5. **发一条链接**：粘贴任意网页 URL 发送。
   - ✅ 预期：回复「已存：收藏 …」（后端会抓取摘要）。
6. **问答检索**：发 `?我最近存了什么`（`?` 或 `？` 开头都可以）。
   - ✅ 预期：回复基于已存内容的答案。
7. **快速连发 5 条**短文本，验证限流排队。
   - ✅ 预期：每条都有回复，间隔约 3 秒逐条到达，不丢消息。
8. **Web 端核对**：打开 https://suinian.zalize.com 登录，确认刚才发的内容已出现在时间流。

## 故障排查

| 现象 | 处理 |
|---|---|
| `suinian-qr` 无二维码 | 该命令会自动重启服务生成新码；仍无则 `tail -50 /var/log/suinian-bridge/bridge.log` 看报错 |
| 二维码过期/扫码失败 | 服务每 ~60s 自动换新码，重跑 `suinian-qr` |
| 扫码成功但发消息无回复 | 看日志是否有「后端返回 4xx/5xx」；检查 `/etc/suinian-bridge.env` 里 SUINIAN_TOKEN 是否正确后 `systemctl restart suinian-bridge` |
| 回复「token 无效」 | `/etc/suinian-bridge.env` 的 SUINIAN_TOKEN 配错，改后重启服务 |
| 服务状态/重启 | `systemctl status suinian-bridge` / `systemctl restart suinian-bridge`；崩溃自动拉起、开机自启已配置 |
| 24h 会话过期 | SDK 尝试用已存凭证重登；凭证失效则无法自动恢复，需重新扫码（`suinian-qr`）。可查 `https://suinian-api.zalize.com/health?probe=bridge`：`online` 正常、`waiting_scan` 等扫码、`stale/never_reported` 桥进程未上报 |
