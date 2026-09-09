# 碎念 设计系统 R337

> 目标：一套现代、克制、可维护的视觉语言，让「随手丢进来的碎片」看起来井井有条。参考 Linear（低噪声、层级靠留白）/ Notion（阅读友好排版）/ Arc（柔和的品牌渐变与动效）。实现全部落在 `web/src/index.css`（token）+ `web/src/components/ui/*`（primitive），页面只消费语义 class，不写裸色值。

## 0. 原则

1. **语义 token，不写裸色**：页面里只允许 `bg-card / text-muted-foreground / border-warning/30` 这类语义 class，禁止 `text-amber-700`、`#hex`。暗色模式由 token 自动切换。
2. **层级靠留白与细边，不靠重阴影**：卡片 `surface` = 1px 边 + `shadow-xs`；hover 才抬到 `shadow-md`。弹层用 `shadow-lg/xl`。
3. **一种圆角尺度**：`--radius: 0.75rem`，派生 xs→2xl，卡片 lg、按钮 lg、输入 lg、弹层 2xl、chip/badge full。
4. **动效是反馈，不是装饰**：150–250ms，`--ease-out-quart`；进出场位移 ≤ 8px；全局尊重 `prefers-reduced-motion`（CSS 兜底 + `<MotionConfig reducedMotion="user">`）。
5. **AA 是硬约束**：所有 前景/背景 语义组合经 `qa-r337/contrast.mjs` 校验 ≥ 4.5:1（正文）/ 3:1（大字、图形）。
6. **安全语义不因观感让步**：敏感占位、折叠、复制确认、破坏性确认（AlertDialog）只换皮，不换流程。

## 1. 配色体系（OKLCH）

所有颜色以 OKLCH 定义（感知均匀，同色相调亮度即可得到明暗态），通过 `@theme inline` 映射为 Tailwind `--color-*`。

### 1.1 品牌主色

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--primary` | `oklch(0.49 0.11 172)` 深青绿 | `oklch(0.76 0.11 172)` | 主按钮、激活态、链接、焦点 |
| `--primary-foreground` | `oklch(0.99 0 0)` | `oklch(0.17 0.03 172)` | 主按钮文字 |
| `--accent` | `oklch(0.95 0.02 172)` | `oklch(0.29 0.03 172)` | hover 底、选中项底 |
| `--accent-foreground` | `oklch(0.29 0.06 172)` | `oklch(0.86 0.08 172)` | accent 上文字/图标 |
| `--ring` | `oklch(0.55 0.11 172)` | 同 primary | 焦点环 |

品牌渐变（Logo/BrandMark/欢迎页光晕）：`from-primary to-color-mix(in oklch, primary 70%, chart-2)`，即青绿→蓝的低饱和过渡。

### 1.2 中性灰阶（色相 250–262，带一点冷调）

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | `oklch(0.984 0.003 250)` | `oklch(0.165 0.008 262)` |
| `--card` | `oklch(1 0 0)` | `oklch(0.205 0.009 262)` |
| `--popover` | `oklch(1 0 0)` | `oklch(0.225 0.009 262)` |
| `--secondary` | `oklch(0.962 0.004 250)` | `oklch(0.255 0.009 262)` |
| `--muted` | `oklch(0.955 0.005 250)` | `oklch(0.25 0.009 262)` |
| `--border` | `oklch(0.915 0.006 250)` | `oklch(0.285 0.01 262)` |
| `--input` | `oklch(0.9 0.006 250)` | `oklch(0.31 0.01 262)` |
| `--foreground` | `oklch(0.21 0.015 260)` | `oklch(0.94 0.005 250)` |
| `--muted-foreground` | `oklch(0.49 0.018 255)` | `oklch(0.73 0.012 255)` |

层级由浅到深（Light）：background < muted ≈ secondary < card = popover。暗色反向：background 最深，card / popover 逐级提亮（elevation = 亮度）。

### 1.3 语义色

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--destructive` | `oklch(0.55 0.2 25)` | `oklch(0.72 0.17 25)` | 错误文字、删除、过期 |
| `--destructive-soft` | destructive 10% 叠透明 | destructive 6% 叠透明 | 错误气泡 / destructive 徽标 / 菜单破坏性项 hover 底色；不要手写 `bg-destructive/10`（暗色 10% 仅 4.3:1） |
| `--success` | `oklch(0.5 0.13 155)` | `oklch(0.75 0.13 155)` | 已完成、已开启 |
| `--warning` | `oklch(0.55 0.14 70)` | `oklch(0.8 0.13 75)` | 提醒、今天到期、迁移提示 |
| `--info` | `oklch(0.52 0.14 250)` | `oklch(0.75 0.12 250)` | 中性提示、更晚到期 |

