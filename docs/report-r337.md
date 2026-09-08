# R337 UI/视觉专项报告（设计系统 + 组件库 + 动效 + 图表 + 页面重排版）

范围：仅 `web/`（React 19 + Vite + Tailwind v4 + TS + PWA）与 `docs/`。`backend/` 与 `.github/` 零改动（`git diff main --stat -- backend .github` 为空）。

本文按「已验证 / 未验证 / 推断」分述。所有数字均为本机实测（`web/` 下 `npm run lint && npm run build && npx tsc -b`，Lighthouse 12.8.2 对 `vite preview` 产物）。

## 1. 交付物

| 项 | 位置 |
| --- | --- |
| 设计系统文档 | `docs/design-system-r337.md`（OKLCH 语义 token、亮/暗配色、AA 对比度、字体排印、间距/圆角/阴影/层级、动效、组件规范、状态规范、375px 规则） |
| 新 token 与全局样式 | `web/src/index.css` |
| shadcn/Radix 组件 | `web/src/components/ui/`：alert-dialog、dialog、dropdown-menu、popover、tooltip、tabs、sheet、command、select、switch、scroll-area、separator、label、progress、collapsible、sonner、chart、segmented、confirm-dialog、textarea、empty-state 等 |
| 动效 | `motion@13.1.1`（`LazyMotion` + `m` 组件；features 独立 chunk；`MotionConfig reducedMotion="user"`） |
| 图表 | `recharts@3.10.1`（洞察页：分类分布 / 每日记录趋势 / 活跃热力；`ChartContainer` 走 `--chart-*` token） |
| 命令面板 | `cmdk@1.1.1`（⌘K / Ctrl+K：路由、搜索、提问、速记、主题；懒加载） |
| Toast | `sonner@2.0.8`（底部居中，避开底栏；懒加载） |
| 首屏内联骨架 | `web/index.html`（对齐新外壳：顶栏/侧栏 + 卡片占位，亮/暗、reduced-motion） |
| Before/After 截图 | `docs/evidence/r337/*.jpg`（8 页 × 桌面 1280 + 移动 375 = 16 组，另附暗色/问答/引导 after 图） |
| Lighthouse 摘要 | `docs/evidence/r337/lighthouse-summary.txt` |

新依赖版本全部为发布 ≥ 7 天的稳定版（`motion@13.2.0` 因发布不足 7 天被放弃，改用 13.1.1）。`vaul`/`embla-carousel` 评估后本轮不引入（无高频移动端抽屉/轮播场景），避免无用依赖。

## 2. 页面级改动（全部走设计系统的空态 / 加载态 / 错误态）

| 页面 | 主要变化 |
| --- | --- |
| App 外壳 | 桌面 224px 常驻侧栏（品牌区 + ⌘K 搜索入口 + `layoutId` 高亮滑块）、移动顶栏 + 底部导航（`aria-current`），页面切换 `AnimatePresence`，离线/演示横幅收敛为一条细带，Skip link 保留 |
| 时间线 / 笔记卡片 | 卡片 `.surface` 层级 + hover 抬升、分类 Segmented 滑块、来源筛选改 DropdownMenu 单选组、卡片「更多」菜单 Radix DropdownMenu（破坏性项 destructive）、新建条目进出场、Sonner 轻提示 + 驻留撤销条不变 |
| 问答对话 | 消息气泡/引用卡重排、加载骨架、错误态；敏感/守值占位卡逻辑不变 |
| 线索图谱 | 图谱容器与侧栏卡片重排，图节点/边颜色改用 `--graph-*` token |
| 洞察页 | 统计卡 + Recharts 图表（Tooltip 走 popover 样式）、标签云 chip 补 44px 触控（`.hit-44`） |
| 报告页 | 周报/月报 Radix Tabs、统计卡、空态 |
| 设置页 | 分区卡片 + Label/Input/Switch/Select 统一，账号区（注册登录 / 复制 token / 轮换 / 重新生成恢复码 / 退出登录）与所有确认对话框语义不变 |
| 登录注册 / 恢复码 | 居中卡片 + 品牌区、字段 Label、错误 `role="alert"`；恢复码「输入末 4 位确认」门禁不变 |
| Onboarding / First-run | Radix Dialog（Esc / 外点均 `preventDefault`，不可绕过）、Progress 步进、方向滑动 |
| 待办 / 回收站 | 列表卡片、Collapsible 已完成区、空态；清空/永久删除走 AlertDialog |

