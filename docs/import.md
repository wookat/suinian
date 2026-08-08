# 数据导入（Cubox / flomo / Notion / Obsidian / Apple 备忘录 / Markdown / 纯文本）

> R25 起支持 Cubox / flomo / Markdown / 纯文本；R63 起新增 Notion / Obsidian / Apple 备忘录 zip 导入。背景：Cubox 官宣将于 2027-05 停止速记/文件功能，其用户正在寻找迁移出路；碎念的导入能力用于承接这波迁移，同时覆盖主流笔记工具。

## 使用方式

- **Web**：设置页 →「导入数据」区块 → 选择来源 → 选择文件 → 上传后显示导入进度与统计；失败条目可下载清单。
- **API**：`POST /api/import`（Bearer token 鉴权）
  - multipart 表单：`source`（`cubox` / `flomo` / `markdown` / `text` / `notion` / `obsidian` / `apple-notes`）+ `file`（≤20MB；Notion/Obsidian/Apple 备忘录为 zip）
  - 或 JSON：`{ "source": "...", "content": "文件文本内容" }`（仅非 zip 来源）
  - 返回：`{ total, imported, skipped, failed, failed_items: [{item, reason}] }`（201）
  - 加 `?stream=1`：返回 NDJSON 流，逐批输出 `{done,total}` 进度行，最后一行为 `{stats, failed_items}`，大包导入不阻塞、不超时（Web 默认走此模式）

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

### Notion（R63）

Notion 在页面菜单「导出 → Markdown & CSV（含子页面）」得到 zip，直接上传：

- **页面**：每页一个 `标题 <32位hex页面id>.md`，子页面/资产在同名文件夹里（递归处理）。文件名里的页面 id 会去掉。
- **数据库**：导出为 `<名称>.csv` + `<名称>_all.csv`，每行另有对应 `.md` 页。优先导入 `.md` 页（含属性块 `Created time` / `Tags` / `URL`），仅在 CSV 里的行再从 CSV 补导，不重复。
- **时间/标签/链接**：属性块或 CSV 列里的 `Created time`（英文日期如 `June 1, 2023 8:30 AM`，按北京时间解释）、`Tags`（逗号分隔）、`URL` 分别写入原时间/标签/链接。
- **图片**：`![](相对路径)` 引用的 zip 内图片存入 R2 并关联到笔记（attachments），正文中替换为 `【图片：xxx】`占位；外部 URL 图片保留原链接。页内 `[文本](xx.md)` 内链转为纯文本。

### Obsidian（R63）

把整个 vault 文件夹压缩为 zip 上传：

- 全量导入 `.md`（跳过 `.obsidian/`、`.trash/` 配置目录），标题取文件名。
- **frontmatter**：`tags`（支持 `[a, b]` 内联、逗号分隔、`- 列表` 三种写法）与 `created`/`date` 解析为原标签/原时间；无 frontmatter tags 时抽正文内联 `#tag`；无 created 时尝试文件名日期（如日记 `2023-06-01.md`）。
- **内链**：`[[页面]]` / `[[页面|别名]]` 保留为纯文本；`![[图片]]` 嵌入若能在 vault 内找到对应图片则存入 R2。

### Apple 备忘录（R63）

Apple 备忘录无官方批量导出；社区主流迁移路径是 Mac App Store 免费工具 **Exporter**（也兼容其他导出 md/txt 的工具）：

1. Mac 上安装 Exporter（App Store 搜 “Exporter”，免费），授权访问备忘录。
2. 导出格式选 Markdown，得到按备忘录文件夹分目录的 `.md` 文件。
3. 把导出文件夹整体压缩为 zip，在设置页选「Apple 备忘录」上传。

解析行为：`.md` / `.txt` 全量导入；frontmatter 的 `created`/`title` 优先，其次文件名末尾日期（如 `购物清单 - 2023-06-02.md`）；顶层文件夹名（即备忘录文件夹）作为标签；同包内引用的图片存入 R2。

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
- **图片资产（zip 来源）**：每条笔记最多 3 张、单张 ≤5MB、单次导入最多 100 张；超出部分仅保留 `【图片：xxx】` 占位文本。图片入库失败不影响笔记本身，会出现在 `failed_items` 清单里。
- **大包健壮性**：分批（每批 40 条）写入；`?stream=1` 时逐批回报进度；几百条的 zip 导入不超时不 OOM（zip 一次性解压在 20MB 上限内，内存可控）。
