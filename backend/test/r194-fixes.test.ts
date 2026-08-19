// R194（audit-r193）：
// P1   负数/退款行台账逃逸——LEDGER_MONEY_RE 只认正数，一行退款让整表不成
//      台账、合计冒充单笔进入序数排名；收口为同一管道允许带符号金额，
//      并与 R192 分隔符变体合并成一套台账形态用例集（分隔符×正负号×
//      极值/序数组合）锁住口径；
// P2-1 备份恢复静默丢弃 threads.json/reports.json——报告直接导入（同周期
//      幂等跳过），线索计数上报由后台聚类重建；
// P2-2 剪藏外壳下「admin / <串>」无主题词凭证对漏判——detectSensitive 补
//      确定性凭证对规则（R193 6/6 复现用例锁死）。
// P2-5 bridge heartbeat 越权写——任意合法用户 token 曾可写全局 bridge 状态
//      伪装 online 骗过健康探针；收口为专用 BRIDGE_TOKEN（或 ADMIN_TOKEN）。
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { app } from "../src/index";
import { parseLedgerTable, parseLedgerCore, detectSensitive, maybeSensitive } from "../src/triage";
import { financeExtremeIntent, isLedgerAggregateNote } from "../src/ask";

// 序数问法数字两侧带空格（「第 2 大」，R193 生产原文）也必须收口
// 进确定性财务极值/序数路由，不得漏给 LLM 猜排序。
describe("带空格序数问法收口 (R194 P1)", () => {
  it("第 2 大的一笔支出（阿拉伯数字带空格）", () => {
    expect(financeExtremeIntent("第 2 大的一笔支出是哪笔？")).toEqual({ kind: "max", direction: "expense", rank: 2 });
  });
  it("倒数第 3 便宜", () => {
    expect(financeExtremeIntent("倒数第 3 便宜的支出是什么")).toEqual({ kind: "max", direction: "expense", rank: 3, reversedAdj: "便宜" });
  });
  it("不带空格行为不变", () => {
    expect(financeExtremeIntent("第2大的一笔支出是哪笔")).toEqual({ kind: "max", direction: "expense", rank: 2 });
  });
  it("时间序数不误收口", () => {
    expect(financeExtremeIntent("我第 2 次买咖啡是什么时候")).toBeNull();
  });
});
import { restoreBackup, BACKUP_FORMAT } from "../src/backup";
import type { Env } from "../src/types";

// ---- P1: 台账形态用例集（分隔符 × 正负号 × 合计 × 序数）----

describe("parseLedgerTable 负数/退款行 (R194 P1)", () => {
  // R193 P1 原始复现：一行退款曾让整表不成台账，合计 ¥454 冒充单笔
  const REFUND = { amount: 420.5, rows: 4 };
  it("含退款行的逗号台账照常识别，合计为带符号求和", () => {
    expect(parseLedgerTable("早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5")).toEqual(REFUND);
  });
  it("退款行 × 全部分隔符变体（R192 用例集合并）口径一致", () => {
    expect(parseLedgerTable("早餐豆浆油条\t12.5\n请客吃饭\t155\n快递退款\t-33.5\n团建烧烤\t286.5")).toEqual(REFUND);
    expect(parseLedgerTable("早餐豆浆油条;12.5\n请客吃饭;155\n快递退款;-33.5\n团建烧烤;286.5")).toEqual(REFUND);
    expect(parseLedgerTable("早餐豆浆油条；12.5\n请客吃饭；155\n快递退款；-33.5\n团建烧烤；286.5")).toEqual(REFUND);
    expect(parseLedgerTable("早餐豆浆油条，12.5\n请客吃饭，155\n快递退款，-33.5\n团建烧烤，286.5")).toEqual(REFUND);
    expect(parseLedgerTable("早餐豆浆油条 12.5\n请客吃饭 155\n快递退款 -33.5\n团建烧烤 286.5")).toEqual(REFUND);
    expect(parseLedgerTable("早餐豆浆油条,12.5\n请客吃饭 155\n快递退款\t-33.5\n团建烧烤;286.5")).toEqual(REFUND);
  });
  it("负号写法变体：币符前/币符后/U+2212 负号/带「元」后缀", () => {
    expect(parseLedgerTable("A,-¥12.5\nB,155")).toEqual({ amount: 142.5, rows: 2 });
    expect(parseLedgerTable("A,¥-12.5\nB,155")).toEqual({ amount: 142.5, rows: 2 });
    expect(parseLedgerTable("A,−12.5\nB,155")).toEqual({ amount: 142.5, rows: 2 });
    expect(parseLedgerTable("A,-12.5元\nB,155元")).toEqual({ amount: 142.5, rows: 2 });
  });
  it("全表皆退款（净负合计）不丢台账身份", () => {
    expect(parseLedgerTable("退货,-155\n退款,-33.5")).toEqual({ amount: -188.5, rows: 2 });
  });
  it("含退款行 + 合计行取合计值", () => {
    expect(parseLedgerTable("早餐,12.5\n退款,-4\n合计,8.5")).toEqual({ amount: 8.5, rows: 2 });
  });
  it("含退款行 + 表头/标题行照常解析", () => {
    expect(parseLedgerTable("项目,金额\n早餐,12.5\n退款,-4")).toEqual({ amount: 8.5, rows: 2 });
    expect(parseLedgerTable("本周流水\n早餐 12.5\n退款 -4")).toEqual({ amount: 8.5, rows: 2 });
  });
  it("0 值不算金额单元（空/零行不冒充数据），歧义表格仍 fail-closed", () => {
    expect(parseLedgerTable("A,0\nB,0")).toBeNull();
    expect(parseLedgerCore("1,-12.5\n2,-155")).toBe("ambiguous"); // 两列全是带符号数字
  });
  it("散文/单笔不误判（既有口径不回归）", () => {
    expect(parseLedgerTable("今天退了快递 -33.5 元\n心情不错")).toBeNull();
    expect(parseLedgerTable("买键盘 459")).toBeNull();
  });
});

