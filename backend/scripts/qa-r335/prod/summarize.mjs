// 汇总一个 out 目录（本地 mock / 本地 Workers AI / 生产）的原始结果为 summary.json + summary.md。
// 所有派生判据（事实命中/占位/中性/计数句/oracle 表态）都用当前 lib.mjs 从落盘的原始 answer 重算，
// 便于修判据后不重打生产。用法：QA_OUT=… node prod/summarize.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { OUT, factHit, foldedCount, isNeutral, isNoAnswer, isPlaceholder, verdictOf, dupMarks } from "./lib.mjs";

const load = (n) => (existsSync(`${OUT}/${n}.json`) ? JSON.parse(readFileSync(`${OUT}/${n}.json`, "utf8")) : null);
const triage = load("seed-triage") ?? {};
const marked = (acct, fid) => Object.entries(triage).filter(([k]) => k.startsWith(`${acct}/${fid}#`)).map(([, v]) => v.sensitive === true);
const md = [];
const S = { out: OUT, generated_at: new Date().toISOString() };

// ---- attack ----
for (const phase of ["auto", "cancelled"]) {
  const d = load(`attack-${phase}`);
  if (!d) continue;
  const cells = Object.entries(d);
  const leak = cells.filter(([, v]) => v.leak);
  const byTransport = {};
  for (const [k, v] of cells) {
    const t = k.split("/")[1];
    const b = (byTransport[t] ??= { n: 0, leak: 0, placeholder: 0, neutral: 0, no_answer: 0, other: 0 });
    b.n++;
    if (v.leak) b.leak++;
    const last = v.turns?.[v.turns.length - 1];
    const a = last?.answer ?? "";
    if (isPlaceholder(a)) b.placeholder++;
    else if (isNeutral(a)) b.neutral++;
    else if (isNoAnswer(a) || last?.no_answer_flag) b.no_answer++;
    else b.other++;
  }
  const byFamily = {};
  for (const [k, v] of cells) {
    const f = k[0];
    const b = (byFamily[f] ??= { fixtures: new Set(), leak: 0 });
    b.fixtures.add(k.split("/")[0]);
    if (v.leak) b.leak++;
  }
  S[`attack_${phase}`] = {
    cells: cells.length,
    fixtures: new Set(cells.map(([k]) => k.split("/")[0])).size,
    leak_cells: leak.length,
    leak_keys: leak.map(([k]) => k),
    piece_joined_leaks: cells.filter(([, v]) => v.joined_leak).map(([k]) => k),
    other_secret_hits: cells.filter(([, v]) => (v.other_secret_hits ?? []).length).map(([k]) => k),
    by_transport: byTransport,
    by_family: Object.fromEntries(Object.entries(byFamily).map(([f, b]) => [f, { fixtures: b.fixtures.size, leak: b.leak }])),
    marked_at_seed: Object.fromEntries([...new Set(cells.map(([k]) => k.split("/")[0]))].map((fid) => [fid, marked("atk", fid)]))
  };
  md.push(`## attack-${phase}\n- cells=${cells.length} fixtures=${S[`attack_${phase}`].fixtures} **leak=${leak.length}** ${leak.map(([k]) => k).join(",")}\n- joined(<80% 拼接)=${S[`attack_${phase}`].piece_joined_leaks.length} other_secret=${S[`attack_${phase}`].other_secret_hits.length}\n- by transport: ${Object.entries(byTransport).map(([t, b]) => `${t}: n=${b.n} leak=${b.leak} ph=${b.placeholder} nt=${b.neutral} na=${b.no_answer} other=${b.other}`).join(" | ")}`);
}

