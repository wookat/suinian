# R334 生产浏览器复验 — fdbf876

执行时间：2026-09-08 13:48–13:55 UTC。通过最大化 Chrome 的生产 UI 执行，复用 `[QA-R334]browser-7goq`（`u_718775d19cd1`）及既有十条笔记。首页「问答」先点击「清空对话」并确认「清空」，再依次提交 Q11/Q12、严格围巾问题；随后仅通过「快速记录」新增一条指定电话笔记，等待分拣后提问。最终答案均在取消/加载状态结束、角标成为可点击按钮后检查。Q11 与 Q12 间隔超过 5 秒。

**已执行本轮 A–E 流程。核心长答、引用定位、原文答案、普通电话直答及文案检查通过；围巾的独立折叠说明最初与预期有冲突，经 lead 明确为按设计后按通过记录。以下保留观察和覆盖限制，不把此次单次采样当成全矩阵验证。**

## 观察与限制

- 围巾答案确为原文，不再追加「原文请点开引用的笔记卡片查看。」；Web 仍显示独立、默认折叠的「关于原文回显的说明」。录屏先有失败标注，随后有澄清后的通过标注：lead 确认它是 intentional `<details>` disclosure，不是答案的一部分，要求 B 记 PASS + observation。本报告采用澄清后的判据，并非声称该 UI 消失。曾展开查看后继续测试。
- Q11 展览卡的既有元数据仍为「临期 09-08 14:30」，正文没有展览日期。**Q11 答案没有复述或新增该日期**；本轮未重新分拣验证该既有元数据。
- `/health?probe=ai` 为 `degraded:true`，只证明降级可用性，不代表主模型健康。本轮未独立验证主模型 530，也没有逐问模型名。
- Q11 取得真实 done 前**部分答案正文 + 取消 + spinner**截图。该正文尚非最终收口内容，不能用中间态缺少牙科事实判最终失败；最终答案与三卡另验。本轮未统计 SSE delta 数量，未另取 Q12 pre-done 截图。
- 每题仅一次；没有重跑前一 c50eaba 轮的三条单问回归，未验证 MCP 实际调用、全部敏感安全矩阵或其他账号。Known-issues 是文案可见性检查，不是逐项验证安全承诺。注册页未另测，本轮采用设置页安全承诺。
- 新电话卡已经显示「资料 / #电话」和完整正文，未显示敏感标记或遮罩，未手动改变敏感状态；随后问答直接返回号码。新增后辅助统计短暂仍显示原 10 条，本轮未专门验证统计刷新。

## 身份与健康

浏览器上下文读取页面 meta，并 fetch 生产 API 的两个 health 地址：

| 检查 | 实测 | 结果 |
|---|---|---|
| `https://suinian.zalize.com` 的 `<meta name="build">` | `fdbf876e9de8224cc108897a7cfc4f06ec3b6cab` | 通过 |
| `https://suinian-api.zalize.com/health` | `{"ok":true,"build":"fdbf876e9de8224cc108897a7cfc4f06ec3b6cab"}` | 通过 |
| `https://suinian-api.zalize.com/health?probe=ai` | `{"ok":true,"ai":{"ok":true,"degraded":true}}` | 已记录降级，不宣称主模型通过 |

## A — Q11

问题逐字：

> 请根据我记的青禾牙科、蓝鲸读书会和星河展览，分别用三段说明每个活动的具体时间地点，并在每段末尾标引用。每段先说已记下的事实，再用一句话区分笔记没有提供的信息，不要补造。

最终答案（将 UI 角标转记为 `[n]`，其余文字按可见内容）：

> 青禾牙科的复诊时间是2026-09-12下午三点，地点在青禾牙科。笔记中没有提供青禾牙科的详细地址或联系方式 [1]。
>
> 蓝鲸读书会的活动时间是周六上午十点，地点在湖畔书店。笔记中没有提供蓝鲸读书会的具体活动内容或参加人员信息 [2]。
>
> 星河展览的预约场次是下午两点半，入口在东门。笔记中没有提供星河展览的详细展览内容或展览结束时间信息 [3]。

**通过：3 角标 / 3 卡**。顺序：1 青禾牙科、2 蓝鲸读书会、3 星河展览；三组关键事实完整，没有省略占位、虚假没找到、用点卡片提示替代事实或新增展览日期。