用法约定：
- 文字/图标：`text-{semantic}`；
- 浅底容器：`bg-{semantic}/10 border-{semantic}/30`（Badge 用 `/12`–`/14`）；destructive 浅底统一 `bg-destructive-soft`；
- 实底只允许 primary 与 destructive 按钮。暗色下 `--destructive` 对白字仅 3.4:1，所以 `Button variant="destructive"` 在 dark 显式压到 `red-700` 保证 AA。

### 1.4 图表色（Recharts）

`--chart-1..5`：青绿 172 / 蓝 250 / 琥珀 70 / 紫 320 / 珊瑚 20，亮度统一 0.62–0.72（Light）/ 0.72–0.78（Dark），保证同一图内明度一致、彼此色相相距 ≥ 50°。图谱实体色 `--color-graph-*` 同理。

### 1.5 暗色模式

- 通过 `.dark` class（`@custom-variant dark (&:is(.dark *))`）+ `color-scheme: dark`。
- 不是简单反色：主色提亮到 0.76 并降低前景亮度，避免 dark 上刺眼；阴影改为纯黑高透明 + 1px 内描边 `oklch(1 0 0 / 0.03–0.06)` 模拟边缘光。
- 主题切换在设置页（Segmented：浅色 / 深色 / 跟随系统），`lib/theme.ts` 持久化。

## 2. 字体排印

### 2.1 字体栈（中文优先）

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "SF Pro SC", "PingFang SC",
  "HarmonyOS Sans SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