// ---- benign ----
{
  const d = load("benign");
  if (d) {
    const rows = {};
    const cat = { OK: 0, MARKED_GATE: 0, RESIDENCY_WITHHELD: 0, NEUTRAL: 0, NO_ANSWER: 0, OTHER: 0 };
    const byFamily = {};
    for (const [k, v] of Object.entries(d)) {
      const [fid, tier] = k.split("/");
      const a = v.answer ?? "";
      const hit = factHit(a, v.facts_expected);
      const anyMarked = marked("ben", fid).some(Boolean);
      let c;
      if (hit) c = "OK";
      else if (anyMarked) c = "MARKED_GATE";
      else if (isPlaceholder(a) || v.notes_withheld > 0 || /问答区不展示|不逐字转写|原文片段略/.test(a)) c = "RESIDENCY_WITHHELD";
      else if (isNeutral(a)) c = "NEUTRAL";
      else if (isNoAnswer(a) && v.refs === 0) c = "NO_ANSWER";
      else c = "OTHER";
      cat[c]++;
      const f = fid[0];
      const b = (byFamily[f] ??= { n: 0, OK: 0, MARKED_GATE: 0, RESIDENCY_WITHHELD: 0, NEUTRAL: 0, NO_ANSWER: 0, OTHER: 0 });
      b.n++; b[c]++;
      rows[k] = { tier, cat: c, marked_at_seed: marked("ben", fid), fact_hit: hit, facts_expected: v.facts_expected, refs: v.refs, notes_withheld: v.notes_withheld, folded_count: foldedCount(a), dup_marks: dupMarks(a), answer: a.slice(0, 220) };
    }
    S.benign = { cells: Object.keys(d).length, fixtures: new Set(Object.keys(d).map((k) => k.split("/")[0])).size, categories: cat, by_family: byFamily, miss: Object.fromEntries(Object.entries(rows).filter(([, r]) => r.cat !== "OK")) };
    md.push(`## benign\n- cells=${S.benign.cells} fixtures=${S.benign.fixtures}\n- ${Object.entries(cat).map(([k, n]) => `${k}=${n}`).join(" ")}\n- by family: ${Object.entries(byFamily).map(([f, b]) => `${f}: n=${b.n} OK=${b.OK} marked=${b.MARKED_GATE} residency=${b.RESIDENCY_WITHHELD} neutral=${b.NEUTRAL} na=${b.NO_ANSWER} other=${b.OTHER}`).join(" | ")}`);
    md.push(Object.entries(S.benign.miss).map(([k, r]) => `  - ${k} [${r.cat}] marked=${JSON.stringify(r.marked_at_seed)} expect=${JSON.stringify(r.facts_expected)} refs=${r.refs} wh=${r.notes_withheld} | ${r.answer.slice(0, 120).replace(/\n/g, " ")}`).join("\n"));
  }
}

// ---- fold ----
{
  const d = load("fold");
  if (d) {
    const rows = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { count: foldedCount(v.answer), expected: v.expected_count, fact_hit: v.facts_hit?.length ? true : factHit(v.answer, v.fact_expected ?? []), dup_marks: dupMarks(v.answer), generic_no_answer: isNoAnswer(v.answer) && foldedCount(v.answer) === null, secret_hits: v.secret_hits, answer: (v.answer ?? "").slice(0, 200) }]));
    S.fold = rows;
    md.push(`## fold\n${Object.entries(rows).map(([k, r]) => `- ${k}: count=${r.count}/${r.expected} generic_no_answer=${r.generic_no_answer} dup=${JSON.stringify(r.dup_marks)} secret=${JSON.stringify(r.secret_hits)} | ${r.answer.slice(0, 140).replace(/\n/g, " ")}`).join("\n")}`);
  }
}

// ---- oracle ----
for (const phase of ["auto", "cancelled"]) {
  const d = load(`oracle-${phase}`);
  if (!d) continue;
  const rows = Object.entries(d).map(([k, r]) => { const atk = verdictOf(r.atk.answer), ctl = verdictOf(r.ctl.answer); return [k, { existence: r.existence, atk, ctl, bit: !r.existence && ["yes", "no"].includes(atk) && atk !== ctl, atk_secret_hits: r.atk.secret_hits }]; });
  S[`oracle_${phase}`] = { cells: rows.length, differential_bits: rows.filter(([, r]) => r.bit).map(([k]) => k), atk_verdicts: rows.reduce((m, [, r]) => ((m[r.atk] = (m[r.atk] ?? 0) + 1), m), {}), atk_secret_hits: rows.filter(([, r]) => r.atk_secret_hits?.length).map(([k]) => k) };
  md.push(`## oracle-${phase}\n- cells=${rows.length} **differential_bits=${S[`oracle_${phase}`].differential_bits.length}** ${S[`oracle_${phase}`].differential_bits.join(",")} atk verdicts=${JSON.stringify(S[`oracle_${phase}`].atk_verdicts)} secret_hits=${S[`oracle_${phase}`].atk_secret_hits.length}`);
}

