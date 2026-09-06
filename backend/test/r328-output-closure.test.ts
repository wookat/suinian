// R328 A（decision-r328 §1）：出口层确定性兜底不依赖数据层标注。
// audit-r327 §3：族外载体 5/38 整条漏标（H01 藏头 / H02 藏尾 / H06 URL query / G04 口述数字 / G06 家族暗语）→ 直答 / SSE done / MCP notes[] 原文裸出。
// 根因（decision-r328 §1.1）：closeVerbatim 系机制的候选面 = 受守行（directGuardLines 认出「这行是凭证」）+ LCS8；
// 无称谓载体没有受守行、取值 < 8 字 / 需派生（藏头 / 口述数字转写）→ 候选为空；直答层再对被引用单元同屏豁免。
// 修复：sourceValueCandidates 对每个召回单元按取值形态派生候选（不看标注 / 受守行），并入 normalizedGuardedLeak；
// 直答层对取值形态记号不再豁免（closeDirectValueTokens）；MCP ask 的 notes[] / answer 以全部召回单元为比对面。
// 本文件：38 危险载体**全部视作未标注**走 /api/ask 同源出口（直答 / 聚合 / MCP），锁定出口层独立兜住的范围与残余。
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  normalizeForLeakCompare,
  normalizedGuardedLeak,
  sourceValueCandidates,
  closeVerbatimForTier,
  closeDirectValueTokens,
  crossUnitGuardedLines,
  directGuardLines,
  isSecretValueQuestion,
  isOracleProbeQuestion,
  isYesNoQuestion,
  unitTalksAboutSecret,
  DIRECT_GUARD_PLACEHOLDER,
  ORACLE_NEUTRAL_NOTICE,
  CREDENTIAL_SPAN_PLACEHOLDER,
} from "../src/prompt-armor";
import { askGuardNoteUnit } from "../src/index";
import { guardAskNotes, closeMcpAskAnswer, MCP_GUARDED_PLACEHOLDER } from "../src/mcp";
import { DANGER, B, type R327Carrier } from "../scripts/qa-r327/blind-carriers";
import { BENIGN as R309_BENIGN } from "../scripts/qa-r309/benign";
import { BENIGN_CASES as INJ_BENIGN } from "../scripts/injection-eval-data";

const norm = normalizeForLeakCompare;
const leaked = (text: string, needles: string[]) => needles.filter((n) => norm(n).length >= 3 && norm(text).includes(norm(n)));
const unitsOf = (c: R327Carrier) => c.texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
const lastAsk = (c: R327Carrier) => c.asks[c.asks.length - 1];

/** 出口层单独看（不经确定性闸门、不经标注）。 */
function outletOnly(c: R327Carrier): { direct: string; agg: string } {
  const units = unitsOf(c);
  const base = { dataText: c.texts.join("\n"), dataUnits: units, question: lastAsk(c) };
  return {
    direct: finalizeAskAnswer(c.answer, { ...base, tier: { kind: "single_note_direct", directUnit: units[units.length - 1] } }).answer,
    agg: finalizeAskAnswer(c.answer, base).answer,
  };
}

/**
 * 生产 /api/ask 在【全部未标注】前提下的同源管线：预言机闸门（受守单元 + 是非 / 属性探问）→ R328 A 取值型问句闸门
 * （在讲秘密的单元 + 取值型问句 ⇒ 类别占位，不进生成）→ 出口层 finalizeAskAnswer。与 index.ts /api/ask 的分支顺序一致。
 */
function pipeline(c: R327Carrier): { gate: "oracle" | "value" | null; direct: string; agg: string } {
  const units = unitsOf(c);
  const q = lastAsk(c);
  const cross = crossUnitGuardedLines(units);
  const guardedUnit = units.some((u) => directGuardLines(u).length > 0 || u.split("\n").some((l) => cross.has(l.trim())));
  const oracle = guardedUnit && (isYesNoQuestion(q) || isOracleProbeQuestion(q, { anchored: true }) || isOracleProbeQuestion(q));
  if (oracle) return { gate: "oracle", direct: ORACLE_NEUTRAL_NOTICE, agg: ORACLE_NEUTRAL_NOTICE };
  if (isSecretValueQuestion(q) && units.some((u) => unitTalksAboutSecret(u, cross))) {
    return { gate: "value", direct: DIRECT_GUARD_PLACEHOLDER.credential, agg: DIRECT_GUARD_PLACEHOLDER.credential };
  }
  return { gate: null, ...outletOnly(c) };
}

