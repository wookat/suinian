import type { Category, Env, TriageResult } from "./types";
import { chatComplete } from "./ai";

const CATEGORIES: Category[] = ["idea", "todo", "collect", "data", "expense", "income", "transfer"];

export const FALLBACK_TRIAGE: TriageResult = {
  category: "idea",
  tags: [],
  title: "",
  is_sensitive: false,
  todo_due: null,
  amount: null,
  currency: null,
  merchant: null,
};

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const DEFAULT_TZ = "Asia/Shanghai";

/** True when `tz` is a valid IANA timezone identifier. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** UTC offset of `tz` at instant `now`, as "+HH:mm" / "-HH:mm". */
export function tzOffsetString(now: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
  const name = dtf.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT+08:00";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return "+08:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}`;
}

export function tzOffsetMs(now: Date, tz: string): number {
  const off = tzOffsetString(now, tz);
  const sign = off.startsWith("-") ? -1 : 1;
  const [h, min] = off.slice(1).split(":").map(Number);
  return sign * (h * 60 + min) * 60_000;
}

/** UTC offset of `tz` at `now` in whole minutes east of UTC. */
export function tzOffsetMinutes(now: Date, tz: string): number {
  return Math.round(tzOffsetMs(now, tz) / 60_000);
}

/** SQLite datetime() modifier shifting UTC into `tz` local time, e.g. "+480 minutes". */
export function tzSqlModifier(now: Date, tz: string): string {
  const mins = tzOffsetMinutes(now, tz);
  return `${mins >= 0 ? "+" : ""}${mins} minutes`;
}

/** The user's IANA timezone (browser-reported, stored in preferences); Asia/Shanghai when unset. */
export async function loadUserTz(env: Env, userId: string): Promise<string> {
  try {
    const row = await env.DB.prepare("SELECT tz FROM user_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ tz: string | null }>();
    return row?.tz && isValidTimezone(row.tz) ? row.tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Date in timezone `tz` (offset by `offsetDays`) as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function zonedDate(now: Date, tz: string, offsetDays = 0): { iso: string; weekday: string } {
  const local = new Date(now.getTime() + tzOffsetMs(now, tz) + offsetDays * 86400_000);
  return { iso: local.toISOString().slice(0, 10), weekday: WEEKDAYS_ZH[local.getUTCDay()] };
}

/** Date in Asia/Shanghai (offset by `offsetDays`) as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function shanghaiDate(now: Date = new Date(), offsetDays = 0): { iso: string; weekday: string } {
  return zonedDate(now, DEFAULT_TZ, offsetDays);
}

/** Current date in Asia/Shanghai as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function todayInShanghai(now: Date = new Date()): { iso: string; weekday: string } {
  return shanghaiDate(now, 0);
}

/** Date of 下周一 (next week's Monday) in timezone `tz`. */
export function nextMondayIn(now: Date, tz: string): { iso: string; weekday: string } {
  const dow = new Date(now.getTime() + tzOffsetMs(now, tz)).getUTCDay();
  const days = (8 - dow) % 7 || 7;
  return zonedDate(now, tz, days);
}

/** Date of 下周一 (next week's Monday) in Asia/Shanghai. */
export function nextMondayInShanghai(now: Date = new Date()): { iso: string; weekday: string } {
  return nextMondayIn(now, DEFAULT_TZ);
}

/** A past note whose category the user set or corrected by hand. */
export type CategoryCorrection = { content: string; category: Category };

/** Build the triage system prompt. Exported for testing. */
export function buildTriagePrompt(
  now: Date = new Date(),
  existingTags: string[] = [],
  tz: string = DEFAULT_TZ,
  corrections: CategoryCorrection[] = []
): string {
  const { iso, weekday } = zonedDate(now, tz, 0);
  const tomorrow = zonedDate(now, tz, 1);
  const nextMon = nextMondayIn(now, tz);
  const off = tzOffsetString(now, tz);
  const tagHint = existingTags.length
    ? `\n用户已有标签（仅当内容确实属于该标签主题时才复用；不相关时宁可新造贴切标签，绝不要硬套已有标签）：${existingTags.slice(0, 50).join("、")}`
    : "";
  return `你是「碎念」笔记分拣助手。今天是 ${iso}（${weekday}），用户时区 ${tz}（UTC${off}）。相对日期一律基于今天换算，例如：「明天」= ${tomorrow.iso}（${tomorrow.weekday}）；「下周一」= ${nextMon.iso}（下一个周一，注意不是周二）。用户会丢来一条碎片信息，你输出严格 JSON（不要 markdown 代码块），字段：
