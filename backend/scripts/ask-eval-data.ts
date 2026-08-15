/**
 * Golden dataset for the /api/ask retrieval-quality eval (R54).
 *
 * NOTES simulate ~2.5 months of real mixed usage (ideas evolving over time,
 * links, todos, expenses, image descriptions, one sensitive note, noise).
 * QUESTIONS are colloquial, time-scoped, cross-fragment, comparative,
 * negated and unanswerable — each annotated with the note keys the answer
 * must (or must not) be grounded in. Questions marked `holdout: true` are
 * never used for tuning; they only appear in the final score.
 */

export const PREFIX = "[QA-R79]";

export interface EvalNote {
  key: string;
  /** days before "now" the note was written (import backfills created_at) */
  daysAgo: number;
  content: string;
  category: "idea" | "todo" | "collect" | "data" | "expense" | "income";
  title: string;
  tags?: string[];
  sensitive?: boolean;
}

const N = (
  key: string,
  daysAgo: number,
  category: EvalNote["category"],
  title: string,
  content: string,
  tags?: string[],
  sensitive?: boolean
): EvalNote => ({ key, daysAgo, category, title, content: `${PREFIX} ${content}`, tags, sensitive });

export const NOTES: EvalNote[] = [
  // —— 咖啡馆创业点子（跨 2.5 个月演化的线索） ——
  N("cafe1", 75, "idea", "手冲咖啡馆的最初想法", "突然想开一家只做手冲的小咖啡馆，不卖意式，主打浅烘单品豆，店里只放 8 个座位", ["咖啡馆", "创业"]),
  N("cafe2", 40, "idea", "咖啡馆点子的最大问题", "咖啡馆那个点子想了想有个大问题：市中心房租太高，纯手冲客单价撑不住，一天卖 60 杯都回不了本", ["咖啡馆", "创业"]),
  N("cafe3", 12, "idea", "咖啡馆新思路：周末快闪店", "咖啡馆新思路：不租长期店面，先做周末快闪店试水，找市集摊位合作，验证有没有人愿意为手冲付 40 块", ["咖啡馆", "创业"]),
  // —— 读书笔记 ——
  N("naval1", 60, "data", "《纳瓦尔宝典》笔记：财富与运气", "读《纳瓦尔宝典》：财富是睡觉时也能赚钱的资产，把自己产品化；运气可以通过独特知识变成必然", ["读书"]),
  N("naval2", 30, "data", "纳瓦尔 vs 芒格", "对比着读：纳瓦尔讲杠杆（代码和媒体是无需许可的杠杆），芒格讲多元思维模型，前者偏行动后者偏决策", ["读书"]),
  // —— 健身 ——
  N("fit1", 50, "idea", "开始隔天跑步计划", "决定开始隔天跑 5 公里，早上 7 点出门，先坚持一个月看看体感", ["健身"]),
  N("fit2", 20, "idea", "膝盖疼，跑步改游泳", "跑了一个月膝盖开始疼，查了下可能是跑姿问题，决定先停跑改成每周游泳两次", ["健身"]),
  // —— 工作项目「星尘」 ——
  N("proj1", 45, "data", "星尘项目启动", "星尘项目今天立项：目标是把内部报表系统重写，Q4 前上线第一版", ["星尘", "工作"]),
  N("proj2", 33, "idea", "为什么觉得方案A不行", "星尘的方案A我觉得不行：依赖太多外部接口，任何一个挂了整条链路都断，联调成本也高", ["星尘", "工作"]),
  N("proj3", 10, "idea", "方案B：消息队列解耦", "星尘改用方案B：中间加消息队列解耦，外部接口挂了就重试，核心链路不受影响", ["星尘", "工作"]),
  // —— 链接收藏 ——
  N("link1", 25, "collect", "SQLite WAL 模式文章", "https://sqlite.org/wal.html 讲 SQLite WAL 模式的官方文档，读写并发的原理讲得很清楚", ["技术"]),
  N("link2", 42, "collect", "Tailwind 深入文章", "https://tailwindcss.com/docs/styling-with-utility-classes 收藏一篇讲 Tailwind 实用类设计哲学的文章", ["技术"]),
  // —— 待办 ——
  N("todo1", 3, "todo", "给房东转房租", "下周三之前记得给房东转这个季度的房租", ["生活"]),
  N("todo2", 15, "todo", "预约牙医洗牙", "该预约牙医洗牙了，上次洗牙已经是一年前", ["健康"]),
  // —— 记账 ——
  N("exp1", 8, "expense", "买机械键盘", "入手了一把机械键盘，茶轴，399 元", ["购物"]),
  N("exp2", 5, "expense", "猫打疫苗", "带猫去打了三联疫苗，花了 260 块", ["宠物"]),
  // —— 图片描述（模拟 vision 提取结果） ——
  N("img1", 18, "data", "白板照片：Q3 目标", "白板照片：Q3 目标——1. 上线快闪店预约小程序 2. 跑通咖啡豆供应链 3. 做 3 场市集活动", ["咖啡馆"]),
  // —— 敏感（绝不能出现在召回/回答里） ——
  N("sens1", 22, "data", "路由器管理密码", "家里路由器管理后台密码是 qa-r79-demo-9x7，别忘了", [], true),
  // —— 日语学习 ——
  N("jp1", 70, "idea", "开始学日语五十音", "开始学日语了，先背五十音图，用 Anki 每天 20 个假名", ["日语"]),
  N("jp2", 35, "idea", "背单词 app 不如做题", "学了一个多月日语的感受：光用背单词 app 效率低，不如直接做 N5 真题，在语境里记得牢", ["日语"]),
  // —— 租房对比 ——
  N("rent1", 55, "data", "看房对比：两套房", "看了两套房：A 房近地铁但朝北 6500/月，B 房朝南带阳台但通勤 50 分钟 5800/月，倾向 B", ["生活"]),
  // —— 噪声/填充（多主题，让召回非平凡） ——
  N("nz1", 65, "idea", "周报邮件推送想法", "碎念的周报可以做成邮件推送，让用户被动回顾", ["产品"]),
  N("nz2", 58, "collect", "菜谱：番茄牛腩", "收藏一个番茄炖牛腩的做法：牛腩先焯水，番茄炒出沙，小火炖 90 分钟", ["做饭"]),
  N("nz3", 52, "data", "公司报销流程", "公司报销流程：先在 OA 提单，再把发票贴好交给财务，月底前提交", ["工作"]),
  N("nz4", 48, "idea", "播客节目构思", "想做一档聊「普通人副业」的播客，每期采访一个有副业的上班族", ["播客"]),
  N("nz5", 44, "data", "体检结果记录", "今年体检除了轻度脂肪肝其他都正常，医生建议少吃外卖多运动", ["健康"]),
  N("nz6", 38, "collect", "电影清单", "想看的电影：《坠落的审判》《奥本海默》《完美的日子》", ["电影"]),
  N("nz7", 36, "idea", "阳台种薄荷", "阳台可以种点薄荷和小番茄，夏天泡水喝正好", ["生活"]),
  N("nz8", 28, "data", "Wi-Fi 信道优化", "把家里路由器 5GHz 信道从自动改到 149，穿墙后速度稳定多了", ["技术"]),
  N("nz9", 26, "idea", "给爸妈买按摩椅", "考虑给爸妈买台按摩椅当生日礼物，预算 5000 以内", ["家人"]),
  N("nz10", 24, "data", "TypeScript 泛型笔记", "TS 泛型约束用 extends，条件类型 T extends U ? X : Y，infer 用来提取类型", ["技术"]),
  N("nz11", 21, "idea", "早睡实验", "试一周 23 点前睡觉，看白天精力有没有变化", ["健康"]),
  N("nz12", 17, "collect", "咖啡豆供应商", "https://example.com/beans 一家云南豆子直供的烘焙商，快闪店可以从他家拿豆", ["咖啡馆"]),
  N("nz13", 14, "data", "会员卡到期提醒", "健身房会员卡 12 月底到期，到时候看要不要续", ["健身"]),
  N("nz14", 9, "idea", "碎片时间学习法", "通勤地铁上适合听播客而不是看书，晃动太厉害", ["学习"]),
  N("nz15", 7, "data", "打印机驱动坑", "家里打印机连不上是驱动问题，去官网装 v4.2 版本就好了", ["技术"]),
  N("nz16", 6, "idea", "旧衣服捐赠", "衣柜该断舍离了，旧衣服找小区回收箱捐掉", ["生活"]),
  N("nz17", 4, "data", "高铁退票规则", "高铁开车前 8 天以上退票免手续费，48 小时内收 5%", ["出行"]),
  N("nz18", 2, "idea", "快闪店定价", "快闪店定价想法：手冲一律 35，套餐（咖啡+甜点）50，比市区门店便宜一点吸引尝鲜", ["咖啡馆", "创业"]),
  N("nz19", 1, "collect", "手冲滤杯测评视频", "https://example.com/v60-review V60 和折纸滤杯的对比测评，新手建议 V60", ["咖啡馆"]),
  N("nz20", 30, "expense", "买跑鞋", "买了双跑鞋 549 元，结果现在改游泳了，有点浪费", ["购物", "健身"]),
  // —— R88 badcase：具体数字细节的召回（土鸡蛋报价类） ——
  N("num1", 6, "data", "土鸡蛋团购报价", "供应商老王的土鸡蛋报价：每斤 8.5 元，30 枚礼盒装 25.5 元，周三前下单周五提货", ["团购"]),
  // —— 副业播客线索（R79：多跳/为什么/溯源难例用，与 nz4 同一演化链） ——
  N("pod2", 32, "idea", "播客第一期嘉宾人选", "播客第一期嘉宾想好了：楼下花店老板娘，她副业做干花电商月入过万，故事很典型", ["播客"]),
  N("pod3", 11, "idea", "播客先搁置", "播客这事先鸽了：录音设备加剪辑每期要花大半天，精力不够，等咖啡馆快闪店的事定了再重启", ["播客"]),
  // —— 换工作线索（时间跨度 + 为什么类难例用） ——
  N("job1", 68, "idea", "萌生换工作的念头", "最近总加班到十点，第一次认真想换工作：现在的业务方向太边缘，学不到新东西", ["职业"]),
  N("job2", 37, "idea", "换工作的顾虑", "换工作的事又犹豫了：房贷压力在，现在行情不好，裸辞风险太大，先骑驴找马", ["职业"]),
  N("job3", 13, "idea", "星尘让我改变了想法", "带星尘项目之后想法变了：在现公司也能磨出架构能力，暂缓换工作，先把星尘做成代表作", ["职业", "星尘"]),
];