describe("isLedgerAggregateNote 含退款台账不冒充单笔 (R194 P1)", () => {
  const refundLedger = {
    content: "早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5",
    amount: 420.5,
  };
  it("含退款行的台账合计被识别为台账聚合，序数/极值排名会排除之", () => {
    expect(isLedgerAggregateNote(refundLedger)).toBe(true);
  });
  it("用户手改过金额（与解析合计不符）则照常按单笔参与", () => {
    expect(isLedgerAggregateNote({ ...refundLedger, amount: 155 })).toBe(false);
  });
});

// ---- P2-2: 无主题词凭证对 ----

describe("detectSensitive 凭证对规则 (R194 P2-2)", () => {
  it("R193 6/6 复现用例：剪藏外壳包裹的「admin / <串>」判敏感", () => {
    expect(detectSensitive("测试环境后台 admin / Sx-R193-mx-77")).toBe(true);
    expect(
      detectSensitive(
        "[QA-R193] 剪藏含凭证：测试环境后台 admin / Ext-R193-clip-7742\n摘录自内部 wiki 的部署说明片段\nhttps://wiki.example.com/deploy"
      )
    ).toBe(true);
    expect(maybeSensitive("测试环境后台 admin / Sx-R193-mx-77")).toBe(true);
  });
  it("「用户名/账号 xxx / 口令串」变体判敏感", () => {
    expect(detectSensitive("后台登录：用户名 ops-r193 / Sx-R193-mx7")).toBe(true);
    expect(detectSensitive("账号 dev01 ｜ Qa-2026-secret8")).toBe(true);
  });
  it("非凭证的斜杠写法不误伤", () => {
    expect(detectSensitive("进度 12/34 完成")).toBe(false);
    expect(detectSensitive("日期 2026/08/19 开会")).toBe(false);
    expect(detectSensitive("A/B 测试方案 v2")).toBe(false);
    expect(detectSensitive("路径 /usr/admin/bin2 下的脚本")).toBe(false);
    expect(detectSensitive("https://example.com/admin/foo123bar")).toBe(false);
    expect(detectSensitive("磁盘 sda1 / sda2 分区")).toBe(false);
  });
  it("右侧不是口令形态（纯字母/纯数字/过短）不命中", () => {
    expect(detectSensitive("admin / password")).toBe(false);
    expect(detectSensitive("root / 12345678")).toBe(false);
    expect(detectSensitive("admin / a1b2")).toBe(false);
  });
});

// ---- P2-1: 备份恢复 reports/threads ----

interface Recorded {
  sql: string;
  binds: unknown[];
}

function fakeDb(opts: { inserted: Recorded[]; existingReports?: Set<string> }) {
  return {
    prepare(sql: string) {
      const make = (binds: unknown[]) => ({
        bind(...args: unknown[]) {
          return make(args);
        },
        async first() {
          if (sql.includes("FROM weekly_reports") && opts.existingReports?.has(`${binds[1]}|${binds[2]}`)) {
            return { id: "existing" };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          opts.inserted.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
        _sql: sql,
        _binds: binds,
      });
      return make([]);
    },
    async batch(stmts: { _sql: string; _binds: unknown[] }[]) {
      for (const s of stmts) opts.inserted.push({ sql: s._sql, binds: s._binds });
      return [];
    },
  } as unknown as D1Database;
}

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

function makeZip(extra: Record<string, Uint8Array>): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ format: BACKUP_FORMAT, version: 1 })),
    "notes.json": strToU8("[]"),
    ...extra,
  });
}