- category，七选一：
  - "idea"：自己的想法/思考/灵感/感受，既不需要去做，也不是外部资源
  - "todo"：需要用户去做的事，通常有动作（买/交/回/约/换/提醒我）；没写时间也可以是待办
  - "collect"：收藏的外部链接/文章/视频/资源，内容以 URL 或“稍后看”为主
  - "data"：需要保存备查的资料/参考信息/流程说明/密码/账号/号码，重点是“查”而不是“做”
  - "expense"：记录一笔已发生的花钱/消费/付款（买了/花了/付了/充了）
  - "income"：记录一笔已到账的收入（工资/报销到账/卖了/收到转账）
  - "transfer"：资金平移，钱没有真正花掉也不是新收入——自己账户之间转账/提现/存入（微信零钱提现到银行卡、转 5000 到理财）、借入借出与借还往来（跟朋友借了 2000、别人把借我的钱还给我、我把借来的钱还给别人，都按借还语境判 transfer）、押金交退（押金退回是拿回自己的钱，不是收入）、信用卡/花呗/白条/分期等负债还款（消费已在刷卡时记过账，清偿负债是平移不是当期消费）。这类不计入收支合计
  注意：“要去买/记得交钱”是尚未发生的动作→ todo，不是 expense；只讨论价格而非记账（如“这个耳机卖 299”）→ 按内容归 idea/collect/data
  收支方向（expense/income 二选一时先判钱的流向，绝不能标反）：钱从用户手里出去＝expense——「交/缴/付/花/买/充/续/还」＋金额一律是花钱，即使句中出现“学费/会费/房租”等收费名词也是用户在付钱；钱进用户手里＝income——「到账/收到/入账/进账/卖了/退款/报销到账/发工资/给我转」。方向判例：
  - 「吉他课今天交了下半月学费 400 元」→ expense，amount=400（交学费是用户付钱，绝不是收入）
  - 「付了这个月房租 2600」→ expense
  - 「闲鱼卖了旧显示器 350 元」→ income（卖出收钱）
  - 「上月报销的差旅费 800 到账了」→ income
  - 「学生给我交了补课费 300」→ income（别人交钱给我）
  资金平移判例（transfer，不是 expense/income）：
  - 「微信零钱提现 2000 到银行卡」→ transfer，amount=2000（自己账户间平移）
  - 「转了 5000 到余额宝」→ transfer（不是支出）
  - 「跟老妈借了 3000 周转」→ transfer（借入不是收入）
  - 「表弟把上次借的 1500 还给我了」→ transfer（收回借出的钱，不是新收入）
  - 「房东退了押金 3500 到我微信」→ transfer（押金退回是拿回自己的钱，不是 income；区别于买东西退货退款）
  - 「上次借小王的 1000 今天还给他了」→ transfer（归还借款，不是新消费）
  - 「还了信用卡 3000」→ transfer（刷卡消费当时已记 expense，还款是清偿负债的平移，再记 expense 会重复）
  - 「花呗上月账单自动扣了 2680」→ transfer（同上，负债还款）
  注意区分：商家退货退款（「退款 99 到账」）仍是 income 冲抵消费；只有借还/押金/负债还款这类「拿回或归还本就属于某方的钱」才是 transfer
  AA/平摊判例：只有用户明确说了 AA/平摊/人均/垫付时，amount 才记用户自己实际承担的净额——「晚饭 AA 一共 480，四个人平摊，我先垫付了」→ expense，amount=120（480÷4，垫付会收回的部分不算自己的支出）；明确平摊但人数不明时 amount=null，绝不要把垫付总额记成自己的支出。只提到人数、没说 AA/平摊/垫付的按用户实付金额记——「午餐农家菜 120 元两个人」→ amount=120（分不分摊是用户的决定，绝不自作主张按人头除）
  判例：
  - 「公司报销流程：先在 OA 提单，再贴发票给财务」→ data（流程性参考，无待办动作）
  - 「9月1号起各部门预算表改用新模板」→ data（带日期的说明仍是资料，不是待办）
  - 「9月1号起预算表改用新模板，找行政领新版」→ todo（制度/流程变更但含需要本人去做的动作，如“找…领”“去…办”，以动作为准归 todo）
  - 「回头把冰箱滤芯换了」→ todo（无时间也是待办，todo_due=null）
  - 「昨天就该给妈妈回电话（已经拖了一天）」→ todo，todo_due=${iso}（已拖欠的事记今天，进今日待办）
  - 「https://example.com/abc 一篇讲向量检索的文章」→ collect（纯链接即收藏）
  - 「明天下午3点和设计师对稿」→ todo，todo_due=${tomorrow.iso}T15:00:00${off}
  - 「下周一晚上8点提醒我给客户回邮件」→ todo，todo_due=${nextMon.iso}T20:00:00${off}
  - 「Wi-Fi 密码是 hunter2-demo」→ data，且 is_sensitive=true
  - 「感觉周报功能可以做成邮件推送」→ idea
  - 「午饭黄焖鸡 23 块」→ expense，amount=23，currency="CNY"，merchant="午饭黄焖鸡"
  - 「报销到账 1200」→ income，amount=1200，currency="CNY"
  - 「今天买了杯咖啡，没看多少钱」→ expense，amount=null（金额不确定绝不要猜）
  - 「周末记得去买猫粮」→ todo（还没花钱，不是 expense）
  - 「我这周记了哪些待办」→ idea，is_question=true（向笔记库提问的查询句，不是一条新待办）
  注意：已经发生/完成的动作叙述是日志不是待办——「跑了 7 公里」「读完第四章」「搞定了/交了/发布了」这类完成式记录归 idea（生活/工作日志、读书感想）或 expense/income（若是记账），绝不要因为句子里有动词就归 todo。判例：
  - 「跑步 7 公里，早上出门凉快多了」→ idea（完成式运动日志，不是待办）
  - 「读《纳瓦尔宝典》第四章，杠杆的三种形式很有启发」→ idea（读书笔记，不是待办）
  - 「Android 内测包搞定了，比计划提前一天」→ idea（完成宣告，不是新待办）
  - 「闲鱼挂出了显示器，350 出」→ idea（已完成的动作记录，不是待办）
  - 「季度报告初稿写完了」→ idea（完成宣告）
  - 「公众号选题定了：只写三篇论文精读」→ idea（已做出的决定记录，不是待办）
  注意：知识性/技术性内容（讲解概念、原理、方法，日后可备查，如密码学/协议/算法/流程的讲解）→ data，即使开头写着「读书笔记/学习笔记」；只有以个人感想/启发/心情为主的读后感才是 idea。记录某个具体值（密码/号码/地址）供备查的内容 → data，句尾附带的「告诉某人」不改变其资料性质。判例：
  - 「读书笔记：《密码学与网络安全》讲 TLS 握手时用非对称加密交换会话密钥」→ data（知识备查，无个人感想）
  - 「Python 密码学入门笔记：哈希函数不可逆，适合存密码摘要」→ data（技术知识）
  - 「读《纳瓦尔宝典》第四章，杠杆的三种形式很有启发」→ idea（以感想为主）
  - 「门禁密码换成了 8642，告诉保洁阿姨」→ data，is_sensitive=true（记录密码值备查，不是待办）
  注意：外部事件/公告（电影定档、发布会日期、新品发售）只是资讯，不是用户要做的事——归 data 或 collect，日期也不是 todo_due；只有内容明确包含用户自己的动作（买票/提醒我看/去参加）才是 todo。判例：
  - 「沙丘 3 定档 10 月 1 日上映」→ data（外部事件公告，不是待办）
  - 「沙丘 3 十月上映，提醒我提前买票」→ todo（含用户动作）