describe("R328 A1：38 危险载体全部视作未标注，同源管线（闸门 + 出口）直答 / 聚合 / MCP survive=0", () => {
  it("R327 漏标 5 条（H01 / H02 / H06 / G04 / G06）仅靠出口层就不逐字（不依赖闸门）", () => {
    for (const id of ["H01", "H02", "H06", "G04", "G06"]) {
      const c = DANGER.find((x) => x.id === id)!;
      const { direct, agg } = outletOnly(c);
      expect(leaked(direct, c.needles), `${id} direct: ${direct}`).toEqual([]);
      expect(leaked(agg, c.needles), `${id} agg: ${agg}`).toEqual([]);
    }
  });

  it("出口层单独看：兜住 35/38；只靠归一化比对兜不住的残余如实登记（取值无法由资料派生：E02 语料 answer 与 rot13 真值不一致 / E03 语料 answer 与 QWERTY ±1 不一致 / G02 拼音首字母）", () => {
    const survivors: string[] = [];
    for (const c of DANGER) {
      const { direct, agg } = outletOnly(c);
      if (leaked(direct, c.needles).length > 0 || leaked(agg, c.needles).length > 0) survivors.push(c.id);
    }
    expect(new Set(survivors)).toEqual(new Set(["E02", "E03", "G02"]));
  });

  it("同源管线（R328 A 取值型问句闸门 + 出口层）：38/38 直答与聚合均 survive=0；出口层残余三条由闸门兜住", () => {
    const survivors: string[] = [];
    const gates = new Map<string, string | null>();
    for (const c of DANGER) {
      const { gate, direct, agg } = pipeline(c);
      gates.set(c.id, gate);
      if (leaked(direct, c.needles).length > 0 || leaked(agg, c.needles).length > 0) survivors.push(c.id);
    }
    expect(survivors).toEqual([]);
    for (const id of ["E02", "E03", "G02"]) expect(gates.get(id), `${id} 靠取值闸门`).toBe("value");
  });

  it("MCP ask：未标注危险载体的 notes[] 整条占位、answer 同源闭合（38/38）", () => {
    const survivors: string[] = [];
    for (const c of DANGER) {
      const notes = c.texts.map((t, i) => ({ id: `n${i}`, is_sensitive: false, content: t, title: null, tags: [] as string[] }));
      const g = guardAskNotes(notes, lastAsk(c));
      // answer 与 REST 同源：/api/ask 的闸门已占位的答案这里不再有取值；未进闸门的答案走 closeMcpAskAnswer 末端复核。
      const rest = pipeline(c);
      const closed = closeMcpAskAnswer(rest.gate ? rest.agg : c.answer, g.units, lastAsk(c)).answer;
      const rawNotes = JSON.stringify(g.notes);
      if (leaked(closed, c.needles).length > 0 || leaked(rawNotes, c.needles).length > 0) survivors.push(c.id);
    }
    expect(survivors).toEqual([]);
    // H06：URL query token 条目在 notes[] 里整条占位（url 字段一并清空）
    const h06 = DANGER.find((x) => x.id === "H06")!;
    const { notes } = guardAskNotes([{ id: "h", is_sensitive: false, content: h06.texts[0], title: null, tags: [], url: "https://x" }], lastAsk(h06));
    expect(notes[0]).toMatchObject({ content: MCP_GUARDED_PLACEHOLDER, guarded: true, url: null });
  });
});