## 3. 硬约束核对

### 3.1 后端与安全语义（已验证：代码级逐项对照）

- `backend/`、`.github/` 无 diff；API 调用与契约（`web/src/lib/api.ts`）未变。
- 敏感占位 / 折叠 / 展开取回、code 复制前确认（`COPY_CONFIRM`）、`ExecGuard`、`content_withheld` 占位体：仅换外观容器，判断逻辑与文案原样保留。
- 破坏性操作（删除、清空回收站、注销、轮换 token、重新生成恢复码）全部经 Radix AlertDialog 确认，确认键 destructive 且默认聚焦。
- 恢复码确认：`verified = confirmed || last4 匹配`，完成按钮 `disabled={!verified}`。
- Onboarding / FirstRunTour 不可通过 Esc 或点击遮罩关闭。

### 3.2 无障碍（已验证）

- 对比度：用 OKLCH→线性 sRGB 的脚本对亮/暗全部文字前景-背景 token 组合（foreground/muted/secondary/accent/primary/destructive/success/warning/info × background/card/浅底）逐项计算，全部 ≥ 4.5:1。这轮修了一项暗色遗留问题：暗色 destructive 文字在 `bg-destructive/10` 上仅 4.3:1（main 上已存在），新增 `--destructive-soft` token（亮 10% / 暗 6%）统一错误气泡/徽标/菜单破坏性项底色，暗色下 5.10:1。
- 焦点环：所有可聚焦控件 `focus-visible` 3px ring；Radix 弹层自带焦点圈定、Esc、`aria-*`。
- Lighthouse Accessibility 移动/桌面 Before 100 → After 100。
- Reduced motion：全局 CSS 媒体查询 + `MotionConfig reducedMotion="user"`，首屏骨架同样禁用脉冲动画。

### 3.3 移动端 375px（已验证：`qa-r337/a11y-check.mjs`，coarse pointer）

- 8 个页面横向溢出全部 0px。
- 交互元素触控命中区：按钮 / `role=button` / `role=checkbox` 由全局 `::after` 规则扩到 ≥44px；非按钮的标签 chip 链接加 `.hit-44`。脚本仍报的「<44px」项为：视觉隐藏的 Skip link（24×16，仅键盘可见，与 main 一致）与表单 `<input>` 视觉高 36px（与 main 上 `h-9` 相同，未变化；输入框的触控区靠整行 Label + 输入组合，非本轮引入）。

### 3.4 本地全绿（已验证）

```
web$ npm run lint      # exit 0（仅既有 warning）
web$ npx tsc -b        # 通过
web$ npm run build     # 通过
```

## 4. Bundle 体积（vite build 产物，Before = main @6bad5dd）

| 指标 | Before | After | 变化 |
| --- | --- | --- | --- |
| CSS | 62.28 kB / gzip 11.49 | 100.19 kB / gzip 16.90 | +5.4 kB gzip |
| 首屏入口 JS `index-*.js` | 335.49 kB / gzip 105.66 | 424.13 kB / gzip 136.19 | +30.5 kB gzip |
| 首屏关键 JS 合计（`index.html` modulepreload 的全部 chunk） | ≈133 kB gzip | 182.8 kB gzip | +≈50 kB gzip |
| 全部 JS chunk 合计 | 622.95 kB / gzip 208.23 | ≈1326 kB / gzip ≈429 | +≈220 kB gzip（其中 insights 页 recharts chunk 411.77 kB / gzip 118.4，按路由懒加载） |
| PWA precache | 22 entries / 712.35 KiB | 38 entries / 1438.35 KiB | +726 KiB（含懒加载 chunk，首屏不下载） |

首屏增量来源（推断，按依赖体积估算，未逐字节归因）：Radix Dialog（Onboarding 门禁）+ DropdownMenu/Popper（卡片菜单）、motion 核心运行时（`m` 组件 + `AnimatePresence` + `LazyMotion`）、新页面结构与更多 lucide 图标，以及 CSS +5.4 kB gzip。已做的削减（已验证，产物 chunk 实测）：`LazyMotion` 把 `domMax` features 拆为独立 chunk（27.3 kB gzip，首屏不阻塞）；cmdk 命令面板（6.4 kB gzip）与 sonner 改为空闲/首次交互时加载；时间线来源筛选由 Radix Select 改为复用已在首屏的 DropdownMenu，避免再引入一套 Radix Select 运行时。