注意：多行表格式账单（CSV/制表符分隔，每行一笔含金额，如「日期,项目,金额」多行）整体是一条记账笔记——各行都是已发生的消费时 category="expense"，amount=所有行金额之和（如 199+99+38+20 → 356），绝不要因为是表格就归 data、也绝不要把 amount 置 null。判例：
  - 「日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20」→ expense，amount=356
  - 「买菜,55.5\n地铁,4」→ expense，amount=59.5
- tags: 1-3 个中文短标签数组（宁少勿多，纯词即可，不要 # 前缀）。标签必须是内容的主题词，用能概括这条内容的具体场景词（如打车→「交通」、午饭→「餐饮」、买咖啡→「咖啡」），不要一律套「购物」这类宽泛词。内容开头的方括号前缀标记（如「[QA-123]」「[P0]」「【草稿】」）和序号（「1.」）是元数据记号，不是主题：既不能整个照抄进标签，也不能把括号里的词抽出来当标签${tagHint}
- title: 一句话短标题（<=20字），同样要忽略开头的方括号前缀/序号，不要抄进标题。判例：「[P0] 修复登录超时」→ title="修复登录超时"，tags 不含 "P0"；「[QA-TEST] 周五交报告」→ title="周五交报告"，tags 不含 "QA-TEST"、"QA"、"TEST"
- is_sensitive: 是否含真实机密 (boolean)。仅当内容中出现真实可用的机密「具体值」时才为 true：密码/口令/密钥/API key/token 的具体值、完整身份证号、银行卡号、手机号+姓名组合、账号+密码组合。以下情况必须为 false：技术文档/教程/笔记只是讨论密码、token、密钥等概念而未出现具体秘密值；代码片段中的变量名/占位符（如 <token>、your-api-key、xxx）；普通长文、文件内容中的 ID/哈希/版本号等非机密长字符串。判例：
  - 「服务器 root 密码是 P@ssw0rd123」→ true（出现密码具体值）
  - 「OpenAI key: sk-abc123def456…」→ true（出现密钥具体值）
  - 「JWT token 的刷新机制：access token 短效期，refresh token 长效期」→ false（只讨论概念，无具体值）
  - 「配置 API key 的步骤：在控制台生成 key 后写入环境变量」→ false（教程，无具体值）
  - 「curl -H "Authorization: Bearer <token>" 调用接口」→ false（占位符不是真实机密）
