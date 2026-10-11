// R337 运行时复测运行器（../runtime.ts → 本机 / 生产 API）。R333–R336 已归零项的回归仍由 qa-r335 / qa-r336 的 run.mjs
// 以 QA_PREFIX=[QA-R337] 复跑，本文件只跑 R337 新增面：
//   health    /health?probe=ai（degraded 状态；主模型未恢复时结果只能算兜底口径）
//   seed      注册 1 个 [QA-R337] 账号：每条 E 用例一条普通笔记 + 一条凭据笔记；等异步分拣
//   unmark    取消凭据笔记的自动敏感标注（取消态 = R335 漏值态，闸门只能靠称谓驻留判定）
//   compound  E01–E09 × direct / agg / sse / mcp：compound_split 元数据、普通事实命中、凭据零命中（answer / notes[] / SSE
//             delta / MCP 原文）、计数句 = 占位卡数、角标无紧邻重复、references note_id 唯一
//   controls  C-Q（全凭据并列：不拆、零命中）/ C-R（全普通并列：不拆、两事实都命中）
//   marked    凭据笔记重新标注敏感后复跑 E × direct：普通事实仍命中、凭据卡为折叠卡、零命中
//   cleanup   注销账号（token 抹掉）
// 用法：cd backend && QA_INVITE_CODE=… npx tsx scripts/qa-r337/prod/run.mjs health seed unmark compound controls marked cleanup
//      本机：QA_API=http://127.0.0.1:8787 QA_INVITE_CODE=local npx tsx scripts/qa-r337/prod/run.mjs …
//      候选版钉 build：QA_EXPECT_BUILD=<sha>
import { COMPOUND_RUNTIME, CONTROLS } from "../runtime.ts";
import { req, register, postNote, getNote, setSensitive, ask, askStream, McpSession, secretHits, factHit, isPlaceholder, isNeutral, isNoAnswer, dupMarks, foldedCount, cardWithheld, sleep, J, load, deleteAccount, health } from "./lib.mjs";

const steps = process.argv.slice(2);
let acct = load("account");
const save = () => J("account", acct);
const ALL_SECRETS = [...COMPOUND_RUNTIME.flatMap((c) => c.secrets), ...CONTROLS.flatMap((c) => c.secrets ?? [])];
const hitsIn = (txt) => [...new Set(ALL_SECRETS.filter((s) => secretHits(txt, s).length > 0))];
const notesTxt = (json) => (json?.notes ?? []).map((n) => `${n.title ?? ""}\n${n.content ?? ""}\n${n.url_title ?? ""}\n${n.url_summary ?? ""}\n${(n.tags ?? []).join(" ")}\n${n.amount ?? ""} ${n.merchant ?? ""}`).join("\n");
const cardsOf = (json) => (json?.notes ?? []).map((n) => ({ id: n.id, withheld: cardWithheld(n), head: String(n.content ?? "").slice(0, 40) }));
const answerOf = (r) => String(r.json?.answer ?? r.text ?? "");
const refIdsUnique = (json) => { const ids = (json?.references ?? []).map((r) => r.note_id); return new Set(ids).size === ids.length; };

const expectBuild = process.env.QA_EXPECT_BUILD ?? null;
const assertBuild = async (where) => {
  if (!expectBuild) return;
  const b = (await req("/health")).json?.build ?? null;
  if (b !== expectBuild) throw new Error(`build drift at ${where}: /health.build=${b} expected=${expectBuild}`);
};
await assertBuild("start");

if (steps.includes("health")) {
  const h = await health();
  const build = (await req("/health")).json?.build ?? null;
  J("health", { checked_at: new Date().toISOString(), build, ...h });
  console.log("health", JSON.stringify({ build, ...h }));
}

// ---------------- seed ----------------
if (steps.includes("seed")) {
  if (!acct) { acct = await register("cmp"); save(); console.log("registered", acct.name, acct.user_id); }
  const post = async (key, text) => {
    if (acct.notes[key]) return;
    const n = await postNote(acct.token, text, {});
    acct.notes[key] = { note_id: n.id, text, sensitive_at_post: n.is_sensitive ?? null };
    save();
    await sleep(1800);
  };
  for (const c of COMPOUND_RUNTIME) { await post(`${c.id}/plain`, c.plainNote); await post(`${c.id}/guarded`, c.guardedNote); }
  console.log("waiting 40s for async triage…");
  await sleep(40000);
  const tri = {};
  for (const [key, v] of Object.entries(acct.notes)) {
    const n = await getNote(acct.token, v.note_id);
    v.sensitive_after_triage = n.is_sensitive === true;
    tri[key] = { sensitive: n.is_sensitive === true, title: n.title ?? null, derived_hits: hitsIn([n.title, ...(n.tags ?? []), n.summary].filter(Boolean).join("\n")) };
    await sleep(150);
  }
  save();
  J("seed-triage", tri);
  console.log(`plain auto-marked sensitive (误标): ${Object.entries(tri).filter(([k, v]) => k.endsWith("/plain") && v.sensitive).map(([k]) => k).join(",") || "none"}`);
  console.log(`guarded auto-marked: ${Object.entries(tri).filter(([k, v]) => k.endsWith("/guarded") && v.sensitive).length}/${COMPOUND_RUNTIME.length}`);
  console.log(`derived title/tag leaks: ${Object.entries(tri).filter(([, v]) => v.derived_hits.length).map(([k, v]) => `${k}=${v.derived_hits}`).join(" ") || "none"}`);
}
if (!acct && steps.some((s) => !["seed", "health"].includes(s))) throw new Error("no account; run seed first");

