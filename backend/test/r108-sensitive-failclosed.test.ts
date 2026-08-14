// R108: fail-closed sensitive pre-check for the pending-triage window
// (R107 P1-1: 「密码备忘：」句式漏过写入预检正则，明文进入默认脱敏备份)
import { describe, expect, it } from "vitest";
import { detectSensitive, maybeSensitive } from "../src/triage";
import { isFinanceAggQuestion, buildFinanceAggAnswer } from "../src/ask";
import { financeStats } from "../src/reports";
import type { NoteRow } from "../src/types";

describe("maybeSensitive fail-closed hint (pending window)", () => {
  const adversarialSensitive = [
    "密码备忘：测试站 admin / QaR107!burst",
    "密码备忘：路由器后台 admin888",
    "服务器 root 口令 P@ss2026 记一下",
    "新办的卡 pin 码 4821",
    "数据库账号 dbuser 密码 hunter2-demo",
    "prod 环境 secret 是 s3cr3t-v4lue",
    "这是 token: eyJhbGciOiJIUzI1NiJ9.abc.def",
    "身份证放在抽屉，号码 110101199003078515",
    "银行卡号 6222020200112233445 别忘了",
    "api key 备忘 sk-abcdefghijklmnop1234",
  ];
  for (const s of adversarialSensitive) {
    it(`hints sensitive: ${s.slice(0, 20)}`, () => {
      expect(maybeSensitive(s)).toBe(true);
    });
  }

  const plainNonSensitive = [
    "周末记得去买猫粮",
    "午饭吃了牛肉面 28 块",
    "读《纳瓦尔宝典》第四章，杠杆的三种形式很有启发",
    "下周三下午三点约了牙医",
    "React 19 的 use() hook 可以在渲染中读 promise",
  ];
  for (const s of plainNonSensitive) {
    it(`stays quiet on plain note: ${s.slice(0, 16)}`, () => {
      expect(maybeSensitive(s)).toBe(false);
    });
  }

  it("is broader than detectSensitive (topic word alone triggers the hint)", () => {
    const s = "密码备忘：测试站 admin / QaR107!burst";
    // the R107 leak: high-precision regex misses it, fail-closed hint must not
    expect(maybeSensitive(s)).toBe(true);
  });

  it("detectSensitive still catches classic assignment/literal forms", () => {
    expect(detectSensitive("家里 Wi-Fi 密码改成了 hunter2-demo")).toBe(true);
    expect(detectSensitive("sk-abcdefghijklmnop1234567890")).toBe(true);
    expect(detectSensitive("周末记得去买猫粮")).toBe(false);
  });

  it("technical docs discussing credentials also get the pending-window hint (model will clear them)", () => {
    // fail-closed by design: better to briefly over-encrypt than leak plaintext
    expect(maybeSensitive("部署文档：API key 写入环境变量，绝不要硬编码，示例 Bearer <token>")).toBe(true);
  });
});

const note = (over: Partial<NoteRow>): NoteRow =>
  ({
    id: "n1",
    user_id: "u1",
    source: "web",
    raw_type: "text",
    content: "x",
    url: null,
    category: "expense",
    tags: "[]",
    title: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    amount: 100,
    currency: "CNY",
    meta: null,
    created_at: "2026-08-01 03:00:00",
    updated_at: "2026-08-01 03:00:00",
    deleted_at: null,
    content_enc: null,
    ...over,
  }) as unknown as NoteRow;

describe("finance aggregate question detection (R107 P1-2)", () => {
  const agg = [
    "8月一共花了多少钱",
    "这个月总共花了多少钱",
    "上个月支出合计是多少",
    "最近30天一共消费了多少",
    "今年收入加起来有多少",
    "本周花销总共多少钱",
  ];
  for (const q of agg) {
    it(`aggregate: ${q}`, () => expect(isFinanceAggQuestion(q)).toBe(true));
  }

  const nonAgg = [
    "买咖啡花了多少钱",
    "机械键盘多少钱买的",
    "上个月给猫打疫苗花了多少钱",
    "8月有什么值得回顾的想法",
    "李医生的电话是多少",
  ];
  for (const q of nonAgg) {
    it(`not aggregate: ${q}`, () => expect(isFinanceAggQuestion(q)).toBe(false));
  }
});

describe("buildFinanceAggAnswer", () => {
  it("sums exactly with financeStats (no LLM arithmetic)", () => {
    const stats = financeStats([
      note({ amount: 6014 }),
      note({ amount: 264 }),
      note({ category: "income", amount: 1000 }),
    ]);
    const md = buildFinanceAggAnswer(stats, "8月");
    expect(md).toContain("2 笔支出");
    expect(md).toContain("1 笔收入");
    expect(md).toContain("6278");
    expect(md).toContain("口径与周报/月报一致");
  });

  it("reports empty scope clearly", () => {
    const md = buildFinanceAggAnswer(financeStats([]), "上个月");
    expect(md).toContain("没有记账记录");
  });

  it("counts unknown-amount notes separately", () => {
    const md = buildFinanceAggAnswer(financeStats([note({ amount: null })]), null);
    expect(md).toContain("1 笔未识别出金额");
  });
});