- amount: 仅 expense/income/transfer 时输出的金额数字（不带单位，如 23 或 12.5）；内容里没有明确金额时必须为 null，绝不要猜测。其它类别一律 null
- currency: 仅 expense/income/transfer 且 amount 非 null 时输出 ISO 4217 代码（人民币/块/元默认 "CNY"，美元 "USD"），否则 null
- merchant: 仅 expense/income/transfer 时输出的商家或用途短语（<=12字），推断不出则 null
- is_question: 内容是否在向自己的笔记库提问 (boolean)。疑问句语气（哪些/什么/多少/怎么/为什么/吗/呢等）且意图是想得到回答时为 true，即使句尾没打问号——如「最近一周我花了哪些钱」。以下必须为 false：记录信息/想法/待办（即使含疑问词，如「查一下明天几点开会」是待办）、自问自答式的思考记录（「要不要做 X？我觉得可以」）、修辞性反问
- todo_due: 若是待办且能推断截止时间，基于上面给出的今天日期与星期换算（如"周五之前"= 从今天起最近的周五）。内容中有具体时刻（如"下午三点半""晚上8点"）时输出带时刻和时区偏移的 ISO 8601 "YYYY-MM-DDTHH:mm:00${off}"（24 小时制，时刻按用户时区 ${tz} 理解，偏移固定写 ${off}，如 "${tomorrow.iso}T15:30:00${off}"）；只有日期没有时刻时仅输出 "YYYY-MM-DD"；无法推断则 null。绝不要输出早于今天的日期；内容表达「已经拖欠/早该做了」（如“昨天就该……”“拖了两天”“早该回电话了”）时输出今天 "${iso}"，让它进入今日待办而不是永远沉没
${
    corrections.length
      ? `\n用户此前手动指定过下列内容的分类（这是该用户的既定偏好，遇到同类内容优先照此归类）：\n${corrections
          .map((c) => `- 「${c.content}」→ "${c.category}"`)
          .join("\n")}`
      : ""
  }