// ---------------- unmark（取消态） ----------------
if (steps.includes("unmark")) {
  const res = {};
  for (const [key, v] of Object.entries(acct.notes)) {
    const before = await getNote(acct.token, v.note_id);
    if (before.is_sensitive) { await setSensitive(acct.token, v.note_id, false); await sleep(500); }
    res[key] = { was: before.is_sensitive === true };
    await sleep(150);
  }
  console.log("unmark: waiting 25s for re-mark check…");
  await sleep(25000);
  for (const [key, v] of Object.entries(acct.notes)) { const n = await getNote(acct.token, v.note_id); res[key].now = n.is_sensitive === true; v.sensitive_now = res[key].now; await sleep(120); }
  save();
  J("unmark", res);
  console.log("still marked after unmark:", Object.entries(res).filter(([, v]) => v.now).map(([k]) => k).join(",") || "none");
}

// ---------------- compound ----------------
const measure = (c, a, json, extra = {}) => {
  const cards = cardsOf(json);
  const withheld = cards.filter((x) => x.withheld).length;
  const cnt = foldedCount(a);
  return {
    q: c.question, ...extra,
    split: json?.compound_split ?? null,
    split_ok: !!json?.compound_split && json.compound_split.guarded === c.expect.guarded && json.compound_split.plain === c.expect.plain,
    fact_hit: factHit(a, c.mustContain),
    answer_hits: hitsIn(a), notes_hits: hitsIn(notesTxt(json)),
    value_withheld: json?.value_withheld ?? null, oracle_neutral: json?.oracle_neutral ?? null, instruction_isolated: json?.instruction_isolated ?? null, no_answer: json?.no_answer ?? null,
    placeholder: isPlaceholder(a), neutral: isNeutral(a), no_answer_text: isNoAnswer(a),
    refs: (json?.references ?? []).length, ref_ids_unique: refIdsUnique(json), cards, notes_withheld: withheld,
    folded_count: cnt, count_ok: withheld === 0 ? cnt === null : cnt === withheld,
    dup_marks: dupMarks(a),
    answer: a.slice(0, 500),
  };
};
const verdict = (row) => row.split_ok && row.fact_hit && row.answer_hits.length === 0 && row.notes_hits.length === 0 && (row.sse_hits ?? []).length === 0 && (row.raw_hits ?? []).length === 0 && row.count_ok && row.ref_ids_unique && !row.dup_marks;

if (steps.includes("compound")) {
  await assertBuild("compound");
  const rows = load("compound") ?? {};
  const mcp = new McpSession(acct.token);
  console.log("mcp handshake", JSON.stringify(await mcp.handshake()));
  for (const c of COMPOUND_RUNTIME) {
    for (const tier of ["direct", "agg", "sse", "mcp"]) {
      const key = `${c.id}/${tier}`;
      if (rows[key]) continue;
      let a, json, extra = {};
      if (tier === "sse") { const s = await askStream(acct.token, c.question); a = String(s.done?.answer ?? s.emitted); json = s.done; extra = { status: s.status, sse: s.sse, deltas: s.deltas, sse_hits: hitsIn(s.emitted) }; }
      else if (tier === "mcp") { const m = await mcp.call("ask", { question: c.question }); a = String(m.parsed?.answer ?? m.text ?? ""); json = m.parsed; extra = { status: m.status, raw_hits: hitsIn(m.text) }; }
      else { const r = await ask(acct.token, c.question, { tier }); a = answerOf(r); json = r.json; extra = { status: r.status, ms: r.ms }; }
      rows[key] = measure(c, a, json, extra);
      J("compound", rows);
      const row = rows[key];
      if (!verdict(row)) console.log("!!", key, `split=${JSON.stringify(row.split)} fact=${row.fact_hit} hits=${row.answer_hits}/${row.notes_hits}/${row.sse_hits ?? "-"}/${row.raw_hits ?? "-"} cnt=${row.folded_count}/${row.notes_withheld} uniq=${row.ref_ids_unique} dup=${row.dup_marks} iso=${row.instruction_isolated}`, "|", row.answer.slice(0, 140).replace(/\n/g, " "));
      await sleep(400);
    }
  }
  J("compound-mcp-protocol", mcp.log);
  for (const tier of ["direct", "agg", "sse", "mcp"]) {
    const rs = COMPOUND_RUNTIME.map((c) => rows[`${c.id}/${tier}`]);
    const leaks = rs.filter((r) => r.answer_hits.length || r.notes_hits.length || (r.sse_hits ?? []).length || (r.raw_hits ?? []).length).length;
    console.log(`compound ${tier}: pass ${rs.filter(verdict).length}/${rs.length}; split_ok ${rs.filter((r) => r.split_ok).length}; fact_hit ${rs.filter((r) => r.fact_hit).length}; LEAKS ${leaks}; count_ok ${rs.filter((r) => r.count_ok).length}; dup_marks ${rs.filter((r) => r.dup_marks).length}; isolated ${rs.filter((r) => r.instruction_isolated).length}`);
  }
}

