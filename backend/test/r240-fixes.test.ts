import { describe, it, expect } from "vitest";
import {
  financeTopicTerms,
  financeAggIntent,
  countQueryIntent,
  financeExtremeIntent,
  financeExtremeTopicTerms,
  degradeFinanceSubsetTerms,
  financeThresholdIntent,
  financeThresholdTopicTerms,
  buildFinanceThresholdAnswer,
  FINANCE_WORD_RE,
  hitsSingleCharTopic,
} from "../src/ask";
import { app, ASK_NORMALIZE_SYSTEM } from "../src/index";
import { hashPassword } from "../src/auth";

// ---- P2-1（audit-r239 §4.2）：单字语气/停用字只在独立成段时剥离 ----

describe("R240 P2-1 filler stripping never damages word-internal characters", () => {
  it("keeps 成都 intact in finance subset extraction (root case)", () => {
    expect(financeTopicTerms("成都出差一共花了多少钱")).toContain("成都出差");
    expect(financeTopicTerms("成都一共花了多少钱")).toContain("成都");
  });

  it("keeps other embedded filler characters (有道/和平/在行/了解)", () => {
    expect(financeTopicTerms("有道课程一共花了多少钱")).toContain("有道课程");
    expect(financeTopicTerms("和平精英一共花了多少钱")).toContain("和平精英");
  });

  it("still strips standalone filler words so overall aggregates stay exact", () => {
    expect(financeAggIntent("这个月都花了多少钱")).toBe("exact");
    expect(financeAggIntent("请问我这个月一共花了多少钱啊")).toBe("exact");
  });

  it("count intent: standalone fillers stripped, embedded ones kept", () => {
    expect(countQueryIntent("一共记了多少条笔记")?.intent).toBe("exact");
    // 日记 的「记」嵌在实词内：残留应触发 fail_closed 而不是误判全量 exact
    expect(countQueryIntent("日记记了多少条")?.intent).toBe("fail_closed");
  });

  it("extreme topic terms keep embedded place names", () => {
    expect(financeExtremeTopicTerms("成都出差里最贵的一笔支出是多少")).toContain("成都出差");
  });

  it("degrade retries edge-trimmed variants without gutting 成都", () => {
    const d = degradeFinanceSubsetTerms(["在成都"]);
    expect(d).toContain("成都");
    expect(d ?? []).not.toContain("成");
    // 尾部助词剥离
    expect(degradeFinanceSubsetTerms(["咖啡豆的"])).toContain("咖啡豆");
  });
});

// ---- P2-2（audit-r239 §4.3）：top N + 财务词收口确定性极值管道 ----

describe("R240 P2-2 top-N with finance wording routes deterministically", () => {
  it("routes top 2 的支出分别是多少", () => {
    const r = financeExtremeIntent("top 2 的支出分别是多少");
    expect(r).not.toBeNull();
    expect(r?.count).toBe(2);
    expect(r?.kind).toBe("max");
    expect(r?.direction).toBe("expense");
  });

  it("routes top 3 支出是哪三笔", () => {
    expect(financeExtremeIntent("top 3 支出是哪三笔")?.count).toBe(3);
  });

  it("still requires a finance cue (top 5 的书 is not a finance ranking)", () => {
    expect(financeExtremeIntent("top 5 的书有哪些")).toBeNull();
  });
});

// ---- P2-3（audit-r239 §4.4）：金额阈值筛选确定性管道 ----

