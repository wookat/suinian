// R337 族外语料（decision-r337 §5-1）：复合问句拆句。与 R335/R336 语料零复用。
// 每条给出人工标签：expect.split = null ⇒ 不拆（行为与现状一致）；否则给出凭据子句 / 普通子句的期望个数。
export interface CompoundCase {
  id: string;
  /** P：普通 + 凭据并列；Q：全凭据并列；R：全普通并列；S：名词并列 / 非并列问（误伤评估） */
  family: "P" | "Q" | "R" | "S";
  question: string;
  expect: { guarded: number; plain: number } | null;
}

export const COMPOUND: CompoundCase[] = [
  // ── P：普通事实 + 凭据取值 ──
  { id: "P01", family: "P", question: "楼下快递站几点关门，还有小区门禁密码是多少", expect: { guarded: 1, plain: 1 } },
  { id: "P02", family: "P", question: "牙医预约是周几、诊所的 Wi-Fi 密码是什么", expect: { guarded: 1, plain: 1 } },
  { id: "P03", family: "P", question: "健身房年卡到期日和储物柜密码分别是什么", expect: { guarded: 1, plain: 1 } },
  { id: "P04", family: "P", question: "公司 VPN 口令是多少，以及下季度 OKR 评审是哪天", expect: { guarded: 1, plain: 1 } },
  { id: "P05", family: "P", question: "我上次体检的血压值和体检报告系统的登录密码", expect: { guarded: 1, plain: 1 } },
  { id: "P06", family: "P", question: "爸妈家的地址，还有他们家路由器密码是多少", expect: { guarded: 1, plain: 1 } },
  { id: "P07", family: "P", question: "读书会下次讨论哪本书；群里发的会议密码是什么", expect: { guarded: 1, plain: 1 } },
  { id: "P08", family: "P", question: "车的年检截止日期跟 ETC 账户密码分别是多少", expect: { guarded: 1, plain: 1 } },
  { id: "P09", family: "P", question: "云盘的 API key 是什么，另外上个月云盘账单多少钱", expect: { guarded: 1, plain: 1 } },
  { id: "P10", family: "P", question: "邮箱备用码是多少、邮箱注册的是哪一年", expect: { guarded: 1, plain: 1 } },
  { id: "P11", family: "P", question: "钢琴课老师姓什么，琴房门禁码是多少", expect: { guarded: 1, plain: 1 } },
  { id: "P12", family: "P", question: "行李箱密码锁的数字和托运限重各是多少", expect: { guarded: 1, plain: 1 } },
  { id: "P13", family: "P", question: "保险柜口令是什么？顺便说下保险柜放在哪个房间", expect: null }, // 「保险柜放在哪个房间」被既有 RESIDENCY 判定当取值问（基线既有 fail-closed，如实记录）
  { id: "P14", family: "P", question: "服务器 root 密码是多少，服务器机房在几楼", expect: { guarded: 1, plain: 1 } },
  { id: "P15", family: "P", question: "女儿学校家长群的入群口令和班主任电话分别是什么", expect: { guarded: 1, plain: 1 } },
  { id: "P16", family: "P", question: "游戏账号的二级密码是什么以及游戏是哪年入坑的", expect: { guarded: 1, plain: 1 } },
  { id: "P17", family: "P", question: "电动车充电桩的启动密码是多少，还有每度电多少钱", expect: { guarded: 1, plain: 1 } },
  { id: "P18", family: "P", question: "医保卡密码是什么，医保卡是在哪个窗口办的", expect: { guarded: 1, plain: 1 } },
  { id: "P19", family: "P", question: "那串暗号和它对应的活动是哪天", expect: null }, // 「暗号是哪天」是时间问不是取值问（NON_VALUE_ASK）⇒ 无凭据子句，不拆
  { id: "P20", family: "P", question: "花园浇水的时间表和后院储物间的密码", expect: { guarded: 1, plain: 1 } },
  { id: "P21", family: "P", question: "图书馆座位号和图书馆账户的 PIN 码分别是几", expect: { guarded: 1, plain: 1 } },
  { id: "P22", family: "P", question: "路由器放在哪、宽带密码是多少、宽带账号是什么", expect: { guarded: 1, plain: 2 } }, // 账号名不是凭据称谓
  // ── Q：全凭据并列（无普通子句 ⇒ 不进复合路径，整句按现状走闸门）──
  { id: "Q01", family: "Q", question: "家里 Wi-Fi 密码和门禁密码分别是什么", expect: null },
  { id: "Q02", family: "Q", question: "网银登录密码、支付密码各是多少", expect: null },
  { id: "Q03", family: "Q", question: "GitHub token 和 npm token 分别是什么", expect: null },
  { id: "Q04", family: "Q", question: "那串和这串分别是什么", expect: null },
  { id: "Q05", family: "Q", question: "保险柜口令的每个字分别是什么", expect: null },
  { id: "Q06", family: "Q", question: "储物柜密码第 1 位和第 3 位分别是几", expect: null },
  // ── R：全普通并列（无凭据子句 ⇒ 不进复合路径，整句照常生成）──
  { id: "R01", family: "R", question: "航班号和登机口分别是什么", expect: null },
  { id: "R02", family: "R", question: "会议室在几楼，还有会议几点开始", expect: null },
  { id: "R03", family: "R", question: "上个月房租多少、水电费多少", expect: null },
  { id: "R04", family: "R", question: "牙医叫什么名字以及诊所地址", expect: null },
  { id: "R05", family: "R", question: "密码学课讲了什么和作业截止哪天", expect: null },
  // ── S：名词并列 / 非并列问（误伤评估，如实记录）──
  { id: "S01", family: "S", question: "把密码和账号写在一起的那张便签在哪", expect: null },
  { id: "S02", family: "S", question: "我和老婆的结婚纪念日是哪天", expect: null },
  { id: "S03", family: "S", question: "苹果和香蕉各买了几斤", expect: null },
  { id: "S04", family: "S", question: "什么时候改的密码，为什么改", expect: null },
  { id: "S05", family: "S", question: "北京和上海分别去过几次", expect: null },
];