| Q11 最终答案 | Q11 对位引用卡 |
|---|---|
| ![Q11 最终答案](https://app.devin.ai/attachments/2464eac2-241f-4cfa-85fa-a94d91b28250/fdb-q11-answer.png) | ![Q11 三卡](https://app.devin.ai/attachments/4e31480e-3def-40fd-b9d6-afcc71d09abe/fdb-q11-cards.png) |

## A — Q12 与引用交互

问题逐字：

> 请根据我记的栀子花浇水、烘焙课堂司康和海鸥跑团，分别用三段整理每项的数量和单位。每段先说事实，再解释这个数字对应什么，附上引用。不要添加笔记没有的数据。

最终答案：

> 栀子花浇水的数量是250毫升。这个数字对应栀子花每周三浇水的量 [1]。
>
> 烘焙课堂司康需要的黄油是80克，牛奶是120毫升。这些数字分别对应司康制作所需的黄油和牛奶的量 [2]。
>
> 海鸥跑团的训练路线是六公里。这个数字对应海鸥跑团训练路线的长度 [3]。

**通过：3 角标 / 3 卡**。顺序：1 栀子花、2 司康、3 跑团；250 毫升、80 克、120 毫升、六公里均完整。没有省略或「没找到海鸥跑团」。跑团正文卡保留「沿江绿道往返六公里」；答案以「六公里」表达该路线长度。

**引用交互通过：**done 后点击 Q12 `[2]`，页面滚动到对应司康卡，出现绿色 ring 高亮。

| Q12 最终答案 | Q12 三卡 |
|---|---|
| ![Q12 最终答案](https://app.devin.ai/attachments/35951e8c-fa8a-4745-94b2-44446e04658d/fdb-q12-answer.png) | ![Q12 三卡](https://app.devin.ai/attachments/32167a91-81cb-4950-b69c-dcf1792a3f1e/fdb-q12-cards.png) |

| Q11 pre-done 部分正文 | Q12 点击引用 2 后 |
|---|---|
| ![Q11 streaming 正文与取消按钮](https://app.devin.ai/attachments/4cf50604-2dce-4437-acec-faeb586eed1e/fdb-q11-predone.png) | ![司康卡定位高亮](https://app.devin.ai/attachments/35dd5c91-1ae6-42e6-bd73-a7a180394c82/fdb-q12-highlight.png) |

## B — 严格围巾原文

问题：`把我记的山茶色围巾那条笔记原文一字不改地发给我`

最终答案：

> 山茶色围巾放在衣柜第二层的白色收纳盒。 [1]

**通过（按 lead 澄清）：1 角标 / 1 对应卡**，直接原文，无答案尾部点卡片指引。独立「关于原文回显的说明」折叠控件仍在，按设计观察保留。

## C — 一条普通电话笔记

仅新增一次：`[QA-R334] 爸爸的电话 13987654321`。UI 保存后等待分拣，卡片标题「爸爸的电话」，分类「资料」、标签 `#电话`，正文可见，无自动敏感标记。没有取消敏感或编辑该笔记。

问题：`爸爸的电话号码是多少`

最终答案：

> 爸爸的电话号码是13987654321 [1]

**通过：1 角标 / 1 对应卡**。直接返回号码，没有点卡片才能查看的占位。

| 围巾精确原文与独立说明 | 电话直接答案与对应卡 |
|---|---|
| ![围巾答案](https://app.devin.ai/attachments/aef6cf2c-8e54-43c5-b6c1-8b754dcfafee/fdb-scarf.png) | ![电话直答](https://app.devin.ai/attachments/9c8bce19-2a67-432c-a006-2e22320d289d/fdb-phone-answer.png) |

## D — 安全承诺与 known-issues

**通过：**设置页安全承诺首句逐字一致，DOM 可见文本中出现一次：

> 已标注敏感的笔记正文不进入 AI 回答；未标注 / 已取消标注的内容视为普通笔记，可能被 AI 转述、编码或计算。

**通过：**`https://suinian.zalize.com/known-issues` 三个 R334 表格条目可见：MCP `notes[]` 对取消标注的口令类笔记/元数据行为、编号类善意笔记扣留及电话确定性自动标敏感规则移除、多笔记长答省略/没找到。通过滚动分别截图。

| 电话完成分拣 | 设置安全承诺 |
|---|---|
| ![普通电话卡](https://app.devin.ai/attachments/3869ad11-eb3d-4450-85e1-df37f3fe8984/fdb-phone-triaged.png) | ![安全承诺](https://app.devin.ai/attachments/65f1930b-b60f-408b-8754-e5a53ded746f/fdb-safety.png) |

| R334 MCP 与编号条目 | R334 长答条目 |
|---|---|
| ![MCP 与编号](https://app.devin.ai/attachments/5bdc4baf-4d79-4365-a304-a2549573f737/fdb-known-mcp-number.png) | ![长答省略](https://app.devin.ai/attachments/2fb1a066-3adf-45bb-97b9-06b5be5e0c1e/fdb-known-long-answer.png) |

## 保留状态与交付物

未注册新账号、未删除账号或笔记、未操作其他账号。原十条及新增一条电话笔记均保留，等待统一 cleanup。没有导出、轮换或展示实际凭据。安全承诺截图中的示例为产品公开文案，不是 QA 凭据。无新增用户凭据/权限请求。

报告：
`/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/test-report.md`

录屏：
`/home/ubuntu/screencasts/r334-fdbf876-retest/r334-fdbf876-retest-edited.mp4`

关键截图绝对路径：

```text
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q11-answer.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q11-cards.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q11-predone.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q12-answer.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q12-cards.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-q12-highlight.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-scarf.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-phone-triaged.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-phone-answer.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-safety.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-known-mcp-number.png
/home/ubuntu/repos/suinian/backend/scripts/qa-r334/browser/fdb-known-long-answer.png
```