export type QuestionCategory =
  | "口语指代"
  | "时间限定"
  | "跨碎片"
  | "比较汇总"
  | "否定"
  | "无答案"
  | "敏感隔离"
  | "英文提问"
  | "多跳"
  | "演化脉络"
  | "为什么依据"
  | "数字细节"
  | "财务聚合"
  | "统计聚合";

export interface EvalQuestion {
  id: string;
  category: QuestionCategory;
  question: string;
  /** previous turns for multi-turn pronoun questions */
  history?: { role: "user" | "assistant"; content: string }[];
  /** hit = at least one of these note keys appears in references */
  expectAny?: string[];
  /** hit additionally requires ALL of these keys in references */
  expectAll?: string[];
  /** note keys that must NOT appear in references */
  forbid?: string[];
  /** the answer must be an explicit "没找到" style refusal */
  expectRefusal?: boolean;
  /** every substring must appear verbatim in the answer (deterministic paths) */
  expectAnswerContains?: string[];
  /** none of these substrings may appear in the answer */
  forbidAnswerContains?: string[];
  /** excluded from tuning; only counted in the final report */
  holdout?: boolean;
}

export const QUESTIONS: EvalQuestion[] = [
  // —— 口语指代 ——
  { id: "q01", category: "口语指代", question: "我上次想的那个咖啡馆点子最新进展是什么", expectAny: ["cafe3", "nz18"] },
  { id: "q02", category: "口语指代", question: "之前记的那本讲财富的书说了什么", expectAny: ["naval1", "naval2"] },
  {
    id: "q03",
    category: "口语指代",
    question: "它最大的问题是什么",
    history: [
      { role: "user", content: "我记过开咖啡馆的想法吗" },
      { role: "assistant", content: "记过，你想开一家只做手冲的小咖啡馆 [1]。" },
    ],
    expectAny: ["cafe2"],
  },
  { id: "q04", category: "口语指代", question: "上回说膝盖不舒服后来怎么处理的", expectAny: ["fit2"] },
  {
    id: "q05",
    category: "口语指代",
    question: "那个项目现在用的是什么方案",
    history: [
      { role: "user", content: "星尘项目是干什么的" },
      { role: "assistant", content: "星尘是把内部报表系统重写的项目 [1]。" },
    ],
    expectAny: ["proj3"],
    holdout: true,
  },
  // —— 时间限定 ——
  { id: "q06", category: "时间限定", question: "上个月我为什么觉得星尘的方案A不行", expectAny: ["proj2"] },
  { id: "q07", category: "时间限定", question: "两个多月前我开始学的新东西是什么", expectAny: ["jp1"] },
  { id: "q08", category: "时间限定", question: "最近一周我花了哪些钱", expectAny: ["exp1", "exp2"], expectAll: ["exp2"] },
  { id: "q09", category: "时间限定", question: "上周记的关于键盘的支出是多少", expectAny: ["exp1"], holdout: true },
  { id: "q10", category: "时间限定", question: "这几天有什么要办的事", expectAny: ["todo1"] },
  // —— 跨碎片关系 ——
  { id: "q11", category: "跨碎片", question: "咖啡馆这个想法是怎么一步步变化的", expectAny: ["cafe1", "cafe2", "cafe3"], expectAll: ["cafe1", "cafe3"] },
  { id: "q12", category: "跨碎片", question: "星尘项目从立项到现在做过哪些关键决定", expectAny: ["proj1", "proj2", "proj3"], expectAll: ["proj1", "proj3"] },
  { id: "q13", category: "跨碎片", question: "快闪店这个思路和白板上的 Q3 目标有什么关系", expectAny: ["cafe3", "img1"], expectAll: ["img1"] },
  { id: "q14", category: "跨碎片", question: "我学日语的方法后来为什么变了", expectAny: ["jp1", "jp2"], expectAll: ["jp2"], holdout: true },
  // —— 比较/汇总 ——
  { id: "q15", category: "比较汇总", question: "帮我总结一下关于健身的所有记录", expectAny: ["fit1", "fit2"], expectAll: ["fit1", "fit2"] },
  { id: "q16", category: "比较汇总", question: "我收藏过哪些技术类的文章", expectAny: ["link1", "link2"], expectAll: ["link1"] },
  { id: "q17", category: "比较汇总", question: "纳瓦尔和芒格的观点我是怎么对比的", expectAny: ["naval2"] },
  { id: "q18", category: "比较汇总", question: "看房的时候两套房各有什么优缺点", expectAny: ["rent1"], holdout: true },
  // —— 否定 ——
  { id: "q19", category: "否定", question: "我是不是从来没记过关于跑步的东西", expectAny: ["fit1", "fit2", "nz20"] },
  { id: "q20", category: "否定", question: "我有没有放弃开咖啡馆", expectAny: ["cafe2", "cafe3"] },
  // —— 无答案（必须明确说没找到，不能硬编） ——
  { id: "q21", category: "无答案", question: "我记过特斯拉股票的分析吗", expectRefusal: true },
  { id: "q22", category: "无答案", question: "上周我去哪个城市旅行了", expectRefusal: true },
  { id: "q23", category: "无答案", question: "我的驾照什么时候到期", expectRefusal: true, holdout: true },
  { id: "q24", category: "无答案", question: "上个月的电费是多少", expectRefusal: true },
  // —— 敏感隔离（加密笔记绝不能被引用/泄露） ——
  { id: "q25", category: "敏感隔离", question: "家里路由器的管理密码是多少", forbid: ["sens1"] },
  // —— 补充：口语化模糊问法 ——
  { id: "q26", category: "口语指代", question: "之前那个副业相关的节目构思是啥来着", expectAny: ["nz4"] },
  { id: "q27", category: "时间限定", question: "最近几天收藏的那个咖啡视频讲什么", expectAny: ["nz19"], holdout: true },
  { id: "q28", category: "比较汇总", question: "为了咖啡馆这事我都做了哪些准备", expectAny: ["nz12", "nz18", "cafe3", "img1"], expectAll: ["cafe3"], holdout: true },
  // —— 英文提问（笔记是中文，需双语关键词抽取才能 LIKE 命中） ——
  { id: "q29", category: "英文提问", question: "What is my latest plan for the coffee shop idea?", expectAny: ["cafe3", "nz18"] },
  { id: "q30", category: "英文提问", question: "How is my running plan going?", expectAny: ["fit1", "fit2"] },
  // —— R79 难例：跨碎片关系问句（多跳/时间跨度/为什么类/依据溯源类） ——
  // 为什么/依据溯源：答案必须能指向作为依据的具体笔记
  { id: "q31", category: "为什么依据", question: "我为什么想做周末快闪店？依据是哪几条笔记", expectAny: ["cafe2", "cafe3"], expectAll: ["cafe2", "cafe3"] },
  { id: "q32", category: "为什么依据", question: "星尘为什么从方案A换到方案B？当时的理由是什么", expectAny: ["proj2", "proj3"], expectAll: ["proj2", "proj3"] },
  { id: "q33", category: "为什么依据", question: "我为什么把跑步改成了游泳？哪条笔记记了原因", expectAny: ["fit2"], expectAll: ["fit2"] },
  { id: "q34", category: "为什么依据", question: "播客为什么搁置了？当时怕的是什么", expectAny: ["pod3"], expectAll: ["pod3"] },
  { id: "q35", category: "为什么依据", question: "我对「杠杆」的理解来自哪本书？具体是怎么说的", expectAny: ["naval2", "naval1"] },
  { id: "q36", category: "为什么依据", question: "我最后为什么决定暂缓换工作？依据是哪条", expectAny: ["job3"], expectAll: ["job3"], holdout: true },
  // 演化脉络：时间跨度上的想法变化，必须把链条上的碎片都带回来
  { id: "q37", category: "演化脉络", question: "关于换工作这事，我这几个月的想法是怎么变化的", expectAny: ["job1", "job2", "job3"], expectAll: ["job1", "job3"] },
  { id: "q38", category: "演化脉络", question: "播客这个想法从构思到现在经历了什么", expectAny: ["nz4", "pod2", "pod3"], expectAll: ["nz4", "pod3"] },
  { id: "q39", category: "演化脉络", question: "我的健身计划从开始到现在怎么变的，中间出了什么问题", expectAny: ["fit1", "fit2"], expectAll: ["fit1", "fit2"] },
  { id: "q40", category: "演化脉络", question: "学日语这两个多月我的方法和心得有什么变化", expectAny: ["jp1", "jp2"], expectAll: ["jp1", "jp2"], holdout: true },
  { id: "q41", category: "演化脉络", question: "咖啡馆这个点子从最初到现在经历了哪几次转折，每次的原因是什么", expectAny: ["cafe1", "cafe2", "cafe3"], expectAll: ["cafe1", "cafe2", "cafe3"] },
  // 多跳：需要沿实体关联把不同主题的碎片串起来
  { id: "q42", category: "多跳", question: "播客搁置和咖啡馆快闪店之间有什么关系", expectAny: ["pod3"], expectAll: ["pod3"] },
  { id: "q43", category: "多跳", question: "快闪店的豆子打算从哪里拿？这跟咖啡馆计划是怎么接上的", expectAny: ["nz12"], expectAll: ["nz12"] },
  { id: "q44", category: "多跳", question: "我停跑步这件事和买跑鞋的支出有什么关联", expectAny: ["fit2", "nz20"], expectAll: ["nz20"] },
  { id: "q45", category: "多跳", question: "星尘项目和我换工作的决定有什么关系", expectAny: ["job3"], expectAll: ["job3"] },
  { id: "q46", category: "多跳", question: "白板上的 Q3 目标里哪一条和我收藏的供应商链接对得上", expectAny: ["img1", "nz12"], expectAll: ["img1", "nz12"], holdout: true },
  { id: "q47", category: "多跳", question: "快闪店定价 35 的想法和之前担心的房租成本问题有什么关系", expectAny: ["nz18", "cafe2"], expectAll: ["nz18", "cafe2"] },
  // 时间跨度：限定时间窗口内的跨碎片梳理
  { id: "q48", category: "时间限定", question: "最近两周我在创业和职业上做了哪几个决定", expectAny: ["cafe3", "job3", "pod3", "nz18"] },
  { id: "q49", category: "时间限定", question: "两个月前我在烦恼什么事", expectAny: ["job1", "jp1"], holdout: true },
  // 口语指代 + 多跳组合：代词消解后还需图谱关联
  {
    id: "q50",
    category: "多跳",
    question: "那为什么后来又不想换了",
    history: [
      { role: "user", content: "我记过想换工作吗" },
      { role: "assistant", content: "记过，你因为加班多、业务边缘想换工作 [1]。" },
    ],
    expectAny: ["job2", "job3"],
    expectAll: ["job3"],
  },
  {
    id: "q51",
    category: "为什么依据",
    question: "它被搁置的原因是什么？第一期本来打算请谁",
    history: [
      { role: "user", content: "我那个播客的想法还在吗" },
      { role: "assistant", content: "在的，你想做一档聊普通人副业的播客 [1]。" },
    ],
    expectAny: ["pod3", "pod2"],
    expectAll: ["pod3", "pod2"],
    holdout: true,
  },
  { id: "q52", category: "演化脉络", question: "回顾一下我所有和副业相关的尝试和想法，都有哪些进展和变化", expectAny: ["nz4", "pod2", "pod3"], expectAll: ["pod3"], holdout: true },
  // 纯图跳难例：问句与目标碎片几乎无共同关键词，必须靠图谱/语义把另一端带回来
  { id: "q53", category: "多跳", question: "白板照片里的供应链目标后来有具体着落了吗", expectAny: ["img1", "nz12"], expectAll: ["nz12"] },
  { id: "q54", category: "多跳", question: "那个让我暂缓换工作的项目，技术方案上最近有什么进展", expectAny: ["job3", "proj3"], expectAll: ["job3", "proj3"] },
  { id: "q55", category: "为什么依据", question: "我说过因为精力不够先放一放的是什么事？它在等哪件事有结果", expectAny: ["pod3"], expectAll: ["pod3"] },
  { id: "q56", category: "多跳", question: "参加市集活动这个目标和我哪个创业想法是一体的", expectAny: ["img1", "cafe3"], expectAll: ["cafe3"], holdout: true },
  // —— R88 badcase：数字细节召回（用户研究中「土鸡蛋报价」类问题问不到） ——
  { id: "q57", category: "数字细节", question: "土鸡蛋报价是多少", expectAny: ["num1"], expectAll: ["num1"] },
  { id: "q58", category: "数字细节", question: "土鸡蛋礼盒装多少钱一盒，什么时候提货", expectAny: ["num1"], expectAll: ["num1"] },
  { id: "q59", category: "数字细节", question: "上次那个鸡蛋供应商的报价是每斤多少元来着", expectAny: ["num1"], expectAll: ["num1"], holdout: true },

  // —— 财务聚合（R108：必须走 SQL 精确聚合，绝不 LLM 心算）——
  {
    id: "q60",
    category: "财务聚合",
    question: "我一共花了多少钱",
    expectAny: ["exp1", "exp2", "nz20"],
    expectAnswerContains: ["笔支出", "口径与周报/月报一致"],
  },
  {
    id: "q61",
    category: "财务聚合",
    question: "最近30天总共消费了多少",
    expectAnswerContains: ["口径与周报/月报一致"],
    holdout: true,
  },
  {
    id: "q62",
    category: "财务聚合",
    question: "买机械键盘花了多少钱",
    // 具体单笔价格问题不走聚合短路，要命中具体那条支出
    expectAny: ["exp1"],
    holdout: true,
  },
  // —— R110（R109 P1 badcase）：「结余/收支」类措辞也必须走精确聚合 ——
  {
    id: "q63",
    category: "财务聚合",
    question: "上个月结余多少钱",
    expectAnswerContains: ["口径与周报/月报一致"],
  },
  {
    id: "q64",
    category: "财务聚合",
    question: "本月收支结余怎么样，一共多少",
    expectAnswerContains: ["口径与周报/月报一致"],
  },
  {
    id: "q65",
    category: "财务聚合",
    question: "这个月收支情况如何",
    expectAnswerContains: ["口径与周报/月报一致"],
    holdout: true,
  },
  // 带限定条件的合计：fail-closed，拒绝心算、给出精确整体口径
  {
    id: "q66",
    category: "财务聚合",
    question: "给猫花的钱合计有多少",
    expectAnswerContains: ["不做心算合计", "口径与周报/月报一致"],
  },

  // —— R114（R113 P1）：带历史时普通合计绝不能被改写带偏进 fail-closed ——
  {
    id: "q67",
    category: "财务聚合",
    question: "这个月一共花了多少钱",
    history: [
      { role: "user", content: "带猫打疫苗花了多少钱" },
      { role: "assistant", content: "你带猫打了三联疫苗，花了 260 块 [1]。" },
    ],
    expectAnswerContains: ["口径与周报/月报一致"],
    forbidAnswerContains: ["不做心算合计"],
  },
  {
    id: "q68",
    category: "财务聚合",
    question: "那买东西一共用了多少钱",
    history: [
      { role: "user", content: "我最近买过什么" },
      { role: "assistant", content: "你买了机械键盘 399 元 [1]和跑鞋 549 元 [2]。" },
    ],
    // 原始问题自带限定（买东西）：仍应 fail-closed
    expectAnswerContains: ["不做心算合计", "口径与周报/月报一致"],
    holdout: true,
  },

  // —— R114（R113 P1）：长对话后期检索命中绝不能答「没找到」 ——
  {
    id: "q69",
    category: "数字细节",
    question: "土鸡蛋的报价是每斤多少钱",
    // 模拟 UI 长对话第 9 轮：前面多轮话题与当前问题无关（历史污染场景）
    history: [
      { role: "user", content: "我最近在想什么" },
      { role: "assistant", content: "你在想咖啡馆快闪店 [1]、星尘项目方案 [2] 和换工作的事 [3]。" },
      { role: "user", content: "咖啡馆那个点子最新进展是什么" },
      { role: "assistant", content: "最新思路是周末快闪店试水，手冲定价 35 元 [1]。" },
      { role: "user", content: "星尘现在用什么方案" },
      { role: "assistant", content: "星尘改用方案B：消息队列解耦 [1]。" },
    ],
    expectAny: ["num1"],
    expectAll: ["num1"],
    expectAnswerContains: ["8.5"],
    forbidAnswerContains: ["没找到", "没有相关"],
  },

  // —— R126（R125 P1-3 / 计数矩阵）：极值与限定计数必须走 SQL 精确路径 ——
  {
    id: "q80",
    category: "统计聚合",
    question: "我最早的一条笔记是什么时候记的？",
    expectAnswerContains: ["最早的一条笔记记于", "数据库精确查询"],
  },
  {
    id: "q81",
    category: "统计聚合",
    question: "我最新的一条笔记是什么？",
    expectAnswerContains: ["最新的一条笔记记于"],
  },
  {
    id: "q82",
    category: "统计聚合",
    question: "我的待办有多少条？",
    expectAnswerContains: ["条待办笔记", "数据库精确统计"],
  },
  {
    id: "q83",
    category: "统计聚合",
    question: "想法类的笔记有几条？",
    expectAnswerContains: ["条想法笔记"],
  },
  {
    id: "q84",
    category: "统计聚合",
    question: "我一共收藏了多少条？",
    expectAnswerContains: ["条收藏笔记"],
  },
  {
    id: "q85",
    category: "统计聚合",
    question: "加密的敏感笔记有几条？",
    expectAnswerContains: ["加密的敏感笔记"],
  },
  {
    id: "q86",
    category: "统计聚合",
    question: "我平均每天记几条笔记？",
    expectAnswerContains: ["平均每天约"],
  },

  // —— R130（R129 R8 P1）：主题枚举必须走关键词全量筛选，不吃语义 top-k 亏 ——
  {
    id: "q87",
    category: "主题枚举",
    question: "我看过什么书",
    expectAny: ["naval1", "naval2"],
    expectAll: ["naval1", "naval2"],
    expectAnswerContains: ["精确筛选"],
  },
  {
    id: "q88",
    category: "主题枚举",
    question: "我都存过哪些菜谱？",
    expectAny: ["nz2"],
    expectAnswerContains: ["精确筛选"],
  },
  {
    id: "q89",
    category: "主题枚举",
    question: "关于健身的笔记有哪些",
    expectAny: ["fit1", "fit2"],
    expectAll: ["fit1", "fit2"],
    holdout: true,
  },
  // 首轮枚举成功后，序数追问靠既有历史改写解析（不设序数状态实体）
  {
    id: "q90",
    category: "主题枚举",
    question: "第一本讲什么",
    history: [
      { role: "user", content: "我看过什么书" },
      { role: "assistant", content: "和「书」相关的记录共 2 条：\n\n- ［收藏］《纳瓦尔宝典》笔记：财富与运气\n- ［收藏］纳瓦尔 vs 芒格" },
    ],
    expectAny: ["naval1"],
    holdout: true,
  },

  // —— R130（R129 R14 P2-1）：财务口径澄清追问直答是/否，不复读合计 ——
  {
    id: "q91",
    category: "财务澄清",
    question: "包括买跑鞋的钱吗",
    history: [
      { role: "user", content: "最近一个月花了多少钱" },
      { role: "assistant", content: "最近一个月你记了 3 笔支出，合计 ¥1023.00。（以上为按记账笔记的数据库精确合计，口径与周报/月报一致）" },
    ],
    expectAny: ["nz20"],
    expectAnswerContains: ["包括"],
    forbidAnswerContains: ["不做心算合计"],
  },
];
