# 微信 ClawBot（iLink）边界实测调研报告

日期：2026-08-06 ｜ 调研人：Devin（碎念线3+4）
方法：① 直连腾讯官方 iLink 接入点实测（无需真实微信账号的部分）；② 官方插件 `@tencent-weixin/openclaw-weixin` 源码/README 协议查证；③ `@wechatbot/wechatbot` SDK 能力查证；④ 竞品公开信息（OmniBox、SiverKing/weixin-ClawBot-API）交叉验证。
标注说明：**[实测]** 本机验证过；**[查证]** 官方协议文档/SDK 源码确认；**[三方观察]** 竞品/社区信息，未独立验证；**[待老板真机验证]** 需要真实微信扫码。

## 1. 结论速览

| 边界项 | 结论 | 依据 |
|---|---|---|
| 接入点可达性 | `https://ilinkai.weixin.qq.com` 官方服务器，公网可达 | [实测] |
| 扫码二维码获取 | `/ilink/bot/get_bot_qrcode?bot_type=3` 无需任何凭据即可拿到二维码（`ret:0` + liteapp 链接），说明**服务端未按 IP/账号做灰度拦截** | [实测] |
| 错误 token 行为 | `getupdates` 携带无效 token 返回 `{"errcode":-14,"errmsg":"session timeout"}` | [实测] |
| 支持消息类型（收） | TEXT / IMAGE / VOICE / FILE / VIDEO 五类（`MessageItem.type` 1–5），另有 `ref_msg` 引用消息 | [查证] 官方协议 |
| 支持消息类型（发） | 文本 / 图片(+缩略图) / 视频 / 文件；CDN AES-128-ECB 加密上传 | [查证] |
| 能否收文件/语音 | **能**。文件走 CDN 下载；语音为 SILK 编码（SDK 可转 wav） | [查证]；实际收发体验[待老板真机验证] |
| 卡片/公众号文章转发 | **不支持**。协议无卡片(appmsg)类型；给 ClawBot 转发公众号卡片会失败或退化，链接需复制粘贴发送 | [查证] 协议无此类型 + [三方观察] OmniBox 同样受限 |
| 3 秒限流 | 下行约 **3 秒 1 条**（竞品 OmniBox 公开承认同样限制）；协议文档未写明确数值，疑为服务端风控而非文档化配额 | [三方观察]；精确数值[待老板真机验证] |
| 24h 重连 | iLink 会话有效期 **24 小时**；`errcode:-14` 表示会话过期。wechatbot SDK 内置会话自动恢复（`session:expired` → 自动重登，凭证持久化免扫码）；SiverKing 实现为"预警→确认→无缝换 token" | [查证] + [实测]（-14 已复现） |
| 重启免扫码 | 凭证持久化于 `~/.wechatbot/`（bridge 中挂 volume），重启自动恢复 | [查证] |
| 灰度范围 | 2026-03 发布；npm 官方插件公开可装、二维码接口全网可请求，未见 IP/区域灰度；**账号维度是否灰度（个别微信号无法绑定 bot）** | [实测]（接口侧）+ [待老板真机验证]（账号侧） |
| 群聊 | 官方插件能力声明**仅支持单聊（direct chats）**，不支持群 | [查证] OpenClaw 官方文档 |
| 多账号 | 支持；每账号独立凭证目录，同一账号全集群只能一个实例轮询（游标互踩） | [查证] SDK 文档 |
| bot_agent | 出站请求可自报 UA 式 `bot_agent`（≤256B ASCII），仅用于日志归因 | [查证] |

## 2. 实测记录

```
# ① 二维码获取（无凭据，直接成功 → 无灰度拦截）
POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
body: {"local_token_list":[]}
→ {"qrcode":"2b63…","qrcode_img_content":"https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=…&bot_type=3","ret":0}

# ② 无效 token 长轮询 → 会话过期错误码（与 24h 过期同码）
POST /ilink/bot/getupdates  (Authorization: Bearer invalid)
→ {"errcode":-14,"errmsg":"session timeout"}

# ③ bridge 全链路冒烟（mock 后端）：收件×4（文本/待办/链接/图片）+ 问答 + 鉴权失败 → 全部通过
```

## 3. 协议要点（对碎念的工程含义）

- **长轮询**：`getupdates` 带游标 `get_updates_buf`，服务端建议超时 `longpolling_timeout_ms`（约 35s）。SDK 已封装，游标自动管理。
- **媒体**：全部走 CDN + AES-128-ECB，收发都要处理加解密（SDK 已封装 `download()/upload()`）。语音 SILK → 后端转写需先转码（SDK 可出 wav），R3 轮再接转写。
- **context_token**：回复必须带会话 context_token，SDK 自动管理生命周期、跨重启持久化。
- **限流应对**：bridge 内置串行回复队列（`REPLY_INTERVAL_MS` 默认 3000ms），多条消息排队回复，不会因限流丢回复。
- **24h 重连应对**：bridge 依赖 SDK 的 `-14` 自动重登（凭证仍有效时免扫码）；若凭证整体失效需重新扫码——bridge 日志会打印新二维码，Docker 部署时 `docker compose logs -f` 可见。是否会"静默要求重新扫码"[待老板真机验证]。

## 4. 无法实测的部分 & 老板真机验证步骤清单

以下需要真实微信账号扫码，已备好步骤（预计 15–20 分钟）：

1. **绑定**：`cd skill/bridge && npm install && npm run mock &`，`cp .env.example .env && set -a && source .env && set +a && npm run dev`，微信扫终端二维码 → 确认。若提示数字配对码请留意记录（SiverKing 提到过配对码流程）。
   - ✅ 预期：终端显示登录成功；❓记录：你的微信号能否正常绑定（账号灰度验证）
2. **五类消息**：依次发 文字 / 复制粘贴的链接 / 图片 / 语音 / 一个 PDF 文件
   - ✅ 预期：每条都回「已存：…」；❓记录：语音和文件是否能收到（media 下载日志）
3. **卡片转发**：把一篇公众号文章"转发"给 bot（不是复制链接）
   - ❓ 记录：微信是否允许选择该联系人 / 发送后 bot 是否收到任何消息（预期：收不到或类型缺失）
4. **3 秒限流**：连续快速发 5 条短文本
   - ❓ 记录：5 条是否都有回复、回复间隔（预期：约 3s 一条排队回复）；再试连续发 10 条看有无丢消息
5. **视频**：发一段小视频
   - ❓ 记录：能否收到（协议支持 VIDEO，产品侧未验证）
6. **24h 重连**：绑定后放置 24h+，再发一条消息
   - ❓ 记录：是否自动恢复（日志有 `session:expired`→`session:restored`）还是要求重新扫码
7. **重启免扫码**：`Ctrl-C` 停掉 bridge 再 `npm run dev`
   - ✅ 预期：不出二维码直接上线
8. **敏感内容**：发一条密码类内容（如"服务器root密码是xxx"）
   - ❓ 记录：确认后端标记加密（需后端就绪；mock 阶段只验证入库）

## 5. 遗留问题

- 3 秒限流的精确口径（按会话/按 bot/按方向）无官方文档，只能真机测。
- 大文件（>8MB）当前只传元数据；R2 直传通道等后端就绪后补。
- 群聊不支持是官方插件的能力声明；iLink 协议层是否预留群消息未知，不影响 R1。
- ClawHub 发布材料已备好（`skill/clawhub/`），按约定**未发布**，等总集成验收。
