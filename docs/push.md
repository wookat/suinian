# 浏览器通知（Web Push）

碎念用标准 Web Push（VAPID）把「待办到点提醒」和「每日回顾」推到浏览器/系统通知，不依赖微信 bridge。

## 用户侧使用

1. 打开 设置 →「浏览器通知」→「开启浏览器通知」，允许通知权限。
2. 多设备各自开启，互不影响；「关闭通知」只退订当前设备。
3. 「发送测试推送」可立即验证通道。
4. 推送内容受「推送偏好」开关控制：
   - **待办提醒推送**：待办的截止时间一到（10 分钟粒度的定时扫描），推一条提醒，点击跳到待办页。每条待办只提醒一次；只有日期没有时间的待办按当天 09:00（东八区）提醒。
   - **每日回顾推送**：每天当地时间早上 8 点后推一条「今日回顾」摘要（时区取订阅时浏览器上报的时区），点击跳到时间流。每天最多一条。

## 平台支持与限制

| 平台 | 支持情况 |
|---|---|
| Chrome / Edge / Firefox（桌面、Android） | ✅ 直接开启即可 |
| macOS Safari 16+ | ✅ 直接开启即可 |
| **iOS / iPadOS Safari** | ⚠️ 需 iOS 16.4+，且**必须先「添加到主屏幕」装成 PWA、从主屏幕图标打开**后才能订阅；Safari 浏览器标签页里无法订阅。通知由系统统一管理，用户在系统设置里关闭通知即等于退订 |
| 微信内置浏览器 | ❌ 不支持 Web Push |

其他已知 iOS 限制：iOS 会在用户长期不打开 PWA 时自动使订阅失效（服务端收到 410 后自动清理）；不支持通知角标数字自定义。

## 自部署配置

1. 生成 VAPID 密钥对：`node backend/scripts/generate-vapid.mjs`
2. 写入 worker secrets：

```bash
cd backend
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
# 可选：VAPID subject（默认 mailto:admin@zalize.com）
npx wrangler secret put VAPID_SUBJECT
```

3. 应用数据库迁移（`0014_r67_push.sql`）后重新部署。未配置 VAPID 密钥时推送相关接口返回 503，设置页会提示「服务端未配置推送」。

## 实现说明

- 加密/签名使用 [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push)：纯 WebCrypto 实现 RFC 8291（aes128gcm）载荷加密与 VAPID ES256 JWT，可直接跑在 Cloudflare Workers（经典 `web-push` 包依赖 Node crypto，Workers 不可用）。
- 订阅存 `push_subscriptions`（一行一设备），推送服务返回 404/410 时自动删除。
- 待办去重靠 `notes.todo_reminded_at`（先标记后发送，至多一次）；每日回顾去重靠 `push_daily_log(user_id, review_date)`。
- 两个扫描挂在既有 `*/10 * * * *` cron 上。