describe("restoreBackup 消费 reports.json / threads.json (R194 P2-1)", () => {
  const REPORTS = [
    { week_start: "2026-08-03", period: "week", content_md: "# 周报\n本周记录了 3 条" },
    { week_start: "2026-08-01", period: "month", content_md: "# 月报\n本月记录了 12 条" },
    { week_start: "bad-date", period: "week", content_md: "x" },
  ];

  it("历史周报/月报直接导入，字段无效的跳过并计数", async () => {
    const inserted: Recorded[] = [];
    const env = { DB: fakeDb({ inserted }), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" } as unknown as Env;
    const zip = makeZip({ "reports.json": strToU8(JSON.stringify(REPORTS)) });
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ reports_imported: 2, reports_skipped: 1 });
    const reportInserts = inserted.filter((r) => r.sql.includes("INSERT INTO weekly_reports"));
    expect(reportInserts).toHaveLength(2);
    expect(reportInserts[0].binds[1]).toBe("u9");
    expect(reportInserts[0].binds[2]).toBe("2026-08-03");
    expect(reportInserts[0].binds[3]).toBe("week");
    expect(reportInserts[1].binds[3]).toBe("month");
  });

  it("同周期已有报告时幂等跳过（重复恢复不产生重复报告）", async () => {
    const inserted: Recorded[] = [];
    const env = {
      DB: fakeDb({ inserted, existingReports: new Set(["2026-08-03|week", "2026-08-01|month"]) }),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = makeZip({ "reports.json": strToU8(JSON.stringify(REPORTS)) });
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ reports_imported: 0, reports_skipped: 3 });
    expect(inserted.filter((r) => r.sql.includes("INSERT INTO weekly_reports"))).toHaveLength(0);
  });

  it("threads.json 计数上报（由后台聚类重建），不直接建线索行", async () => {
    const inserted: Recorded[] = [];
    const env = { DB: fakeDb({ inserted }), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" } as unknown as Env;
    const zip = makeZip({
      "threads.json": strToU8(JSON.stringify([{ id: "t1", title: "产品思考" }, { id: "t2", title: "健身" }])),
    });
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ threads_rebuilt: 2 });
    expect(inserted.filter((r) => r.sql.includes("INSERT INTO threads"))).toHaveLength(0);
  });

  it("无 reports/threads 的旧备份包照常恢复（计数为 0）", async () => {
    const inserted: Recorded[] = [];
    const env = { DB: fakeDb({ inserted }), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" } as unknown as Env;
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(makeZip({})), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ reports_imported: 0, reports_skipped: 0, threads_rebuilt: 0 });
  });
});

// ---- P2-5: bridge heartbeat 专用凭证 ----

function heartbeatDb(writes: Recorded[]) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users")) return binds[0] === "user-token" ? { id: "u1" } : null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          writes.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe("POST /api/bridge/heartbeat 鉴权 (R194 P2-5)", () => {
  function makeEnv(writes: Recorded[], extra: Record<string, string> = {}) {
    return { DB: heartbeatDb(writes), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", ...extra };
  }
  const post = (env: ReturnType<typeof makeEnv>, token?: string) =>
    app.request(
      "/api/bridge/heartbeat",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ status: "online" }),
      },
      env
    );

  it("普通用户 token 不能再写全局 bridge 状态（401，无写入）", async () => {
    const writes: Recorded[] = [];
    const res = await post(makeEnv(writes, { BRIDGE_TOKEN: "bridge-secret" }), "user-token");
    expect(res.status).toBe(401);
    expect(writes.filter((w) => w.sql.includes("cron_heartbeats"))).toHaveLength(0);
  });

  it("无 token / 错 token 一律 401", async () => {
    const writes: Recorded[] = [];
    const env = makeEnv(writes, { BRIDGE_TOKEN: "bridge-secret" });
    expect((await post(env)).status).toBe(401);
    expect((await post(env, "wrong")).status).toBe(401);
    expect(writes.filter((w) => w.sql.includes("cron_heartbeats"))).toHaveLength(0);
  });

  it("专用 BRIDGE_TOKEN 正常写入心跳（现有 bridge 不破坏）", async () => {
    const writes: Recorded[] = [];
    const res = await post(makeEnv(writes, { BRIDGE_TOKEN: "bridge-secret" }), "bridge-secret");
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("cron_heartbeats"))).toBe(true);
  });

  it("ADMIN_TOKEN 亦可写（运维兜底）；两者都未配置时端点关闭（404）", async () => {
    const writes: Recorded[] = [];
    const res = await post(makeEnv(writes, { ADMIN_TOKEN: "admin-secret" }), "admin-secret");
    expect(res.status).toBe(200);
    const res2 = await post(makeEnv([]), "anything");
    expect(res2.status).toBe(404);
  });

  it("合法凭证 + 非法 status 仍 400", async () => {
    const writes: Recorded[] = [];
    const res = await app.request(
      "/api/bridge/heartbeat",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bridge-secret" },
        body: JSON.stringify({ status: "hacked" }),
      },
      makeEnv(writes, { BRIDGE_TOKEN: "bridge-secret" })
    );
    expect(res.status).toBe(400);
  });
});
