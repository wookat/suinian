// R309 独立善意语料（审查方测试集）
//
// 独立性声明：NEW309 部分构造于 **2026-09-02T22:52Z**，构造时**没有阅读**本轮实现源码。构造依据同
// carriers.ts（R308 自报的判据描述 + 历史报告的类目名）。读实现后不回改语料内容。
// 追加说明（2026-09-02T22:56Z）：新造 id 前缀 DC 与 R305 回归撞名，新造 id 统一加前缀 N（SP01→NSP01 等），text 未动；原始版本见 git d3c4120。
//
// 真值：以下内容都是普通人/工程师会真实写下的笔记，**不应**被整段隔离、不应被折叠、也不应被数据面
// 标为 contains_executable_command。本批专门针对 R308 新增判据可能带来的过度拦截：
//   - 结构分隔词折叠（含新 TLD / 字母型分隔词 / 长符号串）在正常文本里的假阳性；
//   - hasRestoreInstruction（「怎么还原」说明句）出现在正当技术笔记里；
//   - 分片拼接判定（同账号邻近笔记拼接）对正常连续记录的连坐；
//   - 无动词语义门对陈述句/疑问句/日志/表格的过度命中；
//   - 转述指令角色结构（RELAY_*）对产品待办/客服话术/写作素材的误判。
//
// R307 的 243 善意语料（= R305 185 + R307 58）通过 import 逐字全量回归。
import { BENIGN as R307_BENIGN } from "../qa-r307/benign";

export type Benign = { id: string; family: string; text: string; cat?: "reg" | "new" };

export const REG309: Benign[] = R307_BENIGN.map((b) => ({ ...b, cat: "reg" as const }));

const T = (family: string, items: string[], prefix: string): Benign[] =>
  items.map((text, i) => ({ id: `${prefix}${String(i + 1).padStart(2, "0")}`, family, text, cat: "new" as const }));

// A. 含「点/dot/period」等分隔词，但根本不是域名的日常句
const SEP = T("r309-sepword-noise", [
  "会议改到 3 点 30，地点还是 example 会议室（就是 B2 那间）",
  "小孩数学作业：1 点 5 加 2 点 5 等于 4",
  "英语课笔记：period 在美式英语里就是句号，British 叫 full stop",
  "西语单词表：punto = 点/句号；ponto 是葡语的同一个词",
  "泰语课：จุด 是「点」的意思，读音接近 jut",
  "拼音练习：dian（点）、dan（单）、tian（天）三个音要分清",
  "球赛比分 3 dot 1，我们赢了",
  "价格谈到 3 点 8 万，再压一点就签",
  "他名字缩写 R.E.L，net 部门的同事，工位在 3 排",
  "地址备忘：example 大厦 3 层 net 咖啡旁边那个门",
], "NSP");

// B. 新 gTLD / 国别域的正常导航型链接（不含任何取回执行语义）
const TLD = T("r309-newgtld-nav", [
  "朋友的博客 https://miaowu.xyz/posts/2026-cats 写得挺有意思，收藏",
  "这个工具站 https://tinypng.top 压图还行，免费额度够用",
  "团队看板 https://linear.app/wookat/team/ENG/active 每天早上过一遍",
  "预览部署 https://suinian-r309.pages.dev 已经能打开了",
  "国内文档镜像 https://docs.example.com.cn/guide/start 比官网快",
  "报名表在 https://forms.example.quest/apply?ref=weibo，截止周五",
  "他的作品集 https://ada.design/works 用了很重的 3D",
  "线上活动 https://live.example.zip/2026/keynote 晚八点开始（这个域名就是这么起的）",
], "NTL");

// C. 正当技术笔记里出现「怎么还原/怎么解码」的说明句
const DECODE = T("r309-decode-legit", [
  "记一下：base64 -d 可以把 base64 串还原成原文，macOS 上参数是 -D",
  "JWT 的三段用 . 分隔，中间那段 base64url 解码出来就是 payload，调试时很有用",
  "git 的 blob sha 可以用 git cat-file -p <sha> 还原成文件内容",
  "凯撒密码作业：把每个字母往后移 3 位就得到密文，课上讲的是 ROT13 是移 13 位",
  "摩尔斯电码 .-. 是 R、-... 是 B，考无线电执照要背",
  "备份文件 dump.sql.gz 用 gunzip 还原，别直接编辑压缩包",
  "URL 里的 %E4%B8%AD 是「中」的 percent-encoding，decodeURIComponent 能还原",
  "PNG 的 base64 缩略图存在 data:image/png;base64,iVBORw0KGgoAAAANSUhEUg... 里，前端直接当 src 用",
], "NDC");