```

系统字体不加载 webfont（PWA 首屏与 Lighthouse 优先）；代码/token/恢复码用 `font-mono`。

### 2.2 字号 / 行高 / 字重层级

| 级别 | class | 尺寸 | 行高 | 字重 | 用途 |
| --- | --- | --- | --- | --- | --- |
| Display | `text-display text-xl/2xl` | 20–24px | 1.25 | 600 | 页头标题、欢迎页 |
| Title | `text-display text-lg` | 18px | 1.3 | 600 | 卡片主标题、弹层标题 |
| Heading | `text-[15px] font-semibold` | 15px | 1.375 | 600 | CardTitle |
| Body | `text-sm` / 默认 | 14–16px | **1.65** | 400 | 正文（body 全局 `line-height: 1.65`） |
| Caption | `text-xs` | 12px | 1.5 | 400/500 | 辅助说明、时间戳 |
| Overline | `text-xs uppercase tracking-wider font-semibold text-muted-foreground` | 12px | — | 600 | 分组小标题（设置分组、待办分组） |
| Micro | `text-[11px]` | 11px | 1.4 | 400 | 页脚、渠道说明 |

### 2.3 中文排版优化

- `line-height: 1.65`：中文方块字需要比西文更大的行距。
- `.text-display { letter-spacing: -0.02em; text-wrap: balance }`：标题紧字距 + 平衡换行，避免孤字。
- `hanging-punctuation: allow-end`、`overflow-wrap: anywhere`：标点悬挂与长 URL/token 换行。
- 数字一律 `tabular-nums`（`.nums` / `tabular-nums`）——计数、金额、进度对齐。
- 中英文之间由文案层加空格（「API token」「Cubox 速记」），不用 CSS hack。
- 段落宽度上限 `max-w-prose`/`max-w-sm`，单行 ≤ 40 汉字。

## 3. 间距 / 圆角 / 阴影 / 层级 token

### 3.1 间距（Tailwind 4pt 基线）

| 场景 | 值 |
| --- | --- |
| 图标与文字 | `gap-1.5`（6px）/ `gap-2`（8px） |
| 控件内边距 | 按钮 `px-4 h-9`，输入 `px-3 h-9`，Badge `px-2 py-0.5` |
| 卡片内边距 | `p-4`（列表卡）/ `p-5 sm:p-6`（表单卡、弹层） |
| 卡片间距 | `space-y-3`（列表）/ `space-y-6`（分组） |
| 页面边距 | 移动 `px-4`，桌面 `px-6`；主内容 `max-w-2xl`（阅读页）/ `max-w-5xl`（洞察） |
| 页头到内容 | `mb-6` |
| 底部安全区 | `pb-[calc(env(safe-area-inset-bottom)+5rem)]`（底栏遮挡） |

### 3.2 圆角

`--radius: 0.75rem` → `xs 6px · sm 8px · md 10px · lg 12px · xl 16px · 2xl 20px · full`。
控件 `rounded-lg`，小控件/菜单项 `rounded-md`，卡片 `rounded-lg`（`.surface`），弹层/抽屉 `rounded-2xl`，图标容器 `rounded-xl`，Badge/Segmented 指示 `rounded-full/md`。

### 3.3 阴影（Light）

| Token | 用途 |
| --- | --- |
| `--shadow-xs` | 静止卡片、输入框 |
| `--shadow-sm` | 按钮、Segmented 激活片 |
| `--shadow-md` | 卡片 hover、Popover、DropdownMenu |
| `--shadow-lg` | Sheet、Command |
| `--shadow-xl` | Dialog、AlertDialog |

Dark 下全部替换为高透明黑 + 1px 内描边，见 1.5。

### 3.4 层级（z-index）

| 层 | z | 组件 |
| --- | --- | --- |
| 内容 | 0 | 页面 |
| 粘性 | 10–20 | 顶栏、页头、底栏 |
| 悬浮 | 30–40 | 速记浮条、回到顶部、离线横幅 |
| 弹层 | 50 | Dialog / AlertDialog / Sheet / Popover / DropdownMenu / Tooltip / Command |
| Toast | 100 | Sonner |

## 4. 动效 token

- 时长：微交互 150ms · 进出场 180–250ms · 布局 layout spring（stiffness 500 / damping 40）。
- 缓动：`--ease-out-quart: cubic-bezier(0.25,1,0.5,1)`（默认）、`--ease-spring`（Segmented 指示、FAB）。
- 页面切换：`AnimatePresence mode="wait"`，`opacity 0→1, y 6→0`。
- 列表：`motion.div layout` + `initial {opacity:0,y:8}` + `exit {opacity:0,scale:.98}`；`AnimatePresence initial={false}` 避免首屏整列闪动。
- 骨架屏：`animate-pulse`；进度用 Radix Progress 平滑过渡。
- 引导/多步：横向 `x ±24` 滑动，方向由 step 差决定。
- Reduced motion：`@media (prefers-reduced-motion: reduce)` 全局把 animation/transition 压到 0.01ms；Motion 使用 `MotionConfig reducedMotion="user"` 自动禁用位移。

## 5. 组件规范（`web/src/components/ui`）

| 组件 | 基座 | 规范要点 |
| --- | --- | --- |
| Button | Radix Slot + cva | 变体 default/secondary/outline/ghost/link/destructive；尺寸 sm 32 / default 36 / lg 44 / icon 36；`active:scale-[0.98]`；焦点环 `ring-2 ring-ring ring-offset-2` |
| Input / Textarea | 原生 | 高 36，`border-input bg-card shadow-xs`，focus `ring-[3px] ring-ring/25 border-ring`；无效态 `aria-invalid:border-destructive` |
| Label | Radix Label | `text-sm font-medium`，`peer-disabled` 降透明 |
| Card | div | `.surface`；`interactive` 时 `.surface-hover` + `role="button"` + Enter/Space |
| Badge | cva | 圆角 full，语义变体 default/secondary/outline/success/warning/info/destructive |
| Segmented | 自研（role=radiogroup） | Motion `layoutId` 滑块，←→ 键切换，coarse pointer 下由全局规则补足 44px 触控 |
| Tabs | Radix Tabs | 页面级分段（周报/月报） |
| Switch | Radix Switch | 开关类设置；Checkbox 仅保留多选/确认语义（敏感导出确认） |
| Select | Radix Select | 下拉选择，Popover 层 `shadow-md` |
| DropdownMenu | Radix | 卡片「更多」菜单；破坏性项 `text-destructive` |
| Popover / Tooltip | Radix | Tooltip 延迟 250ms，仅补充信息不承载操作；Popover 原语已就位，页面暂未接入 |
| Dialog | Radix Dialog | `max-w-lg rounded-2xl p-6 shadow-xl`；Onboarding / FirstRunTour 为不可关闭门禁（Esc/外点 preventDefault） |
| AlertDialog / ConfirmDialog | Radix AlertDialog | 所有破坏性操作（删除、清空回收站、注销、轮换 token）统一入口，确认键 destructive 且默认聚焦 |
| Sheet | Radix Dialog | 侧滑面板（右侧 / 底部，含安全区）；本轮已提供原语但页面暂未接入。Vaul 抽屉评估后本轮不引入（无高频移动端抽屉场景），需要时再加 |
| Command | cmdk | ⌘K / Ctrl+K 命令面板：路由、搜索、提问、速记、主题 |
| Sonner | sonner | 底部居中 Toast（避开底栏 88/96px），同一时刻仅一条；撤销类持久 UI 不走 Toast；库按需加载，不进首屏 |
| Progress | Radix Progress | 导入、重建、引导进度，`h-1`–`h-1.5` |
| Collapsible | Radix Collapsible | 已完成待办、长内容折叠 |
| ScrollArea / Separator | Radix | 原语已就位（侧栏、长列表弹层备用），页面暂未接入；未使用的原语不进产物 |
| Skeleton | div | `NoteListSkeleton` 等页面级骨架 |
| Chart | Recharts + ChartContainer | 使用 `--chart-*`，Tooltip 走 popover 样式 |
| EmptyState | Motion | 虚线边框 + 顶部径向品牌光晕 + 图标容器 + 最多三个动作 |

### 5.1 状态规范

- **空态**：统一 `EmptyState`（图标 / 一句话标题 / 一行说明 / 主次动作）。
- **加载态**：列表用骨架屏，按钮内用 `Loader2 animate-spin` 并 `disabled`。
- **错误态**：`role="alert"`，`border-destructive/30 bg-destructive/5 text-destructive`（或 `bg-destructive-soft`）容器，可重试给 EmptyState 动作。
- **提示态**：`role="status"`，warning/info 浅底容器。

### 5.2 无障碍

- 触控目标 ≥ 44px（coarse pointer 全局规则 + 控件最小高）。
- 每个可交互元素有可见焦点环；Radix 弹层自带焦点陷阱与 Esc。
- 语义地标：`aria-current`、`role="radiogroup"`、`aria-live` 进度、`aria-label` 分组。
- 对比度：正文 ≥ 4.5:1，大字/图标 ≥ 3:1（`qa-r337/contrast.mjs`）。

## 6. 页面布局

- App shell：桌面左侧栏 `w-56` + 主区 + 右栏（≥ xl）；移动端顶栏 + 底部 5 项导航（44px 触控，`aria-current`）。
- 页头 `PageHeader`：标题 Display + 描述 Caption + 右侧动作区。
- 阅读类页面 `max-w-2xl`，仪表类 `max-w-5xl`，表单类 `max-w-sm mx-auto`。
- 375px：单列、所有横向 flex 在必要处 `flex-wrap`/`flex-col sm:flex-row`，禁止横向溢出。
