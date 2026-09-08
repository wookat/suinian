// R328 B（decision-r328 §3）：R327 漏标 5 族回填数据层标注回归集。
// audit-r327 §3.1：H01 藏头 / H02 句尾藏字 / H06 URL query token / G04 口述数字 / G06 家庭暗语 整条无任何标注。
// 回填规则 = detectSensitive 复用出口层取值候选的强形态（sourceValueCandidates kind=credential）；弱形态（opaque）不进标注。
// 这是**已见语料回归**：38 危险载体里确定性规则能兜多少条如实登记，剩余交模型 + 出口层；不宣称族级封闭。
import { describe, it, expect } from "vitest";
import { detectSensitive, maybeSensitive } from "../src/triage";
import { sourceValueCandidates } from "../src/prompt-armor";
import { DANGER, B } from "../scripts/qa-r327/blind-carriers";
import { BENIGN as R309_BENIGN } from "../scripts/qa-r309/benign";
import { BENIGN_CASES as INJ_BENIGN } from "../scripts/injection-eval-data";

const credShape = (t: string) => sourceValueCandidates([t]).some((c) => c.kind === "credential");

describe("R328 B：R327 漏标 5 族的已见形态进确定性标注", () => {
  it("H01 / H02 / H06 / G04 / G06 五条（audit-r327 §3.1）整条 detectSensitive=true，写入前 maybeSensitive 同样 fail-closed", () => {
    for (const id of ["H01", "H02", "H06", "G04", "G06"]) {
      const c = DANGER.find((x) => x.id === id)!;
      const texts = c.texts.filter((t) => credShape(t));
      expect(texts.length, `${id} 至少一条正文命中强形态`).toBeGreaterThan(0);
      for (const t of texts) {
        expect(detectSensitive(t), `${id} detectSensitive`).toBe(true);
        expect(maybeSensitive(t), `${id} maybeSensitive`).toBe(true);
      }
    }
  });

  it("确定性规则在 38 危险载体上的覆盖如实登记（不宣称族级封闭）：R328 命中集 R327 漏标 5 条 + G05 + E02 / E03；R334 称谓驻留再补 E04 / M06 / S02 / U01–U05（decision-r334 §2.1）", () => {
    const hits = DANGER.filter((c) => c.texts.some(credShape)).map((c) => c.id);
    expect(hits).toEqual(["E02", "E03", "E04", "M06", "S02", "H01", "H02", "H06", "G04", "G05", "G06", "U01", "U02", "U03", "U04", "U05"]);
    const det = DANGER.filter((c) => c.texts.some((t) => detectSensitive(t))).length;
    // 其余靠模型分拣 + 出口层兜底；这里只锁定确定性规则不倒退
    expect(det).toBeGreaterThanOrEqual(12);
  });

  it("善意不误标：R327 善意 44 条 / r309 善意 / injection 善意 0 条命中新规则；detectSensitive 在 R327 善意上仍只有 R327 已登记的 BR01（BR08 维修师傅电话 R334 起不再定论标敏感）", () => {
    const newHits = [
      ...B.filter((c) => c.texts.some(credShape)).map((c) => `r327/${c.id}`),
      ...R309_BENIGN.filter((b) => credShape(b.text)).map((b) => `r309/${b.id}`),
      ...INJ_BENIGN.filter((b) => credShape(b.note)).map((b) => `inj/${b.id}`),
    ];
    // R334：BR01「家里 wifi 密码是 chunfeng2019」是称谓 + 赋值位的真口令，进凭证候选（R327 已接受的标注代价，audit-r327 §3.3）。
    expect(newHits).toEqual(["r327/BR01"]);
    const det = B.filter((c) => c.texts.some((t) => detectSensitive(t))).map((c) => c.id);
    expect(det).toEqual(["BR01"]);
  });
});
