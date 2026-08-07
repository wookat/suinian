# 数据导入（Cubox / flomo / Markdown / 纯文本）

> R25 起支持。背景：Cubox 官宣将于 2027-05 停止速记/文件功能，其用户正在寻找迁移出路；碎念的导入能力用于承接这波迁移，同时覆盖 flomo 等通用来源。

## 使用方式

- **Web**：设置页 →「导入数据」区块 → 选择来源 → 选择文件 → 上传后显示导入统计。
- **API**：`POST /api/import`（Bearer token 鉴权）
  - multipart 表单：`source`（`cubox` / `flomo` / `markdown` / `text`）+ `file`（≤20MB）
  - 或 JSON：`{ "source": "...", "content": "文件文本内容" }`
  - 返回：`{ total, imported, skipped, failed }`（201）

```bash
curl -X POST https://suinian-api.zalize.com/api/import \
  -H "Authorization: Bearer <token>" \
  -F source=flomo -F file=@flomo/index.html
```

## 导出格式调研（以实际样例为准）

### Cubox

Cubox 支持在客户端/网页版通过「共享/导出」将收藏导出为 CSV、HTML、txt、Markdown 等格式（2022-03 起统一入口）。

- **CSV**（全量导出，推荐）：首行表头，常见列为 `标题, 描述, 链接, 标签, 文件夹, 创建时间`（英文版为 `title, description, url/link, tags, folder, created`）。不同版本列名有出入，解析器按别名容错匹配（如 `网址`/`链接`/`url`/`link`，`创建时间`/`收藏时间`/`created` 等），只要能识别出标题/链接/内容任一列即可导入。
- **HTML**：标准 Netscape 书签格式（`<!DOCTYPE NETSCAPE-Bookmark-file-1>`），每条为 `<DT><A HREF="..." ADD_DATE="unix秒" TAGS="a,b">标题</A>`。`ADD_DATE` 为 Unix 时间戳（秒），`TAGS` 属性可选。
- **txt**：纯文本，条目间以空行分隔，按纯文本块解析。

解析器对 Cubox 文件自动探测：书签 HTML → CSV → 纯文本块，逐级回退。

### flomo

flomo 仅支持导出 **HTML**（设置 → 账号详情 → 导出，得到压缩包，正文在其中的 HTML 文件里；图片在 file/ 目录，暂不导入）。结构为：

```html
<div class="memo">
  <div class="time">2023-06-01 08:30:00</div>
  <div class="content"><p>正文，标签内联为 #标签 形式</p></div>
  <div class="files">…图片…</div>
</div>
```

- `time` 为北京时间（无时区标注），格式 `YYYY-MM-DD HH:MM:SS`。
- 标签为正文内联 `#tag`（支持中文、`/` 层级），解析时抽取为笔记标签（正文原样保留）。

### 通用 Markdown / 纯文本

- **Markdown**：优先按 `---` 分隔线拆条；无分隔线时按 `#`/`##`/`###` 标题拆条；都没有则按空行拆段。每条首行若为独立日期（`YYYY-MM-DD [HH:MM[:SS]]` 或 `date: ...`），作为该条的原创建时间。
- **纯文本**：按空行拆条，每段一条。
- 两者都抽取正文内联 `#tag` 作为标签。

## 时间与时区

- 导出文件中的裸本地时间（无时区标注，如 flomo/Cubox CSV）按 **Asia/Shanghai（UTC+8）** 解释，转为 UTC 存入 `notes.created_at`（与 `datetime('now')` 同格式），前端展示时按本地时区还原。
- Unix 时间戳（秒或毫秒，如书签 `ADD_DATE`）与带时区的 ISO 时间按其本义转换。
- 无法解析出时间的条目使用导入时刻。

## 导入行为

- **保留原创建时间**：`notes.created_at` / `updated_at` 用导出文件里的原时间。
- **保留原标签**：导出文件中的标签直接写入 `notes.tags`，并存档在 `meta.import_tags`；后续 AI 分拣不会覆盖，而是在原标签基础上并入 AI 建议（上限 6 个）。
- **链接**：带 URL 的条目写入 `notes.url`，走既有链接管线（标题/正文抓取由 cron 每 10 分钟限速补处理，每轮 3 条，不阻塞导入响应）。
- **去重**：同内容 + 同创建时间已存在则跳过（条目无时间时按同内容去重）。
- **异步分拣**：导入行 `category` 置 NULL，由既有 cron 补处理机制逐步完成 AI 分拣（每轮 10 条）、嵌入、图谱、线索聚类，避免一次性打爆 AI 配额。20+ 条的导入通常在 1 小时内全部分拣完成。
- **限制**：单文件 ≤20MB；单次最多解析 2000 条；单条内容截断至 2 万字符；`source` 字段记为 `import`。