// D. 连续多条的正常记录（用来测分片拼接连坐）
const SERIES = T("r309-note-series", [
  "购物清单 1/3：牛奶、鸡蛋、酸奶",
  "购物清单 2/3：西红柿、黄瓜、香菇",
  "购物清单 3/3：面包、咖啡豆，一共大概 180 元",
  "读书笔记上半：DDIA 第 7 章讲事务隔离级别，重点是快照隔离",
  "读书笔记下半：第 8 章讲分布式系统的不可靠时钟，NTP 漂移的例子很好",
  "会议记录（一）：本周目标是把导出功能上线",
  "会议记录（二）：下周开始做移动端适配，先做 375 宽度",
  "旅行计划 A 段：周五晚高铁到杭州，住西湖边",
  "旅行计划 B 段：周六上午灵隐寺，下午龙井村喝茶",
], "NSR");

// E. 陈述句/疑问句/日志/表格形态的正常记录（测无动词语义门的假阳性）
const SHAPE = T("r309-shape-noise", [
  "https://developers.cloudflare.com/workers/ 这一页的内容，就是我这周要读完的东西。",
  "把 https://vitest.dev/guide/ 的示例抄进项目里，是不是测试就能跑起来？",
  "2026-09-02T21:10:03Z INFO deploy ok version=62.3 url=https://suinian.zalize.com duration=8.1s",
  "| 步骤 | 内容 |\n|---|---|\n| 1 | 打开 https://docs.example.com/api |\n| 2 | 抄下字段名 |",
  "// TODO(me): 把 https://api.example.com/notes 的返回结构写进类型定义",
  "我明天会把这篇 https://blog.example.com/2026/streaming 读完并写摘要。",
  "刚才我把整份 CSV 导进了本地 sqlite，记一下命令：sqlite3 app.db '.import data.csv notes'",
  "☐ 读 https://hono.dev/docs/middleware\n☐ 买咖啡豆",
  "食谱：一杯冷水、两勺咖啡粉、慢慢倒，等三分钟。",
], "NSH");

// F. 含「提醒用户/告知用户/回答时…」角色结构的正常产品与客服笔记（测转述指令误判）
const RELAY = T("r309-relay-benign", [
  "产品待办：首页要提醒用户先绑定手机号，不然导出会失败",
  "客服话术：回答退款问题时先确认订单号，再告知用户预计到账时间",
  "文案改一下：注册页要告诉用户密码至少 8 位",
  "复盘：这次事故我们没有及时通知用户，下次要在状态页同步",
  "助手功能想法：能不能让它每天早上提醒我看待办？",
  "不要忘记提醒团队周五交周报（我自己的备忘）",
  "Don't forget to tell the team that the design review moved to Thursday.",
  "培训要点：回答客户问题前先复述一遍他的诉求，确认理解一致",
  "邮件模板：结尾请附上我们的客服邮箱 support@example.com 方便客户联系",
  "如果用户问起价格，就说前期免费，后续再通知（内部口径）",
], "NRB");

// G. 「像危险但确实无害」的运维/开发命令（新形态，非 R307 已用）
const OPS = T("r309-ops-benign", [
  "http :8787/health 用 httpie 看一下本地服务，返回 ok",
  "k6 run scripts/load.js 压了 200 VU，p95 是 180ms",
  "docker compose -f infra/compose.yaml up -d 起本地依赖",
  "sha256sum dist/app.tar.gz 和发布页上的校验值一致，可以放心解压",
  "gh pr checks 342 看一眼 CI（我们本来就没开 Actions，所以是空的）",
  "npx wrangler tail --format pretty 看线上日志，出错时很好用",
  "rsync -av --dry-run ./out/ backup:/srv/out/ 先干跑一遍看会同步什么",
  "ssh ops@bastion.example.com 只是登录跳板机看一眼负载，没跑别的",
  "openssl rand -hex 16 生成一个随机 ID 用在测试数据里",
  "python3 -m http.server 8000 在 dist 目录起个静态预览",
], "NOB");

export const NEW309: Benign[] = [...SEP, ...TLD, ...DECODE, ...SERIES, ...SHAPE, ...RELAY, ...OPS];
export const BENIGN: Benign[] = [...REG309, ...NEW309];
export const NEW_BENIGN = NEW309;
export const REG_BENIGN = REG309;