只输出 JSON。标签禁止包含密码、密钥、卡号等敏感值本身。`;
}

// ---- sensitive detection fallback (regex) ----
// Backstop only: force-flags content that clearly contains a real credential VALUE.
// Mentions of 密码/token/密钥 as concepts (tech docs, tutorials, code) must NOT match.
const SENSITIVE_ASSIGN_RE =
  /(密码|口令|密钥|秘钥|私钥|passw(?:or)?d|passphrase|pwd|api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|验证码|pin\s?码?)[^\S\n]{0,4}(改成了|改为|设为|设置为|更新为|[:：=是为])[^\S\n]*([^\s，。；,;]{4,})/i;
const SENSITIVE_KEY_LITERAL_RE =
  /\bsk-[A-Za-z0-9_\-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}\b|\bxox[bap]-[A-Za-z0-9\-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const ID_CARD_RE = /身份证[^\n]{0,10}\d{17}[\dXx]\b|\b\d{17}[Xx]\b/;
const BANK_CARD_RE = /(银行卡|卡号|储蓄卡|信用卡)[^\n]{0,10}\d{12,19}\b/;
const PHONE_RE = /(手机号?码?|电话号?码?|联系方式)[^\n]{0,10}(?:\+?86[\s-]?)?1[3-9]\d{9}\b/;

// 数字类敏感值（卡号/证件号/手机号）的常见抄写格式是分组分隔（4-4-4-4 空格、
// 连字符）或全角数字：归一化后再跑数字类正则，让分段变体与连续写法同判。
const FULLWIDTH_DIGIT_RE = /[０-９]/g;
const DIGIT_GROUP_SEP_RE = /(\d)[ \t\u3000\-‐‑‒–—―]{1,3}(?=\d)/g;

/** Fold fullwidth digits to ASCII and collapse separators between digit groups. */
export function normalizeDigitRuns(content: string): string {
  return content
    .replace(FULLWIDTH_DIGIT_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(DIGIT_GROUP_SEP_RE, "$1");
}
// values that are placeholders/templates, not real secrets
const PLACEHOLDER_VALUE_RE = /^(<|\{|\[|\*{2,}|x{3,}|你的|your[-_]?|占位)/i;

// Fail-closed hint for the pre-triage window: any credential-ish topic word at
// all. Much broader than detectSensitive on purpose — a hit only means "treat
// as sensitive until the model has classified", never a final verdict. The
// model remains the primary judge; applyTriage restores plaintext when it
// confidently says non-sensitive.
const SENSITIVE_TOPIC_RE =
  /密码|口令|密钥|秘钥|私钥|passw(?:or)?d|passphrase|\bpwd\b|api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|\bsecret\b|\btoken\b|验证码|pin\s?码|身份证|银行卡|信用卡|储蓄卡|卡号|账号/i;

/**
 * Write-time pre-check for notes awaiting AI triage (fail-closed): true when
 * the content certainly (detectSensitive) or possibly (topic hint) contains a
 * secret. Uncertain notes get encrypted for the pending window so backup/
 * export/list paths can never leak plaintext before the model has judged.
 */
export function maybeSensitive(content: string): boolean {
  return detectSensitive(content) || SENSITIVE_TOPIC_RE.test(content);
}

/** Regex fallback: does the content look like it contains a real credential value? */
export function detectSensitive(content: string): boolean {
  const assign = content.match(SENSITIVE_ASSIGN_RE);
  if (assign && !PLACEHOLDER_VALUE_RE.test(assign[3])) return true;
  if (SENSITIVE_KEY_LITERAL_RE.test(content)) return true;
  // 数字类规则同时跑原文与归一化文本：空格/连字符/全角/分段变体不再绕过
  const normalized = normalizeDigitRuns(content);
  return [ID_CARD_RE, BANK_CARD_RE, PHONE_RE].some(
    (re) => re.test(content) || re.test(normalized)
  );
}

const TAG_SECRET_RE = /^(?=.*\d)[A-Za-z0-9_\-@#$%.]{6,}$|^\d{6,}$|^sk-/i;

/** Drop tags that look like sensitive values (long alnum strings, digit runs, key prefixes). */
export function sanitizeTags(tags: string[]): string[] {
  return tags.filter((t) => !TAG_SECRET_RE.test(t.trim())).slice(0, 3);
}

// 敏感笔记派生字段口径（R120 P1-1）：content 加密后，title/tags 绝不能把秘密
// 值明文带出。title 一律置空（模型标题不可信，可能原样抄入密码值）；tags 只
// 保留不含数字串/较长拉丁字母串的纯主题词（如「密码」「门禁」）。
const SENSITIVE_TAG_VALUE_RE = /\d{3,}|[A-Za-z]\d|\d[A-Za-z]|[A-Za-z0-9_\-@#$%.]{10,}|^sk-/i;

/** Strict tag filter for sensitive notes: drop anything that could be (part of) a secret value. */
export function sanitizeSensitiveTags(tags: string[]): string[] {
  return tags.filter((t) => !SENSITIVE_TAG_VALUE_RE.test(t.trim())).slice(0, 3);
}

// Leading [xxx] / 【xxx】 marker prefixes (issue keys, QA markers, 【草稿】-style
// labels) are metadata, never topics: they must not leak into tags or the title.
const LEADING_MARKERS_RE = /^\s*(?:[[【][^\]】\n]{1,24}[\]】]\s*)+/;

/** Extract the texts of leading bracket markers, e.g. "[QA-1]【草稿】xx" → ["QA-1","草稿"]. */
export function leadingMarkers(content: string): string[] {
  const m = content.match(LEADING_MARKERS_RE);
  if (!m) return [];
  return [...m[0].matchAll(/[[【]([^\]】\n]{1,24})[\]】]/g)]
    .map((x) => x[1].trim())
    .filter((t) => t.length >= 2);
}

/** Deterministic backstop after the LLM: drop tags that copy a leading bracket
 * marker (whole or部分) and strip the markers from the title. Normal #tags and
 * body-derived tags are untouched. */
export function stripMarkerNoise(content: string, triage: TriageResult): TriageResult {
  const markers = leadingMarkers(content);
  if (markers.length === 0) return triage;
  const lower = markers.map((m) => m.toLowerCase());
  const tags = triage.tags.filter((t) => {
    const tl = t.trim().toLowerCase();
    return !lower.some((m) => tl.includes(m) || m.includes(tl));
  });
  let title = triage.title ?? "";
  for (const m of markers) {
    title = title.split(`[${m}]`).join("").split(`【${m}】`).join("");
  }
  title = title.replace(/^[\s\-—:：]+/, "").trim();
  return { ...triage, tags, title };
}

// ---- 收支方向兑底（R118 P1）----
// 模型把「交学费 400」判成 income 会直接污染财务聚合账本：当内容里只有
// 钱“出去”的词面证据而无任何钱“进来”的词面证据时（反之亦然），确定性
// 地纠正方向。两侧都有词或都没词时不动，模型仍是主判。
const EXPENSE_DIRECTION_RE =
  /交了|缴了|付了|花了|买了|充了|续了|还了|交费|缴费|付款|付掉|花掉|续费|充值|还款|请客|打赏了|损失/;
const INCOME_DIRECTION_RE =
  /到账|入账|进账|收到|收了|收款|卖了|卖出|退款|退了|返现|返了|发了工资|发工资|工资发|赚了|挣了|中了|收租|给我/;

// 资金平移兑底（R120 P1-3）：模型把提现/内转/借入判成 expense/income 会把
// 平移的钱直接污染收支合计。词面证据明确指向自己账户间平移或借入时，
// 确定性改判 transfer；「借给」是借出（净支出语义），不匹配。
const INTERNAL_TRANSFER_RE =
  /提现|(?:转|存)(?:了|入|到|进)?\s*[^，。;；\n]{0,10}?(?:银行卡|储蓄卡|余额宝|零钱通?|理财|定期|活期|基金账户|证券账户|自己的?[^，。;；\n]{0,4}(?:卡|账户))/;
const BORROW_IN_RE = /(?:跟|向|从|找)\s*[^，。;；\n]{0,8}?借(?:了|到|来)/;
// 借还第三态（R122 P1-2）：归还入账（别人把借我的钱还给我）、归还出账（我把
// 借来的钱还回去）与押金退回都是拿回/归还本就属于某方的钱，记 income/expense
// 会污染收支合计。归还动词必须与借/垫/押金语境同现才改判，避免误伤普通
// 退货退款（仍是 income）与「还给他买了礼物」这类非借还句。
const RETURN_VERB_RE = /还给|还了我|还我|还回来|转回来|退回来/;
const BORROW_CONTEXT_RE = /借|垫付|垫的|押金/;
const DEPOSIT_REFUND_RE = /押金[^，。;；\n]{0,8}(?:退|返)|退(?:了|还|回)?[^，。;；\n]{0,8}押金/;
// 负债还款（R122 D1）：信用卡/花呗/白条/借呗/分期还款——消费已在刷卡时记账，
// 清偿负债再记 expense 会重复计入支出合计。
const DEBT_REPAY_RE =
  /(?:信用卡|花呗|白条|借呗|分期)[^，。;；\n]{0,6}(?:还款|还清|还上|扣款|扣了|还了)|还(?:了|款|清|上|掉)?[^，。;；\n]{0,4}(?:信用卡|花呗|白条|借呗)(?:账单|欠款|的钱)?/;

/** Deterministic backstop: reclassify obvious money-movement notes
 * (withdrawals / own-account transfers / borrowing / loan repayment in either
 * direction / deposit refunds / debt repayment) as transfer. */
export function fixTransferMisfile(content: string, triage: TriageResult): TriageResult {
  if (triage.category !== "expense" && triage.category !== "income") return triage;
  if (INTERNAL_TRANSFER_RE.test(content) || BORROW_IN_RE.test(content)) {
    return { ...triage, category: "transfer" };
  }
  if (DEPOSIT_REFUND_RE.test(content) || DEBT_REPAY_RE.test(content)) {
    return { ...triage, category: "transfer" };
  }
  if (RETURN_VERB_RE.test(content) && BORROW_CONTEXT_RE.test(content)) {
    return { ...triage, category: "transfer" };
  }
  return triage;
}

/** Deterministic finance-direction backstop: flip income↔expense when the
 * content's money-flow verbs unambiguously contradict the model's verdict. */
export function fixFinanceDirection(content: string, triage: TriageResult): TriageResult {
  if (triage.category !== "expense" && triage.category !== "income") return triage;
  const out = EXPENSE_DIRECTION_RE.test(content);
  const inn = INCOME_DIRECTION_RE.test(content);
  if (triage.category === "income" && out && !inn) return { ...triage, category: "expense" };
  if (triage.category === "expense" && inn && !out) return { ...triage, category: "income" };
  return triage;
}

// ---- 事件/日志误判 todo 兑底（R118 P2，R107/R113/R117 三轮同型）----
// 完成式叙述（写完了/挂出了/搞定了）无未来动作时不是待办；外部公告
// （定档/上映/发售）无用户动作时也不是待办。只在模型判了 todo 且词面
// 证据明确时降级，其它情况不动。
const COMPLETED_LOG_RE =
  /写完了|做完了|完成了|搞定了|读完|看完了|交了|发布了|上线了|挂出了?|发出了|提交了|搬完了|修好了|定了[：:，,]|敲定了?|定下来了/;
const ANNOUNCEMENT_RE = /定档|上映|首映|开播|发售|开售|开票|发布会|官宣/;
const FUTURE_ACTION_RE =
  /记得|提醒|要去|得去|别忘|预约|安排|回头|稍后|之前去|去买|去交|去还|去取|去看|买票|抢票|再润色|再改|跟进|待办/;

/** Deterministic backstop: demote completed-action logs / external
 * announcements the model misfiled as todo. Logs become idea; announcements
 * become data (their date is information, not a due). */
export function demoteEventLog(content: string, triage: TriageResult): TriageResult {
  if (triage.category !== "todo" || FUTURE_ACTION_RE.test(content)) return triage;
  if (!triage.todo_due && COMPLETED_LOG_RE.test(content)) {
    return { ...triage, category: "idea", todo_due: null };
  }
  if (ANNOUNCEMENT_RE.test(content) && !/我/.test(content)) {
    return { ...triage, category: "data", todo_due: null };
  }
  return triage;
}

const TODO_DUE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?)?/;

function normalizeOffset(raw: string | undefined, defaultOffset: string): string {
  if (!raw) return defaultOffset;
  if (raw === "Z") return "+00:00";
  return raw.includes(":") ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
}

/**
 * Normalize a todo_due into "YYYY-MM-DD" (date-only) or offset ISO 8601
 * "YYYY-MM-DDTHH:mm:00+HH:mm" (timed; bare local times take `defaultOffset`,
 * the user's timezone offset, Asia/Shanghai by default).
 */
export function normalizeTodoDue(v: unknown, defaultOffset = "+08:00"): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(TODO_DUE_RE);
  if (!m) return null;
  if (!m[2]) return m[1];
  return `${m[1]}T${m[2]}:00${normalizeOffset(m[3], defaultOffset)}`;
}

/** 平衡花括号扫描：从任意 LLM 输出中提取全部顶层 JSON 对象（容忍多对象
 * 并排/裸数组包裹/前后散文），解析失败的片段静默跳过。 */
function extractJsonObjects(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1)) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            out.push(parsed as Record<string, unknown>);
          }
        } catch {
          /* 花括号配平但非合法 JSON 的片段：跳过 */
        }
        start = -1;
      }
    }
  }
  return out;
}

function candidateToTriage(o: Record<string, unknown>, defaultOffset: string): TriageResult | null {
  const category = o.category;
  if (typeof category !== "string" || !CATEGORIES.includes(category as Category)) return null;
  const tags = Array.isArray(o.tags)
    ? sanitizeTags(o.tags.filter((t): t is string => typeof t === "string" && t.length > 0))
    : [];
  const title = typeof o.title === "string" ? o.title : "";
  const is_sensitive = o.is_sensitive === true;
  const todo_due = normalizeTodoDue(o.todo_due, defaultOffset);
  const isFinance = category === "expense" || category === "income" || category === "transfer";
  const amount =
    isFinance && typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount > 0
      ? o.amount
      : null;
  const currency =
    amount !== null && typeof o.currency === "string" && /^[A-Za-z]{3}$/.test(o.currency.trim())
      ? o.currency.trim().toUpperCase()
      : amount !== null
        ? "CNY"
        : null;
  const merchant =
    isFinance && typeof o.merchant === "string" && o.merchant.trim() ? o.merchant.trim().slice(0, 24) : null;
  const is_question = o.is_question === true;
  return { category: category as Category, tags, title, is_sensitive, todo_due, amount, currency, merchant, is_question };
}

/** Parse the LLM output into a TriageResult; returns null when invalid.
 *
 * R170 P1-2：多行 CSV 记账笔记会诱使模型输出多个并排 JSON 对象或裸数组
 * （R169 实测 22 分钟不分拣、1 小时降级只打「想法」）。解析容忍多对象/
 * 数组/markdown 包裹：取第一个合法对象定分类；当全部候选是同分类同币种
 * 的记账行时金额确定性求和（一条多行账单笔记的正确合计），分类不一致则
 * 金额置空（无法归一，绝不猜）。 */
export function parseTriageJson(text: string, defaultOffset = "+08:00"): TriageResult | null {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const candidates = extractJsonObjects(raw)
    .map((o) => candidateToTriage(o, defaultOffset))
    .filter((r): r is TriageResult => r !== null);
  if (candidates.length === 0) return null;
  const first = candidates[0];
  if (candidates.length === 1) return first;
  const isFinance = first.category === "expense" || first.category === "income" || first.category === "transfer";
  const uniform = candidates.every(
    (c) => c.category === first.category && (c.currency ?? "CNY") === (first.currency ?? "CNY")
  );
  if (isFinance && uniform) {
    const amounts = candidates.map((c) => c.amount).filter((a): a is number => a !== null);
    const amount = amounts.length > 0 ? Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100 : null;
    const tags = sanitizeTags(candidates.flatMap((c) => c.tags));
    return { ...first, amount, currency: amount !== null ? (first.currency ?? "CNY") : null, tags };
  }
  if (!uniform && isFinance) {
    // 分类/币种不一致的多行输出：分类取首个，金额无法归一置空（绝不错记）
    return { ...first, amount: null, currency: null };
  }
  return first;
}

/** Load the user's 50 most-used tags for prompt reuse. */
export async function loadTopTags(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT tags FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 500")
    .bind(userId)
    .all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of results ?? []) {
    try {
      for (const t of JSON.parse(r.tags || "[]") as string[]) {
        if (typeof t === "string" && t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    } catch {
      /* ignore bad rows */
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t]) => t);
}

/**
 * The user's recent manual category choices (edits and explicit-category
 * creates set meta.manual_override.category), fed to the triage prompt as
 * few-shot preferences so the AI stops repeating the same misfiles.
 */
export async function loadCategoryCorrections(db: D1Database, userId: string): Promise<CategoryCorrection[]> {
  const { results } = await db
    .prepare(
      `SELECT content, category, meta FROM notes
        WHERE user_id = ? AND deleted_at IS NULL AND is_sensitive = 0 AND category IS NOT NULL
          AND meta LIKE '%"category":true%'
        ORDER BY updated_at DESC LIMIT 10`
    )
    .bind(userId)
    .all<{ content: string; category: string; meta: string | null }>();
  const out: CategoryCorrection[] = [];
  for (const r of results ?? []) {
    try {
      const meta = JSON.parse(r.meta || "{}") as { manual_override?: { category?: boolean } };
      if (!meta.manual_override?.category) continue;
    } catch {
      continue;
    }
    if (!CATEGORIES.includes(r.category as Category)) continue;
    const content = r.content.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!content) continue;
    out.push({ content, category: r.category as Category });
    if (out.length >= 5) break;
  }
  return out;
}

// ---- 多行表格账单确定性合计（R178 P1-2）----
// 多行 CSV 账单的合计是结构化数据的确定性解析问题：R170 依赖模型输出多个
// JSON 对象再求和，生产模型常输出单对象且 amount=null（金额置空漏账）。
// 内容本身是分隔符表格且金额列无歧义时，解析器直接求和兜底——模型仍是
// 分类主判，规则只在分类已是记账时锁定金额。

const LEDGER_MONEY_RE = /^[¥￥]?\d+(?:\.\d{1,2})?元?$/;

/** 拆一行 CSV 字段（支持双引号包裹与 "" 转义），分隔符：半/全角逗号、制表符、分号。 */
export function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === "," || ch === "，" || ch === "\t" || ch === ";" || ch === "；") {
      fields.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

/** 多行表格账单的确定性合计：内容是 ≥2 行数据的分隔符表格、且存在唯一一列
 * 每行都是金额时返回该列求和；表头（首行无金额）自动跳过；金额列有歧义
 *（多列都全是数字）或结构不齐时返回 null（绝不猜）。 */
export function parseLedgerTable(content: string): { amount: number; rows: number } | null {
  const parsed = parseLedgerCore(content);
  return parsed === "ambiguous" ? null : parsed;
}

/** 同 parseLedgerTable，但区分「非表格」（null）与「是表格但金额列歧义」
 *（"ambiguous"）：歧义表格不允许模型自行猜总和（R183 P2-2）。 */
export function parseLedgerCore(content: string): { amount: number; rows: number } | "ambiguous" | null {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const isMoney = (s: string) => LEDGER_MONEY_RE.test(s) && parseFloat(s.replace(/[¥￥元]/g, "")) > 0;
  const allRows = lines.map(splitCsvFields);
  // 标题/落款行（R183 P1-1）：真实用户常在表格前后写单字段的说明行
  //（「购物清单」）；不含金额的单字段行从两端剥掉，表格主体照常解析
  let start = 0;
  let end = allRows.length;
  while (start < end && allRows[start].length < 2 && !allRows[start].some(isMoney)) start++;
  while (end > start && allRows[end - 1].length < 2 && !allRows[end - 1].some(isMoney)) end--;
  const rows = allRows.slice(start, end);
  if (rows.length < 2) return null;
  if (rows.some((r) => r.length < 2)) return null;
  const width = rows[0].length;
  if (rows.some((r) => r.length !== width)) return null;
  // 首行没有任何金额字段视作表头跳过
  const data = rows[0].some(isMoney) ? rows : rows.slice(1);
  if (data.length < 2) return null;
  const moneyCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (data.every((r) => isMoney(r[c]))) moneyCols.push(c);
  }
  if (moneyCols.length === 0) return null;
  if (moneyCols.length > 1) return "ambiguous";
  const col = moneyCols[0];
  const sum = data.reduce((s, r) => s + parseFloat(r[col].replace(/[¥￥元]/g, "")), 0);
  return { amount: Math.round(sum * 100) / 100, rows: data.length };
}

/** Deterministic backstop: when the model classifies a multi-row ledger table
 * as finance but leaves amount null (or sums it wrong), lock the amount to the
 * parser's column sum. Category stays the model's call. */
export function fixLedgerAmount(content: string, triage: TriageResult): TriageResult {
  const isFinance = triage.category === "expense" || triage.category === "income" || triage.category === "transfer";
  if (!isFinance) return triage;
  const ledger = parseLedgerCore(content);
  if (!ledger) return triage;
  // 金额列歧义的表格（R183 P2-2）：模型自行猜的总和不可信，按「歧义不猜」
  // 置空金额，等用户手动确认
  if (ledger === "ambiguous") return triage.amount == null ? triage : { ...triage, amount: null };
  if (triage.amount === ledger.amount) return triage;
  return { ...triage, amount: ledger.amount, currency: triage.currency ?? "CNY" };
}

export async function triageNote(
  content: string,
  env: Parameters<typeof chatComplete>[0],
  existingTags: string[] = [],
  tz: string = DEFAULT_TZ,
  corrections: CategoryCorrection[] = [],
  // 相对日期锚点：导入/延迟分拣的历史笔记必须以笔记原始记录时间为「今天」，
  // 否则「明天交房租」会漂移到分拣执行日（R120 P2）
  now: Date = new Date()
): Promise<TriageResult | null> {
  const text = await chatComplete(env, {
    temperature: 0.2,
    max_tokens: 300,
    messages: [
      { role: "system", content: buildTriagePrompt(now, existingTags, tz, corrections) },
      { role: "user", content: content.slice(0, 4000) },
    ],
  });
  let result = (text && parseTriageJson(text, tzOffsetString(now, tz))) || null;
  if (result) result = stripMarkerNoise(content, result);
  if (result) result = demoteEventLog(content, fixTransferMisfile(content, fixFinanceDirection(content, result)));
  if (result) result = fixLedgerAmount(content, result);
  // regex fallback: never let an obvious credential slip through as non-sensitive
  if (!result?.is_sensitive && detectSensitive(content)) {
    result = result
      ? { ...result, is_sensitive: true }
      : { ...FALLBACK_TRIAGE, category: "data", is_sensitive: true };
  }
  // null = AI unavailable: leave the note unsorted so the retry sweep picks it up
  return result;
}
