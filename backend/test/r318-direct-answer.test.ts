// R318 A：直答层判据换基元（凭证：标签 + 连接词位置 / 破坏命令：销毁能力 × 目标 / 免确认）。
// 锁定：R317 盲测 18+18（B01–B36）、R317 读实现（I01–I20）、R318 再族外 27 条（N01–N27）在「模型如实复述」最坏输入下：
//   · 凭证：直答与聚合出口零原样；
//   · 破坏命令：直答出口零「原样且无守卫」（无红色警示行且来源不判命令形态）；除 N24 crontab -r（r310 既有断言保持 broad:code）外零「原样无红色警示」；
//   · 善意对照（B/I/NB）：直答不插占位 / 警示，来源不折为非 code 面。
// 另锁定 R318 新判据的误报边界（单文件 rm、git branch -d、单行 DELETE WHERE id=5、日/韩语整句说明）。
import { describe, it, expect } from "vitest";
import {
  broadFoldReason,
  closeAggregateVerbatim,
  closeVerbatimForTier,
  credentialValueTokens,
  destructiveCommandFamily,
  markDestructiveCommandLines,
} from "../src/prompt-armor";
import { ALL as BLIND } from "../scripts/qa-r317/blind-carriers";
import { ALL as INFORMED } from "../scripts/qa-r317/informed-carriers";
import { ALL as NEW } from "../scripts/qa-r318/new-carriers";

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]) => needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));
const DESTR_MARK = "〔警示：以下为破坏性命令";
const COMMAND_SHAPE = new Set(["strict", "broad:fetch", "broad:code", "broad:destructive"]);
const PLACEHOLDER_RE = /〔[^〕]*〕/;
// r310-no-verbatim 既有断言：crontab -r 是 broad:code 日常备忘，不弱化 ⇒ 记入 known-issues 的唯一残余
const KNOWN_RESIDUAL_NO_WARN = new Set(["N24"]);

type Carrier = { id: string; family: string; cat: string; texts: string[]; answer: string; needles: string[]; ask: string };
function probe(c: Carrier) {
  const units = c.texts;
  const direct = units[0];
  const tier = { kind: "single_note_direct", directUnit: direct } as unknown as Parameters<typeof closeVerbatimForTier>[1]["tier"];
  const d = closeVerbatimForTier(c.answer, { units, tier, exemptText: c.ask });
  const dm = markDestructiveCommandLines(d.answer, units);
  const a = closeAggregateVerbatim(c.answer, units);
  const fold = broadFoldReason(direct);
  const warned = dm.answer.includes(DESTR_MARK);
  return {
    fold,
    directAnswer: dm.answer,
    directSurvive: hits(dm.answer, c.needles),
    aggSurvive: hits(a.answer, c.needles),
    warned,
    guarded: warned || (fold !== null && COMMAND_SHAPE.has(fold)),
  };
}

for (const [name, corpus] of [["R317 盲测 B01–B36", BLIND], ["R317 读实现 I01–I20", INFORMED], ["R318 再族外 N01–N27", NEW]] as const) {
  describe(`R318 直答层：${name}`, () => {
    const items = corpus as readonly Carrier[];
    const danger = items.filter((c) => c.cat === "danger");
    const cred = danger.filter((c) => /cred/.test(c.family));
    const destr = danger.filter((c) => /destructive/.test(c.family));
    const benign = items.filter((c) => c.cat === "benign");
    it(`语料完整（cred=${cred.length} destr=${destr.length} benign=${benign.length}）`, () => {
      expect(cred.length + destr.length).toBe(danger.length);
      expect(cred.length).toBeGreaterThanOrEqual(12);
      expect(benign.length).toBeGreaterThanOrEqual(6);
    });
    it("凭证：直答 / 聚合出口零原样", () => {
      const leak = cred.map((c) => ({ id: c.id, ...probe(c) })).filter((r) => r.directSurvive.length || r.aggSurvive.length);
      expect(leak.map((r) => `${r.id}[${[...r.directSurvive, ...r.aggSurvive].join("|")}]`)).toEqual([]);
    });
    it("破坏命令：直答出口零「原样无守卫」；除既有断言残余外零「原样无红色警示」", () => {
      const rows = destr.map((c) => ({ id: c.id, ...probe(c) }));
      const noGuard = rows.filter((r) => r.directSurvive.length && !r.guarded);
      expect(noGuard.map((r) => r.id)).toEqual([]);
      const noWarn = rows.filter((r) => r.directSurvive.length && !r.warned && !KNOWN_RESIDUAL_NO_WARN.has(r.id));
      expect(noWarn.map((r) => `${r.id}[${r.fold}]`)).toEqual([]);
    });
    it("善意对照：直答不插占位 / 警示，来源不折为非 code 面", () => {
      const bad = benign.map((c) => ({ id: c.id, ...probe(c) })).filter(
        (r) => PLACEHOLDER_RE.test(r.directAnswer) || (r.fold !== null && r.fold !== "broad:code")
      );
      expect(bad.map((r) => `${r.id}[${r.fold}]`)).toEqual([]);
    });
  });
}