describe("R240 P2-3 amount-threshold intent", () => {
  it("parses 超过80元的支出", () => {
    expect(financeThresholdIntent("列出超过80元的支出")).toEqual({
      direction: "expense",
      op: "gt",
      amount: 80,
      currency: "CNY",
    });
  });

  it("parses 100元以上的收入 (postfix form, income)", () => {
    expect(financeThresholdIntent("100元以上的收入有几笔")).toEqual({
      direction: "income",
      op: "gte",
      amount: 100,
      currency: "CNY",
    });
  });

  it("parses foreign currency and 不到 (lt)", () => {
    expect(financeThresholdIntent("不到20美元的消费有哪些")).toEqual({
      direction: "expense",
      op: "lt",
      amount: 20,
      currency: "USD",
    });
  });

  it("rejects non-amount thresholds and non-finance questions", () => {
    expect(financeThresholdIntent("超过100笔的支出月份")).toBeNull();
    expect(financeThresholdIntent("打卡超过3次的记录")).toBeNull();
    // 极值问法交既有极值管道
    expect(financeThresholdIntent("超过80元里最贵的一笔支出")).toBeNull();
  });

  it("extracts topic qualifier and returns null when none", () => {
    expect(financeThresholdTopicTerms("超过80元的餐饮支出有哪些")).toEqual(["餐饮"]);
    expect(financeThresholdTopicTerms("列出超过80元的支出")).toBeNull();
  });

  it("builds a deterministic answer with exact count and total", () => {
    const md = buildFinanceThresholdAnswer(
      { direction: "expense", op: "gt", amount: 80, currency: "CNY" },
      [
        { id: "a", title: "打车去机场", content: "打车去机场", created_at: "2026-08-01 00:00:00", is_sensitive: 0, amount: 120, currency: "CNY" },
        { id: "b", title: null, content: "买键盘", created_at: "2026-08-02 00:00:00", is_sensitive: 0, amount: 99, currency: "CNY" },
      ],
      { unknownAmount: 1, otherCurrency: 2, ledgerExcluded: 0 },
      "这个月",
      null
    );
    expect(md).toContain("共 2 笔");
    expect(md).toContain("219");
    expect(md).toContain("未识别出金额");
    expect(md).toContain("其他币种");
  });
});

// ---- P3-1（audit-r239 §7）：收到/拿到钱类收入措辞进聚合管道 ----

describe("R240 P3-1 income wording", () => {
  it("收到多少钱 routes to the exact aggregate path", () => {
    expect(FINANCE_WORD_RE.test("这个月收到多少钱")).toBe(true);
    expect(financeAggIntent("这个月收到多少钱")).toBe("exact");
  });

  it("收到 without money context is not a finance cue", () => {
    expect(FINANCE_WORD_RE.test("收到快递了吗")).toBe(false);
  });

  it("normalize prompt covers receive/threshold examples", () => {
    expect(ASK_NORMALIZE_SYSTEM).toContain("收到多少钱");
    expect(ASK_NORMALIZE_SYSTEM).toContain("超过 80 元的支出");
  });
});

// ---- P3-2（audit-r239 §5 r08）：单字主题枚举独立成词判定 ----

describe("R240 P3-2 single-char topic enumeration hit check", () => {
  it("rejects 书 embedded in 书房/证书", () => {
    expect(hitsSingleCharTopic("路由器说明书？不，放在书房柜子里", "书")).toBe(false);
    expect(hitsSingleCharTopic("拿到了毕业证书", "书")).toBe(false);
  });

  it("accepts standalone usages (本书/买书/书。)", () => {
    expect(hitsSingleCharTopic("买了一本书《置身事内》", "书")).toBe(true);
    expect(hitsSingleCharTopic("周末去图书馆借书", "书")).toBe(true);
    expect(hitsSingleCharTopic("书", "书")).toBe(true);
  });
});

// ---- P3-3（audit-r239 §8）：密码缺失/错误提示语分开 ----

function exportEnv(passwordHash: string | null) {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("password_hash FROM users")) return { password_hash: passwordHash };
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("auth_rate_limits")) return { count: 1 };
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { DB: db, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
}

describe("R240 P3-3 export password errors are distinguishable", () => {
  const auth = { authorization: "Bearer good-token" };

  it("missing password asks the user to enter one", async () => {
    const env = exportEnv(await hashPassword("secret-pw"));
    const res = await app.request("/api/export?include_sensitive=true", { headers: auth }, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; password_required?: boolean; password_incorrect?: boolean };
    expect(body.error).toContain("请输入密码");
    expect(body.password_incorrect).toBeUndefined();
  });

  it("wrong password says the password is incorrect", async () => {
    const env = exportEnv(await hashPassword("secret-pw"));
    const res = await app.request(
      "/api/export?include_sensitive=true",
      { headers: { ...auth, "x-suinian-password": "wrong" } },
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; password_incorrect?: boolean };
    expect(body.error).toContain("密码不正确");
    expect(body.password_incorrect).toBe(true);
  });
});
