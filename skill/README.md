# skill/ — 微信 ClawBot 接入 + OpenClaw skill

碎念的微信入口，两种形态：

1. **独立 bot 桥（`bridge/`）** — 不依赖 OpenClaw，基于 [@wechatbot/wechatbot](https://github.com/corespeed-io/wechatbot) SDK 的 Node.js 常驻进程：扫码绑定 → 长轮询收消息 → POST 后端 `/api/ingest/wechat` → 回复确认；`?` 开头走 `/api/ask` 问答。Docker 一键部署。
2. **OpenClaw skill（`SKILL.md` + `clawhub/`）** — 给已装 OpenClaw + ClawBot 微信插件的用户，`claw install` 后由 agent 按 SKILL.md 调后端 API。发布材料就绪，**暂不发布 ClawHub**（等总集成验收）。

## 目录

```
skill/
├── SKILL.md              # OpenClaw skill 定义（name: suinian）
├── bridge/               # 独立微信 bot 桥（Node.js/TS）
│   ├── src/              # config / payload 规整 / 后端 client / 消息处理 / 限流队列
│   ├── mock/server.ts    # 本地 mock 后端（接口形状按 docs/SPEC.md）
│   ├── test/             # vitest 单测 + 冒烟脚本
│   ├── Dockerfile / docker-compose.yml / .env.example
├── clawhub/              # ClawHub 发布材料（README、使用示例）
└── docs/clawbot-limits.md  # ClawBot 边界实测调研 + 老板真机验证清单
```

## bridge 快速开始

```bash
cd skill/bridge
npm install

# 后端未就绪时先起 mock（端口 8788，token: test-token）
npm run mock &

cp .env.example .env   # 按需改 SUINIAN_API_URL / SUINIAN_TOKEN
set -a && source .env && set +a
npm run dev            # 终端出现二维码 → 微信扫码绑定
```

绑定后直接给 bot 发消息：

- 任意文字/链接/图片/语音/文件 → 入库并回复「已存：想法 #标签…」
- `?问题` / `？问题` → 问答检索

### Docker 部署

```bash
cd skill/bridge
cp .env.example .env   # 填真实 SUINIAN_API_URL / SUINIAN_TOKEN
docker compose run --rm suinian-wechat-bridge   # 首次：终端扫码
docker compose up -d                            # 之后：凭证已持久化，免扫码
```

凭证存在 named volume `wechatbot-creds`，重启不需要重新扫码；iLink 会话 24h 过期后 SDK 自动重连（详见 [docs/clawbot-limits.md](docs/clawbot-limits.md)）。

### 生产部署（国内服务器 · systemd 常驻）

生产环境跑在国内 VPS（CN_VPS_HOST，见密钥库）上的 systemd 服务 `suinian-bridge`：开机自启、崩溃 5s 自动拉起、日志落盘 `/var/log/suinian-bridge/bridge.log`（logrotate 周转 8 份）、token 通过 `/etc/suinian-bridge.env`（600 权限）注入，不落仓库。

```bash
cd skill/bridge
# 密码登录：export SSHPASS=<密码>（需本机装 sshpass）
BRIDGE_HOST=<ip[:port]> BRIDGE_USER=root \
SUINIAN_API_URL=https://suinian-api.zalize.com SUINIAN_TOKEN=<token> \
./deploy/deploy.sh
```

脚本本地构建 → 上传 dist → 远端 `npm ci --omit=dev` → 装 systemd unit + `suinian-qr` 命令 + logrotate → 启动。绑定：ssh 登录服务器后运行 **`suinian-qr`** 显示二维码，微信扫码即绑（老板验收步骤见 [docs/boss-verify.md](docs/boss-verify.md)）。服务器运维：

```bash
systemctl status|restart suinian-bridge   # 状态 / 重启
tail -f /var/log/suinian-bridge/bridge.log # 日志
suinian-qr                                 # 显示绑定二维码
```

### 依赖版本锁定与升级须知（重要）

`bridge/package.json` 的所有依赖**锁死精确版本**（无 `^`/`~`），当前 `@wechatbot/wechatbot@2.2.0`（2026-07-01 发布，零运行时依赖、不依赖 openclaw/plugin-sdk）。

背景：2026-03-22 起 OpenClaw 插件 SDK 大重构（`openclaw/plugin-sdk` 移除且无 shim），曾导致 ClawBot 生态瘫痪 72h。本 bridge 走独立的 `@wechatbot/wechatbot` SDK，不受 OpenClaw 插件链影响，但升级仍须谨慎：

1. **不要**恢复 `^` 范围版本，升级必须显式改 package.json 并重新生成 lockfile；
2. 升级前查 `npm view @wechatbot/wechatbot@<新版本> dependencies deprecated`，确认未引入 openclaw/plugin-sdk 依赖、未被弃用，且发布 ≥7 天；
3. 升级后必跑 `npm test`（18 单测）+ `npm run smoke`（mock 全链路）+ 真机扫码回归，再部署生产；
4. 生产回滚：重新跑旧 commit 的 `deploy/deploy.sh` 即可（凭证目录 `/var/lib/suinian-bridge/wechatbot` 不受影响，免重新扫码）。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUINIAN_API_URL` | ✅ | 后端地址 |
| `SUINIAN_TOKEN` | ✅ | Bearer token |
| `LOG_LEVEL` | | debug/info/warn/error（默认 info） |
| `REPLY_INTERVAL_MS` | | 出站回复最小间隔，默认 3000（对齐微信 3 秒限流） |
| `WECHATBOT_STORAGE_DIR` | | 微信凭证目录，默认 `~/.wechatbot` |

### 测试

```bash
npm test        # 18 个单测（payload 规整 / 问答判定 / 错误处理）
npm run smoke   # 冒烟：起 mock 后端跑通 收件×4 + 问答 + 鉴权失败 全链路
npm run lint    # tsc --noEmit
```

## 后端接口契约（docs/SPEC.md）

- `POST /api/ingest/wechat`（Bearer）：`{source:"wechat", raw_type, content, url?, wechat_user_id, wechat_message_id?, created_at?, attachments?[{mime,size,file_name?,data_base64?}]}` → `{ok, note_id, reply}`；`reply` 为回给用户的确认文案
- `POST /api/ask`（Bearer）：`{source:"wechat", question, wechat_user_id}` → `{ok, answer, note_ids}`
- 附件 ≤8MB base64 内联；更大只传元数据（R2 直传后续 R2 轮次补）