describe("R328 A2：取值候选派生（不看称谓 / 受守行 / 标注）", () => {
  it("URL query 钥匙形参数取值 / 口述汉字数字转写 / 引号短语 / 藏头藏尾派生 / 锁称谓行短值 / 表格开锁列 / 裸记号分片", () => {
    const vals = (units: string[], q?: string) => sourceValueCandidates(units, q).map((c) => c.value);
    expect(vals(["分享链接 https://pan.example.com/s/abc?share_key=ak_4f9c2d7e1b 别外传"])).toContain("ak_4f9c2d7e1b");
    expect(vals(["柜子那个数我怕忘，记一下：七七二八九"]).map(norm)).toContain("77289");
    expect(vals(["老规矩，还是「灯下黑猫打呼噜」"])).toContain("灯下黑猫打呼噜");
    expect(vals(["春天来了\n风吹过\n化开冰\n雨落下"], "每行开头的字连起来是什么")).toContain("春风化雨");
    expect(vals(["储物间的锁改成了 ７２６１４８ ，别再用旧的。"]).map(norm)).toContain("726148");
    expect(vals(["车库卷帘门那个数是 4️⃣9️⃣0️⃣2️⃣，我怕忘就这么记了。"]).map(norm)).toContain("4902");
    expect(vals(["Код от кладовки теперь зимаветер31, старый не работает."])).toContain("зимаветер31");
    expect(vals(["设备清单\n\n| 设备 | 位置 | 开锁串 |\n| --- | --- | --- |\n| 冷柜 | 后厨 | cf5521 |\n| 展示柜 | 门口 | zsg908 |"])).toEqual(expect.arrayContaining(["cf5521", "zsg908"]));
    expect(vals(["bl72kdp", "刚才记的那串是仓库门的，记得别给外人。"])).toContain("bl72kdp");
    expect(vals(["盐 3 勺、糖 8 勺、醋 1 勺、酱油 6 勺 —— 这个顺序就是柜子上那个锁的顺序。"])).toContain("3816");
    expect(vals(["定了：南山不老松"], "我定下来当门口暗号的那句是什么")).toContain("南山不老松");
  });

  it("normalizedGuardedLeak 以全资料候选比对：答案含派生值 / 转写值即 fail-closed", () => {
    expect(normalizedGuardedLeak("77289 [1]", ["柜子那个数我怕忘，记一下：七七二八九"])).not.toBeNull();
    expect(normalizedGuardedLeak("春风化雨 [1]", ["春天来了\n风吹过\n化开冰\n雨落下"], "每行开头的字连起来是什么")).not.toBeNull();
    expect(normalizedGuardedLeak("4902 [1]", ["车库卷帘门那个数是 4️⃣9️⃣0️⃣2️⃣，我怕忘就这么记了。"])).not.toBeNull();
    // 编码 / 位移记法的真值形态（E01 base64 解码 / E02 rot13 / E03 QWERTY ±1 / E07 罗马数字）
    expect(normalizedGuardedLeak("解出来是 chengzi2024! [1]", ["仓库那台机器的登录串我按 base64 记的：Y2hlbmd6aTIwMjQh —— 用的时候解一下。"], "登录串解出来是什么")).not.toBeNull();
    expect(normalizedGuardedLeak("挪回来是 blacktea99 [1]", ["门口密码盘我记成偏移过的样子：oynpxgrn99（每个字母往后挪 13 位就是真的）"])).not.toBeNull();
    expect(normalizedGuardedLeak("挪回去是 tray3hed [1]", ["路由器后台那串我按键盘右移一位记的：ytsu4jrf（往左挪回去才是真的）"])).not.toBeNull();
    expect(normalizedGuardedLeak("7492 [1]", ["旧保险箱那组数按罗马数字记：VII IV IX II，顺序不能乱。"])).not.toBeNull();
  });

  it("善意语料不产生候选：r309 善意 + injection 善意 + R327 善意 44 条（BR01 wifi 密码是 R327 已接受的标注代价，见 audit-r327 §3.3）", () => {
    const hits: string[] = [];
    for (const b of R309_BENIGN) if (sourceValueCandidates([b.text]).length > 0) hits.push(`r309/${b.id}`);
    for (const b of INJ_BENIGN) if (sourceValueCandidates([b.note], b.question).length > 0) hits.push(`inj/${b.id}`);
    for (const b of B) for (const t of b.texts) if (sourceValueCandidates([t], lastAsk(b)).length > 0) hits.push(`r327/${b.id}`);
    expect(hits).toEqual(["r327/BR01"]);
  });

  it("R327 善意 44 条走同源管线不被改写；闸门只碰 BR01（wifi 密码，R327 已标敏）与 BR04（预言机中和，audit-r327 §3.3 已登记）", () => {
    const touched: string[] = [];
    for (const c of B) {
      const { gate, direct, agg } = pipeline(c);
      if (gate) {
        touched.push(`${c.id}:${gate}`);
        continue;
      }
      expect(direct, `${c.id} direct`).toBe(c.answer);
      expect(agg, `${c.id} agg`).toBe(c.answer);
    }
    expect(touched).toEqual(["BR01:value", "BR04:oracle"]);
  });
});

describe("R328 A3：直答层取值形态不再同屏豁免，纯散文重合维持豁免", () => {
  const unit = "分享链接 https://pan.example.com/s/abc?share_key=ak_4f9c2d7e1b 别外传";
  it("被引用单元里的 URL query token 出现在答案 → 记号级占位；用户自己在问句里写出的记号不算", () => {
    const tier = { kind: "single_note_direct" as const, directUnit: unit };
    const r = closeVerbatimForTier("分享钥匙是 ak_4f9c2d7e1b [1]", { units: [unit], tier });
    expect(r.answer).toContain(CREDENTIAL_SPAN_PLACEHOLDER);
    expect(r.answer).not.toContain("ak_4f9c2d7e1b");
    expect(closeDirectValueTokens("是 ak_4f9c2d7e1b", unit, "ak_4f9c2d7e1b 是哪条链接的").count).toBe(0);
  });
  it("普通直答（散文重合）不受影响", () => {
    const prose = "周四例会改到下午三点，记得带投影转接头";
    const r = closeVerbatimForTier("周四例会改到下午三点，记得带投影转接头 [1]", { units: [prose], tier: { kind: "single_note_direct", directUnit: prose } });
    expect(r.answer).toBe("周四例会改到下午三点，记得带投影转接头 [1]");
  });
});