// ---- outlets / mcp / unmark ----
for (const phase of ["auto", "cancelled"]) {
  const o = load(`outlets-${phase}`);
  if (!o) continue;
  const lines = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === "phase" || k === "checked_at" || k === "mcp_handshake") continue;
    if (k === "f_states") { lines.push(`f_states: ${Object.entries(v).map(([f, s]) => `${f}: sensitive=${s.is_sensitive} withheld=${s.content_withheld}`).join("; ")}`); continue; }
    if (k === "threads") { lines.push(`threads: rebuild=${v.rebuild} n=${v.n} list_derived_hits=${v.list_derived_hits?.length ?? v.list_derived_hits} detail_derived_hits=${v.detail_derived_hits?.length ?? v.detail_derived_hits} own_notes_total=${v.detail_own_notes_total}`); continue; }
    const hits = v.hits ? (typeof v.hits === "object" ? `hits=${JSON.stringify(v.hits)}` : `hits=${v.hits}`) : "";
    lines.push(`${k}: status=${v.status ?? "-"} ${hits} ${v.all_hits !== undefined ? `all=${v.all_hits}` : ""} ${v.withheld_n !== undefined ? `withheld=${v.withheld_n}` : ""} ${v.n !== undefined ? `n=${v.n}` : ""} ${v.note ?? ""}`.trim());
  }
  S[`outlets_${phase}`] = o;
  md.push(`## outlets-${phase}\n${lines.map((l) => `- ${l}`).join("\n")}`);
  const m = load(`mcp-runtime-${phase}`);
  if (m) { S[`mcp_runtime_${phase}`] = { handshake: m.handshake, unauth_status: m.unauth_status, no_session_tools_list_status: m.no_session_tools_list_status, invalid_args: m.invalid_args, unknown_tool: m.unknown_tool, notes_audit: m.notes_audit }; md.push(`## mcp-runtime-${phase}\n- handshake tools=${m.handshake?.tools?.length} protocol=${m.handshake?.protocolVersion} unauth=${m.unauth_status} no_session_tools_list=${m.no_session_tools_list_status}\n- invalid_args=${JSON.stringify(m.invalid_args)?.slice(0, 160)} unknown_tool=${JSON.stringify(m.unknown_tool)?.slice(0, 160)}\n- notes_audit=${JSON.stringify(m.notes_audit)?.slice(0, 400)}`); }
}
{
  const u = load("unmark");
  if (u) {
    const rows = Object.values(u);
    S.unmark = { n: rows.length, patched_ok: rows.filter((r) => r.patch === 200).length, now_unmarked: rows.filter((r) => r.now === false).length, remarked_by_retriage: rows.filter((r) => r.remarked).length, content_visible: rows.filter((r) => r.content_visible_hits > 0).length };
    md.push(`## unmark\n- ${JSON.stringify(S.unmark)}`);
  }
}
{
  const t = load("seed-triage");
  if (t) {
    const e = Object.entries(t);
    const atk = e.filter(([k]) => k.startsWith("atk/") && !/F\./.test(k)), ben = e.filter(([k]) => k.startsWith("ben/"));
    S.triage = { atk_n: atk.length, atk_marked: atk.filter(([, v]) => v.sensitive).length, atk_unmarked: atk.filter(([, v]) => !v.sensitive).map(([k]) => k), ben_n: ben.length, ben_marked: ben.filter(([, v]) => v.sensitive).map(([k]) => k), derived_hits: e.filter(([, v]) => v.derived_hits?.length).map(([k]) => k) };
    md.unshift(`## seed triage\n- atk marked ${S.triage.atk_marked}/${S.triage.atk_n}; unmarked: ${S.triage.atk_unmarked.join(",") || "none"}\n- benign mis-marked ${S.triage.ben_marked.length}/${S.triage.ben_n}: ${S.triage.ben_marked.join(",")}\n- derived title/tag hits: ${S.triage.derived_hits.join(",") || "none"}`);
  }
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(S, null, 1));
writeFileSync(`${OUT}/summary.md`, `# summary (${OUT})\n\n${md.join("\n\n")}\n`);
console.log(md.join("\n\n"));
