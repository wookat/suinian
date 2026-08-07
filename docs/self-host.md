# 碎念自部署指南（约 30 分钟跑通全链）

目标：在你自己的 Cloudflare 账号里跑起完整的碎念 —— 后端 API（Workers + D1 + R2）+ Web 端（Pages），可选微信入口（bot 桥）。

> **懒人通道**：`bash scripts/setup.sh` 交互式一键完成本页 1–2 节的全部步骤（建 D1 / R2、改 wrangler.toml、migrations、secrets、部署 Worker + Pages、配 CORS）。以下是手动步骤。

## 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/)（免费版即可：Workers / D1 / R2 / Pages / Workers AI 免费额度足够个人使用）
- AI 供给（二选一）：直接用 Cloudflare Workers AI（推荐，无需额外账号），或 [DeepSeek API Key](https://platform.deepseek.com/) / 任意 OpenAI 兼容 API（按量付费，个人用量极低）
- Node.js ≥ 20 与 npm
- `git clone https://github.com/wookat/suinian.git`
- 认证：`npx wrangler login`（浏览器授权），或设置 `CLOUDFLARE_API_TOKEN` 环境变量。用 API token 时需要 **Workers Scripts / D1 / R2 / Pages / Workers AI** 的编辑权限（权限不够时 `r2 bucket create` 或 `wrangler deploy` 会报 `Authentication error [code: 10000]`）

## 1. 后端（Cloudflare Workers + D1 + R2）

```bash
cd backend
npm install
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

### 1.3 创建 R2 bucket（存语音/图片/文件原件）

```bash
npx wrangler r2 bucket create suinian-media
```

bucket 名如果改了，同步改 `wrangler.toml` 里 `[[r2_buckets]]` 的 `bucket_name`。R2 首次使用需在 dash 里启用（免费，无需绑卡可用免费额度）。

### 1.4 设置密钥

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

### 1.5 部署 & 创建用户

```bash
npx wrangler deploy
```

部署完成后输出类似 `https://suinian-api.<你的子域>.workers.dev` 的地址。新开通的 workers.dev 子域需要 1–2 分钟生效（期间访问会报 `error code: 1042`，稍等即可）。

### 1.6 创建账号（二选一）

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
npx wrangler pages deploy dist --project-name suinian --branch main
```

### 2.1 允许你的 Web 域名跨域访问 API（必做，否则注册/登录报「网络连接失败」）

API 默认只允许官方域名与本地开发端口跨域。自部署的 Pages 域名（如 `https://suinian.pages.dev` 或你的自定义域）要加进 `backend/wrangler.toml` 的 `[vars]`：

```toml
[vars]
CORS_ALLOWED_ORIGINS = "https://你的域名.pages.dev"   # 多个用逗号分隔；"*" 允许任意来源
```

然后重新 `npx wrangler deploy`。API 只用 Bearer token（无 cookie），个人实例设 `"*"` 也是安全的。

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

## 本地开发（不部署也能跑）

无需任何 Cloudflare 资源与 API key，全部跑在本地（D1/R2 用本地模拟，AI 用内置 mock）：

```bash
# 后端
cd backend && npm install
cp .dev.vars.example .dev.vars   # 默认 AI_MODEL=mock，无 key 也能跑通分拣/问答
npm run dev:init                 # 本地 D1 建表（首次或 migrations 变更后执行）
npm run dev                      # http://127.0.0.1:8787

# Web 端（另开终端）
cd web && npm install
cp .env.example .env.local       # VITE_API_BASE=http://127.0.0.1:8787
npm run dev                      # http://localhost:5173，注册个本地账号即可用
```

## 常见问题

- **`wrangler dev` / `wrangler deploy` 报 `Authentication error [code: 10000]`？** API token 权限不够，需要 Workers Scripts / D1 / R2 / Pages 编辑权限；或改用 `npx wrangler login`。
- **刚部署完访问 404 / `error code: 1042`？** 新 workers.dev 子域需 1–2 分钟生效，稍等重试。
- **Web 端注册/登录报「网络连接失败」？** 大概率是 CORS：把你的 Web 域名加进 `CORS_ALLOWED_ORIGINS`（见 2.1 节）。
- **周报没生成？** cron 在每周一 08:00（Asia/Shanghai）跑；可 `POST /api/reports/generate` 手动触发验证。
- **线索没聚出来？** 聚类只对 `idea` 类笔记生效，需要至少两条相近主题的想法；可 `POST /api/threads/rebuild` 全量重建。
- **Workers AI 不可用？** 聚类会自动降级为 DeepSeek 判断，功能不受影响。
- **费用？** Cloudflare 免费额度即可跑通；外接 DeepSeek 按量（个人每月通常 <1 美元）。
- **AI 分拣失败？** 笔记会保持「分拣中」，每 10 分钟由 cron 自动补拣，无需手动处理。
