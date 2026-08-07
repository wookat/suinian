# 碎念自部署指南（约 30 分钟跑通全链）

目标：在你自己的 Cloudflare 账号里跑起完整的碎念 —— 后端 API（Workers + D1）+ Web 端（Pages），可选微信入口（bot 桥）。

## 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/)（免费版即可：Workers / D1 / Pages / Workers AI 免费额度足够个人使用）
- AI 供给（二选一）：直接用 Cloudflare Workers AI（推荐，无需额外账号），或 [DeepSeek API Key](https://platform.deepseek.com/) / 任意 OpenAI 兼容 API（按量付费，个人用量极低）
- Node.js ≥ 20 与 npm
- `git clone https://github.com/wookat/suinian.git`

## 1. 后端（Cloudflare Workers + D1）

```bash
cd backend
npm install
npx wrangler login          # 首次：浏览器授权 Cloudflare
```

### 1.1 创建 D1 数据库

```bash
npx wrangler d1 create suinian
```

把输出中的 `database_id` 填入 `backend/wrangler.toml` 的 `[[d1_databases]]` 段。
同时**删除（或改为你自己的域名）** `wrangler.toml` 里的 `routes` 段——那是官方实例的自定义域；删掉后部署会得到默认的 `https://suinian-api.<你的子域>.workers.dev` 地址。

### 1.2 建表（migrations）

```bash
npx wrangler d1 migrations apply suinian --remote
```

> ⚠️ 仓库锁定的 wrangler v3.99 在部分环境下 `d1 migrations apply --remote` 有已知兼容问题。若报错，可用 Cloudflare REST API 逐条执行迁移（`CLOUDFLARE_API_TOKEN` 需 D1 编辑权限，`ACCOUNT_ID`/`DB_ID` 见 dash 或 `d1 create` 输出）：
>
> ```bash
> for f in migrations/*.sql; do
>   curl -sX POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DB_ID/query" \
>     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
>     --data "$(jq -n --arg sql "$(cat $f)" '{sql:$sql}')"
> done
> ```

### 1.3 设置密钥

AI 供给二选一：

- **Workers AI（推荐，零外部依赖）**：不需要任何外部 key，设置模型即可：

```bash
printf 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast' | npx wrangler secret put AI_MODEL
```

- **DeepSeek / 任意 OpenAI 兼容 API**：

```bash
npx wrangler secret put DEEPSEEK_API_KEY
# 可选：换模型/换 base url（默认 deepseek-chat @ https://api.deepseek.com）
# printf 'your-model' | npx wrangler secret put AI_MODEL
# printf 'https://your-provider.com/v1' | npx wrangler secret put AI_BASE_URL
```

其余密钥：

```bash
# 敏感内容加密密钥（32 随机字节 base64）。生成后务必备份——丢失将无法解密存量敏感笔记
openssl rand -base64 32 | npx wrangler secret put SUINIAN_ENC_KEY
```

### 1.4 部署 & 创建用户

```bash
npx wrangler deploy
```

### 1.5 创建账号（二选一）

**方式 A：自助注册（推荐）**——直接在 Web 端首页引导里选「注册新账号」，或调接口：

```bash
curl -sX POST https://<你的 worker 地址>/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"me","password":"你的密码（至少8位）"}'
# 返回的 api_token 就是你的 Bearer token（也可随时用 name+密码 POST /api/auth/login 取回）
```

不想开放注册（个人实例部署完就关）：在 `backend/wrangler.toml` 的 `[vars]` 里把 `REGISTRATION_ENABLED` 改为 `"false"` 后重新 `npx wrangler deploy`。

**方式 B：手工 INSERT（无密码，纯 token）**：

```bash
npx wrangler d1 execute suinian --remote --command \
  "INSERT INTO users (id,name,api_token) VALUES ('u_me','me','$(openssl rand -hex 24)')"
```

验证：`curl https://<你的 worker 地址>/health` 应返回 ok；带 token 调 `GET /api/notes` 应返回 `{"notes":[],...}`。

完整 API 文档见 [backend/README.md](../backend/README.md)。

## 2. Web 端（Cloudflare Pages）

Web 端是纯静态 SPA，API 地址与 token 在**页面的设置页**填写（存浏览器 localStorage），构建时无需配置：

```bash
cd web
npm install
npm run build                # tsc + vite build，输出 dist/
npx wrangler pages deploy dist --project-name suinian
```

部署完成后打开 Pages 给的地址（或绑定自己的域名）：

1. 首次打开会弹出引导三选一：**先看演示** / **注册新账号**（填你的 worker 地址 + 用户名密码，注册成功自动配置进入真实模式）/ **已有 token**（去设置页填）
2. 已有 token 的：进入「设置」→ 填 API Base URL（你的 worker 地址）与 API Token → 关闭演示模式 → 保存；设置页另有「复制我的 API token」「轮换 token」「注销账号」
3. 回到首页，速记框里丢一条试试——几秒后 AI 分拣的分类角标和标签会自动出现

## 3. 可选：微信入口（bot 桥）

> **微信入口是可选的**——纯 Web/API 已是完整体验，海外用户或不用微信的用户可直接跳过本节。

bot 桥是一个 Node.js 常驻进程（可 Docker 部署），扫码绑定微信后，给 bot 发的任何消息都会入库，`?` 开头则触发问答。详见 [skill/README.md](../skill/README.md)：

```bash
cd skill/bridge
npm install
cp .env.example .env    # 填 SUINIAN_API_URL=<你的 worker 地址>、SUINIAN_TOKEN=<你的 token>
npm run dev             # 终端出现二维码 → 微信扫码绑定
```

Docker / systemd 生产部署方式同样见 [skill/README.md](../skill/README.md)。

## 4. 可选：Android App

自行构建 APK（需 JDK 17 + Android SDK），安装后在设置页填同样的 API 地址与 token。见 [android/README.md](../android/README.md)。

## 常见问题

- **周报没生成？** cron 在每周一 08:00（Asia/Shanghai）跑；可 `POST /api/reports/generate` 手动触发验证。
- **线索没聚出来？** 聚类只对 `idea` 类笔记生效，需要至少两条相近主题的想法；可 `POST /api/threads/rebuild` 全量重建。
- **Workers AI 不可用？** 聚类会自动降级为 DeepSeek 判断，功能不受影响。
- **费用？** Cloudflare 免费额度即可跑通；外接 DeepSeek 按量（个人每月通常 <1 美元）。
- **AI 分拣失败？** 笔记会保持「分拣中」，每 10 分钟由 cron 自动补拣，无需手动处理。
