/**
 * R309 独立静态探针（审查方）：
 *  - 危险载体 215（R307 回归 145 + R309 新造 70）逐条走生产同一函数 noteContainsExecutableCommand；
 *    分片族（id 形如 C01a/C01b…）按生产 fragmentExecNoteIds 的判定单元（同账号邻近笔记有序拼接）判，
 *    并额外做 3 种真实布局：邻近、**非邻近（中间插 20 条无关善意笔记）**、**乱序**。
 *  - 善意 307（R307 回归 243 + R309 新造 64）逐条误标率 + 降级窗口逐行误隔离率 + 拼接连坐。
 *  - 不断言（本探针是测量工具），全部数字写 out/r309-static.json / .txt 供报告引用。
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS, NEW309 as NEW_CARRIERS, REG309 as REG_CARRIERS } from "../carriers";
import { BENIGN, NEW309 as NEW_BENIGN } from "../benign";
import {
  normalizeAddressSurface,
  remoteEndpointForms,
  execSemanticGateReason,
  execSemanticDangerReason,
  execClassifierGateReason,
  execCodeSurfaceTraceReason,
  execDegradedTraceReason,
  degradedLocalCodeLineExempt,
  noteContainsExecutableCommand,
  fragmentExecNoteIds,
} from "../../../src/prompt-armor";

const FRAG_ID_RE = /^([A-Z]+\d+)[a-z]$/;

function fragGroups(): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const c of CARRIERS) {
    const m = FRAG_ID_RE.exec(c.id);
    if (!m) continue;
    g.set(m[1], [...(g.get(m[1]) ?? []), c.id]);
  }
  // 单片族（B04a/B04b 之类只有 2 条也算）保留；只剩 1 条的不算分片
  for (const [k, v] of g) if (v.length < 2) g.delete(k);
  return g;
}

const textOf = (id: string): string => CARRIERS.find((c) => c.id === id)!.text;
// 非邻近布局用的填充笔记：真实无关内容（取善意语料前 20 条）
const FILLER = BENIGN.slice(0, 20).map((b, i) => ({ id: `FILL${i}`, content: b.text }));

type Layout = "adjacent" | "far" | "shuffled";
function fragFlagsByLayout(layout: Layout): Set<string> {
  const flagged = new Set<string>();
  for (const [, ids] of fragGroups()) {
    let notes: Array<{ id: string; content: string }>;
    if (layout === "adjacent") notes = ids.map((id) => ({ id, content: textOf(id) }));
    else if (layout === "far") {
      notes = [];
      ids.forEach((id, i) => {
        notes.push({ id, content: textOf(id) });
        if (i < ids.length - 1) notes.push(...FILLER.map((f) => ({ ...f, id: `${f.id}-${i}` })));
      });
    } else {
      // 乱序：固定的确定性打乱（反转 + 中点旋转），不引入随机
      const rot = [...ids].reverse();
      notes = [...rot.slice(Math.floor(rot.length / 2)), ...rot.slice(0, Math.floor(rot.length / 2))].map((id) => ({
        id,
        content: textOf(id),
      }));
    }
    for (const id of fragmentExecNoteIds(notes)) flagged.add(id);
  }
  return flagged;
}

it("r309 static", () => {
  mkdirSync("out", { recursive: true });
  const layouts: Record<Layout, Set<string>> = {
    adjacent: fragFlagsByLayout("adjacent"),
    far: fragFlagsByLayout("far"),
    shuffled: fragFlagsByLayout("shuffled"),
  };
  const lines: string[] = [];
  const rows = CARRIERS.map((c) => {
    const isFrag = FRAG_ID_RE.test(c.id);
    const single = noteContainsExecutableCommand(c.text);
    const fragAdj = layouts.adjacent.has(c.id);
    const flag = single || fragAdj;
    return {
      id: c.id,
      cat: c.cat,
      family: c.family,
      isFrag,
      single,
      fragAdjacent: fragAdj,
      fragFar: layouts.far.has(c.id),
      fragShuffled: layouts.shuffled.has(c.id),
      flag,
      remote: remoteEndpointForms(c.text, { ignoreAllowlist: true }),
      norm: normalizeAddressSurface(c.text),
      semGate: execSemanticGateReason(c.text),
      semDanger: execSemanticDangerReason(c.text),
      clsGate: execClassifierGateReason(c.text) ?? execCodeSurfaceTraceReason(c.text) ?? null,
      degTrace: execDegradedTraceReason(c.text),
    };
  });
  // 分片族的族级判定（族内至少一条被标 ⇒ 该族在出口上会被折叠）
  const fragFamilyRows = [...fragGroups()].map(([g, ids]) => ({
    group: g,
    family: CARRIERS.find((c) => c.id === ids[0])!.family,
    ids,
    adjacent: ids.filter((i) => layouts.adjacent.has(i)).length,
    far: ids.filter((i) => layouts.far.has(i)).length,
    shuffled: ids.filter((i) => layouts.shuffled.has(i)).length,
  }));

  const miss = (cat: "reg" | "new") => rows.filter((r) => r.cat === cat && !r.flag);
  for (const cat of ["reg", "new"] as const) {
    const rs = rows.filter((r) => r.cat === cat);
    const m = miss(cat);
    lines.push(
      `[${cat}] 危险载体 ${rs.length}：漏判 ${m.length} (${((m.length / rs.length) * 100).toFixed(2)}%) → ${m
        .map((r) => `${r.id}(${r.family})`)
        .join(", ")}`
    );
  }
  lines.push("");
  for (const r of rows.filter((x) => !x.flag)) {
    lines.push(
      `MISS ${r.id} ${r.family}\n  text: ${textOf(r.id)}\n  norm: ${r.norm}\n  remote: ${JSON.stringify(r.remote)}\n  semGate=${r.semGate} semDanger=${r.semDanger} clsGate=${r.clsGate} degTrace=${r.degTrace}`
    );
  }
  lines.push("\n--- 分片布局 ---");
  for (const f of fragFamilyRows)
    lines.push(`${f.group} ${f.family} n=${f.ids.length} adjacent=${f.adjacent} far(+20 无关)=${f.far} shuffled=${f.shuffled}`);

  // 善意
  const brows = BENIGN.map((b) => {
    const flag = noteContainsExecutableCommand(b.text);
    const trace = execCodeSurfaceTraceReason(b.text);
    return {
      id: b.id,
      cat: b.cat ?? "reg",
      family: b.family,
      flag,
      degIso: trace !== null && !degradedLocalCodeLineExempt(b.text),
      trace,
      remote: remoteEndpointForms(b.text),
    };
  });
  lines.push("\n--- 善意 ---");
  for (const cat of ["reg", "new"] as const) {
    const rs = brows.filter((r) => r.cat === cat);
    const f = rs.filter((r) => r.flag);
    const d = rs.filter((r) => r.degIso);
    lines.push(
      `[${cat}] 善意 ${rs.length}：数据面误标 ${f.length} (${((f.length / rs.length) * 100).toFixed(2)}%) [${f
        .map((r) => `${r.id}(${r.family})`)
        .join(", ")}]；降级逐行误隔离 ${d.length} (${((d.length / rs.length) * 100).toFixed(2)}%) [${d
        .map((r) => r.id)
        .join(", ")}]`
    );
  }
  // 善意拼接连坐（正序 + 逆序 + 新造善意单独一遍）
  const asNotes = (arr: typeof BENIGN) => arr.map((b) => ({ id: b.id, content: b.text }));
  const stitched = [
    ...fragmentExecNoteIds(asNotes(BENIGN)),
    ...fragmentExecNoteIds([...asNotes(BENIGN)].reverse()),
    ...fragmentExecNoteIds(asNotes(NEW_BENIGN)),
  ];
  lines.push(`善意拼接被连坐: ${stitched.length} [${[...new Set(stitched)].join(", ")}]`);

  writeFileSync("out/r309-static.txt", lines.join("\n"));
  writeFileSync(
    "out/r309-static.json",
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        carriers: { total: CARRIERS.length, reg: REG_CARRIERS.length, new: NEW_CARRIERS.length },
        missReg: miss("reg").map((r) => ({ id: r.id, family: r.family })),
        missNew: miss("new").map((r) => ({ id: r.id, family: r.family })),
        fragFamilyRows,
        rows,
        benign: brows,
        benignStitched: [...new Set(stitched)],
      },
      null,
      1
    )
  );
  console.log(lines.join("\n"));
});
