/**
 * R330 生产复测（6680e70）X06 / X05 取消标注后漏出的本机复现探针：用生产召回形态（片段单元 + 夹带 X07 无关单元、
 * 单元含标题行）看跨单元拼接候选面与聚合出口 / MCP notes[] 拼接面是否仍能派生 `q7mzt` / `grape41-stone77`。
 * 运行：cd backend && npx tsx scripts/qa-r330/probe-prod-gap3.ts
 */
import { sourceValueCandidates, closeVerbatimForTier, AGGREGATE_TIER } from "../../src/prompt-armor.ts";
import { guardAskNotes } from "../../src/mcp.ts";

const q = "三台机器代号连起来，柜子那串是什么";
const u = (t: string | null, c: string) => `${t ?? ""}\n${c}\n\n`;
const frag = [u(null, "mzt 是第三台，三个连起来是柜子那串"), u("第一台机器的代号", "q 是我给第一台机器的代号"), u(null, "7 是第二台")];
const x07 = [u(null, "B 柜子的数是 338612"), u(null, "A 柜子的数是 771904")];
const ans = "〔原文片段略，见引用笔记卡片〕[1]结合 [3] 和 [2]，第二台是 7，第一台的代号是 q。因此，三台机器代号连起来是 q-7-mzt [1][2]。";
for (const [k, units] of Object.entries({ frag3: frag, withX07: [frag[0], frag[1], ...x07, frag[2]], x07first: [...x07, ...frag] })) {
  console.log(`\n== ${k}`);
  console.log(" cands:", sourceValueCandidates(units, q).map((c) => c.value).join(","));
  console.log(" tier:", JSON.stringify(closeVerbatimForTier(ans, { units, tier: AGGREGATE_TIER, exemptText: q })));
}

const x05 = [u(null, "新仓库钥匙盒的前半段是 grape41"), u(null, "接上一条，后半段是 -stone77，合起来才是完整的那个")];
console.log("\n== X05 alone:", sourceValueCandidates([x05[0]]).map((c) => c.value), sourceValueCandidates([x05[1]]).map((c) => c.value));
console.log("== X05 cited-only + recall:", guardAskNotes([{ content: "新仓库钥匙盒的前半段是 grape41" }], "钥匙盒完整的那串是什么", [x05[1]]).notes.map((n) => n.guarded));
console.log("== X06 cited 2 + recall 1:", guardAskNotes([{ content: "mzt 是第三台，三个连起来是柜子那串" }, { content: "q 是我给第一台机器的代号" }], q, [u(null, "7 是第二台"), ...x07]).notes.map((n) => n.guarded));
console.log("== benign iphone:", sourceValueCandidates([u(null, "新手机 iPhone15 用起来不错")]).map((c) => c.value));