## 5. Lighthouse（12.8.2，本机 `vite preview`，全新 profile → 首屏为 Onboarding 门禁）

| 场景 | Before | After |
| --- | --- | --- |
| Mobile（默认 simulate 节流） | Perf **99** / A11y 100 / BP 100 / SEO 100（FCP 1.7s, LCP 2.0s, TBT 20ms, CLS 0） | Perf **93** / A11y 100 / BP 100 / SEO 100（FCP 2.3s, LCP 2.7s, TBT 60–110ms, CLS 0；3 次取样 92–93） |
| Desktop（simulate） | Perf 100 / 100 / 100 / 100（FCP 0.4s, LCP 0.5s） | Perf 100 / 100 / 100 / 100（FCP 0.5s, LCP 0.7s） |
| Mobile（devtools 真实节流，补充对照） | Perf 95（FCP 2.3s, LCP 2.4s, TBT 0） | Perf 87（FCP 1.5s, LCP 3.0s, TBT 270–310ms） |

**结论（实事求是）**：A11y / Best Practices / 桌面 Performance 全部持平；**移动 Performance 未达到「不低于现状」**（simulate 99→93，devtools 95→87）。CLS 保持 0。

原因（一手归因）：
1. 移动端 simulate 模式下 FCP/LCP 几乎完全由首屏 JS 字节决定（LCP 元素两次都是 Onboarding 对话框中的安全承诺段落，Render Delay 1.5s→2.3s），首屏关键 JS +≈50 kB gzip（见 §4）。
2. devtools 模式 TBT 由一段 ≈300ms（4× CPU 降速）长任务贡献（Before 最长 149ms）：Lighthouse main-thread 拆解为脚本执行 414ms vs 276ms、样式/布局 334ms vs 206ms；采样 profile 中入口 chunk ≈371ms、motion features ≈53ms，其余在 card/Radix chunk。即首屏 React 树更大（Dialog 门禁 + 新外壳）与更多 CSS 规则带来的一次性首帧成本，非脚本死循环。
3. 内联骨架文字已让「观测 FCP」提前到 74ms（Before 140ms），但 Lantern 模拟仍把所有首屏脚本算进 FCP 依赖，故 simulate 数字未改善；真实用户（devtools 模式）FCP 已从 2.3s 降到 1.5s。

已尝试且保留的优化见 §4；未采用的方案及取舍：
- 把 Onboarding 对话框懒加载：会把 LCP 元素推得更晚，得不偿失（推断，未实测）。
- 首屏不用 motion（纯 CSS 过渡）：可省 ≈12 kB gzip + 一次 features 加载，但与本轮「页面过渡 / 列表进出场 / layoutId 滑块」目标冲突。
- 卡片菜单 DropdownMenu 按需加载：可省 ≈15 kB gzip，但需要在触发按钮上做「先加载再打开」的替身，复杂度与回归风险高，建议下一轮单独评估。

需父会话裁定：接受移动 Performance 93（桌面 100、A11y/BP 100、CLS 0）作为本轮引入 Radix/motion 的代价，或要求继续降到 ≥99（现实上需放弃首屏 motion 与 Radix Dialog 门禁之一）。

## 6. 未验证事项

- 生产（Cloudflare Pages，brotli + HTTP/3）上的 Lighthouse 与真实设备体感——待合并部署后由 `testing_agent` 走查并补录屏。
- 真实后端下的完整交互回归（本轮所有截图与脚本走的是 `useMock=true` 演示数据）。
- Android WebView / iOS Safari 的 `backdrop-filter` 与安全区表现。

## 7. 复现命令

```
cd web && npm ci && npm run lint && npx tsc -b && npm run build && npx vite preview --port 4173
CHROME_PATH=… npx lighthouse@12.8.2 http://localhost:4173/ --output=json            # mobile simulate
CHROME_PATH=… npx lighthouse@12.8.2 http://localhost:4173/ --preset=desktop --output=json
CHROME_PATH=… npx lighthouse@12.8.2 http://localhost:4173/ --throttling-method=devtools --output=json
```