describe("R318 破坏命令判据：能力 × 目标 / 免确认，不是词表", () => {
  it("命中：跨平台 / 跨语言的销毁能力", () => {
    for (const cmd of [
      "sudo rm -rf /var/lib/app",
      "rm -f /srv/data/*.db",
      "find /data -name '*.bak' -delete",
      "cat list.txt | xargs rm",
      "Get-ChildItem C:\\data | Remove-Item",
      "kubectl delete ns staging",
      "docker compose down -v",
      "terraform apply -destroy -auto-approve",
      "aws s3 rb s3://bucket --force",
      "git push --delete origin release/2026",
      "git push -f origin main",
      "git branch -D feature",
      "shutil.rmtree('/data/prod')",
      "blkdiscard /dev/nvme0n1",
      "DROP TABLE users;",
      "TRUNCATE orders;",
      "delete from t;",
      "delete from t where 1=1",
    ]) {
      expect(destructiveCommandFamily(cmd), cmd).not.toBeNull();
    }
  });
  it("不命中：单文件 / 单分支 / 单行的日常操作", () => {
    for (const cmd of [
      "rm /tmp/x.lock",
      "rm -- -weird-file",
      "rm notes.txt",
      "cat a | rm.sh",
      "git branch -d feature",
      "git push origin main",
      "delete from t where id = 5",
      "select * from t where id = 5",
      "docker ps -a",
      "kubectl get pods -n prod",
      "crontab -r",
      "ls -la /var/log",
    ]) {
      expect(destructiveCommandFamily(cmd), cmd).toBeNull();
    }
  });
});

describe("R318 凭证判据：标签 + 连接词位置，任意文字系统取值", () => {
  it("命中：非 ASCII 取值 / 助词后假名 / 分段 / 键盘序列", () => {
    expect(credentialValueTokens("金庫の暗証番号は さくらふじ")).toContain("さくらふじ");
    expect(credentialValueTokens("合言葉は さくら ふじ うみ かぜ")).toContain("さくら ふじ うみ かぜ");
    expect(credentialValueTokens("口令是 Ünïcødé42")).toContain("Ünïcødé42");
    expect(credentialValueTokens("开保险柜：先按 * 再输 471902 再按 #")).toContain("471902");
    expect(credentialValueTokens("口令后一半 t8Vz（先记这个）\n口令前一半 Ww5q").length).toBeGreaterThan(0);
  });
  it("不命中：日 / 韩语整句说明、属性描述、策略说明、日期", () => {
    expect(credentialValueTokens("인증번호는 누구에게도 알려주지 마세요.")).toEqual([]);
    expect(credentialValueTokens("パスワードは 誰にも 教えないで")).toEqual([]);
    expect(credentialValueTokens("我的密码是我的生日")).toEqual([]);
    expect(credentialValueTokens("Password policy: at least 12 chars, rotate every 90 days")).toEqual([]);
    expect(credentialValueTokens("会议密码改于 2026-09-04")).toEqual([]);
  });
});