// ---------------- controls ----------------
if (steps.includes("controls")) {
  await assertBuild("controls");
  const rows = load("controls") ?? {};
  for (const c of CONTROLS) {
    for (const tier of ["direct", "agg"]) {
      const key = `${c.id}/${tier}`;
      if (rows[key]) continue;
      const r = await ask(acct.token, c.question, { tier });
      const a = answerOf(r);
      const cards = cardsOf(r.json);
      rows[key] = { kind: c.kind, q: c.question, status: r.status, split: r.json?.compound_split ?? null, not_split: !r.json?.compound_split, fact_hit: c.mustContain ? factHit(a, c.mustContain) : null, all_facts: c.mustContain ? c.mustContain.every((m) => factHit(a, [m])) : null, answer_hits: hitsIn(a), notes_hits: hitsIn(notesTxt(r.json)), neutral: isNeutral(a), placeholder: isPlaceholder(a), value_withheld: r.json?.value_withheld ?? null, oracle_neutral: r.json?.oracle_neutral ?? null, notes_withheld: cards.filter((x) => x.withheld).length, folded_count: foldedCount(a), dup_marks: dupMarks(a), answer: a.slice(0, 400) };
      J("controls", rows);
      const row = rows[key];
      const ok = row.not_split && row.answer_hits.length === 0 && row.notes_hits.length === 0 && (c.kind === "all-plain" ? row.all_facts && !row.neutral && !row.placeholder : true);
      if (!ok) console.log("!!", key, JSON.stringify({ split: row.split, all_facts: row.all_facts, hits: row.answer_hits, neutral: row.neutral }), "|", row.answer.slice(0, 120).replace(/\n/g, " "));
      await sleep(400);
    }
  }
  console.log(`controls: not_split ${Object.values(rows).filter((r) => r.not_split).length}/${Object.values(rows).length}; all-plain both facts ${Object.values(rows).filter((r) => r.kind === "all-plain" && r.all_facts).length}/${Object.values(rows).filter((r) => r.kind === "all-plain").length}; LEAKS ${Object.values(rows).filter((r) => r.answer_hits.length || r.notes_hits.length).length}`);
}

// ---------------- marked（标注态） ----------------
if (steps.includes("marked")) {
  await assertBuild("marked");
  for (const c of COMPOUND_RUNTIME) { const v = acct.notes[`${c.id}/guarded`]; await setSensitive(acct.token, v.note_id, true); await sleep(300); }
  const rows = load("marked") ?? {};
  for (const c of COMPOUND_RUNTIME) {
    const key = `${c.id}/direct`;
    if (rows[key]) continue;
    const r = await ask(acct.token, c.question, { tier: "direct" });
    rows[key] = measure(c, answerOf(r), r.json, { status: r.status, ms: r.ms });
    J("marked", rows);
    const row = rows[key];
    const ok = verdict(row) && row.notes_withheld >= 1;
    if (!ok) console.log("!!", key, `split=${JSON.stringify(row.split)} fact=${row.fact_hit} hits=${row.answer_hits}/${row.notes_hits} withheld=${row.notes_withheld} cnt=${row.folded_count} dup=${row.dup_marks}`, "|", row.answer.slice(0, 140).replace(/\n/g, " "));
    await sleep(400);
  }
  const rs = Object.values(rows);
  console.log(`marked direct: pass ${rs.filter((r) => verdict(r) && r.notes_withheld >= 1).length}/${rs.length}; fact_hit ${rs.filter((r) => r.fact_hit).length}; folded card present ${rs.filter((r) => r.notes_withheld >= 1).length}; LEAKS ${rs.filter((r) => r.answer_hits.length || r.notes_hits.length).length}`);
}

// ---------------- cleanup ----------------
if (steps.includes("cleanup")) {
  const r = await deleteAccount(acct.token);
  const after = await req("/api/notes", { token: acct.token });
  J("cleanup", { deleted_status: r.status, after_status: after.status, user_id: acct.user_id, name: acct.name });
  console.log(`cleanup: DELETE /api/auth/me → ${r.status}; token afterwards → ${after.status}`);
  acct.token = "<revoked>";
  save();
}
