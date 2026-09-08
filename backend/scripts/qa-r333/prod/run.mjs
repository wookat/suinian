// R333 生产实测主流程（一个 QA 账号承载全部危险载体 + 全部善意语料）：
//   seed    注册 [QA-R333] 账号，逐条入库（默认走分拣主路径），等分拣后逐条读回记录 is_sensitive / 派生标题标签是否泄值
//   marked  标注态：对每条载体按 GENERIC_ASKS 直答（direct）——衡量「漏标 + 出口层兜底」
//   unmark  手动取消全部标注（PATCH is_sensitive:false），读回确认
//   matrix  取消标注后全出口：direct / agg / SSE(delta+done) / MCP ask(answer + notes[]) / 多轮
//   benign  善意 50 条 direct + agg 占位率 + 照抄找回
//   outlets 非问答出口：REST search / MCP search_notes / 回顾 / 线索 / 周报月报 / export / backup
// 用法：QA_INVITE_CODE=… node prod/run.mjs <step> [step…]    （状态：out/account-main.json，仅 token/user_id/name）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CARRIERS, BENIGN, GENERIC_ASKS, MULTI_TURN, ORACLE_ASKS, VERBATIM_RECALL, BUILT_AT } from "../blind-corpus.mjs";
import { OUT, register, postNote, getNote, ask, askStream, McpSession, req, sleep, valueHits, derivedHits, isPlaceholder, isNeutral, isNoAnswer, verdictOf, norm } from "./lib.mjs";

const steps = process.argv.slice(2);
if (steps.length === 0) throw new Error("step required: seed|marked|unmark|matrix|benign|outlets|mcp-runtime");
const STATE = `${OUT}/account-main.json`;
let acct = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const save = () => writeFileSync(STATE, JSON.stringify(acct, null, 1));
const J = (name, obj) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(obj, null, 1));
const load = (name) => (existsSync(`${OUT}/${name}.json`) ? JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8")) : null);
const asksFor = (c) => [...Object.entries(GENERIC_ASKS).map(([k, t]) => [k, t.replace("{topic}", c.topic)]), ...(c.asks ?? []).map((a, i) => [`own${i + 1}`, a])];
// SSE / MCP 出口只用取值型 + 复述型两问（出口差异看的是同一答案在不同通道的收口，不必全问法重复）
const SIDE_ASKS = new Set(["direct", "paraphrase", "verbatim", "own1"]);
// oracle 邻域句式打在 6 条形态各异的载体上（8 位数字 / 纯汉字 / 混排 / 空格分隔 / 大写字母数字 / 汉数混排）
const ORACLE_TARGETS = new Set(["C01", "C05", "C07", "C13", "C20", "C23"]);

function measure(answer, c) {
  const hits = valueHits(answer, c.secrets);
  const der = derivedHits(answer, c.secrets);
  return { hits, derived: der, leak: hits.length > 0 || der.length > 0, placeholder: isPlaceholder(answer), neutral: isNeutral(answer), no_answer: isNoAnswer(answer), len: String(answer ?? "").length };
}
function refLeak(resp, c) {
  // references / notes[] 里的标题、正文是否带值
  const notes = resp?.notes ?? [];
  const txt = notes.map((n) => `${n.title ?? ""}\n${n.content ?? ""}\n${(n.tags ?? []).join(" ")}`).join("\n");
  return { notes_n: notes.length, notes_value_hits: valueHits(txt, c.secrets), notes_guarded: notes.filter((n) => n.guarded).length, refs: (resp?.references ?? []).length };
}

// ---------------- seed ----------------
if (steps.includes("seed")) {
  if (!acct) {
    acct = await register("main");
    acct.corpus_built_at = BUILT_AT;
    acct.notes = {};
    save();
    console.log("registered", acct.name, acct.user_id);
  }
  const all = [...CARRIERS.map((c) => ({ id: c.id, text: c.note })), ...BENIGN.map((b) => ({ id: b.id, text: b.note }))];
  for (const it of all) {
    if (acct.notes[it.id]) continue;
    const n = await postNote(acct.token, it.text);
    acct.notes[it.id] = { note_id: n.id, sensitive_at_post: n.is_sensitive ?? null, posted_at: new Date().toISOString() };
    save();
    console.log("posted", it.id, n.id, "sens@post=", n.is_sensitive ?? null);
    await sleep(2200);
  }
  console.log("waiting 40s for async triage…");
  await sleep(40000);
  const tri = {};
  for (const c of CARRIERS) {
    const n = await getNote(acct.token, acct.notes[c.id].note_id);
    const derived = [n.title, ...(Array.isArray(n.tags) ? n.tags : []), n.summary, n.url_summary].filter(Boolean).join("\n");
    tri[c.id] = { family: c.family, sensitive: n.is_sensitive === true, content_withheld: n.content_withheld === true, title: n.title ?? null, tags: n.tags ?? null, category: n.category ?? null, derived_value_hits: valueHits(derived, c.secrets), manual_override: n.manual_override ?? n.meta?.manual_override ?? null };
    await sleep(250);
  }
  for (const b of BENIGN) {
    const n = await getNote(acct.token, acct.notes[b.id].note_id);
    tri[b.id] = { kind: b.kind, sensitive: n.is_sensitive === true, title: n.title ?? null, category: n.category ?? null };
    await sleep(250);
  }
  J("seed-triage", tri);
  const cs = CARRIERS.map((c) => tri[c.id]);
  console.log(`carriers marked sensitive: ${cs.filter((t) => t.sensitive).length}/${cs.length}; derived title/tag leak: ${cs.filter((t) => t.derived_value_hits.length).length}`);
  console.log(`benign marked sensitive (误标): ${BENIGN.filter((b) => tri[b.id].sensitive).map((b) => b.id).join(",") || 0}`);
}

if (!acct && steps.some((s) => s !== "seed")) throw new Error("no account state; run seed first");

// ---------------- marked / matrix ----------------
async function runMatrix(tag, { tiers = ["direct"], sse = false, mcp = false, multi = false, oracle = false }) {
  const rows = load(`${tag}`) ?? {};
  const mcpS = mcp ? new McpSession(acct.token) : null;
  if (mcpS) console.log("mcp handshake", JSON.stringify(await mcpS.handshake()));
  for (const c of CARRIERS) {
    for (const [k, q] of asksFor(c)) {
      for (const tier of tiers) {
        const key = `${c.id}/${k}/${tier}`;
        if (rows[key]) continue;
        const r = await ask(acct.token, q, { tier });
        const a = r.json?.answer ?? r.text;
        rows[key] = { q, tier, status: r.status, ...measure(a, c), ...refLeak(r.json, c), value_withheld: r.json?.value_withheld ?? null, oracle_neutral: r.json?.oracle_neutral ?? null, answer: String(a).slice(0, 400) };
        J(tag, rows);
        if (rows[key].leak) console.log("LEAK", key, JSON.stringify(rows[key].hits), rows[key].derived.join(","), "|", String(a).slice(0, 120).replace(/\n/g, " "));
        await sleep(350);
      }
      if (sse && SIDE_ASKS.has(k)) {
        const key = `${c.id}/${k}/sse`;
        if (!rows[key]) {
          const s = await askStream(acct.token, q);
          const em = measure(s.emitted, c);
          const dn = measure(s.done?.answer ?? "", c);
          rows[key] = { q, tier: "sse", status: s.status, sse: s.sse, deltas: s.deltas, emitted_leak: em.leak, emitted_hits: em.hits, done_leak: dn.leak, done_hits: dn.hits, done_placeholder: dn.placeholder, leak: em.leak || dn.leak, emitted: s.emitted.slice(0, 300), done: String(s.done?.answer ?? "").slice(0, 300) };
          J(tag, rows);
          if (rows[key].leak) console.log("LEAK", key, "emitted:", em.hits, "done:", dn.hits);
          await sleep(350);
        }
      }
      if (mcpS && SIDE_ASKS.has(k)) {
        const key = `${c.id}/${k}/mcp`;
        if (!rows[key]) {
          const m = await mcpS.call("ask", { question: q });
          const a = m.parsed?.answer ?? m.text;
          rows[key] = { q, tier: "mcp", status: m.status, ...measure(a, c), ...refLeak(m.parsed, c), raw_hits: valueHits(m.text, c.secrets), answer: String(a).slice(0, 400) };
          rows[key].leak = rows[key].leak || rows[key].notes_value_hits.length > 0 || rows[key].raw_hits.length > 0;
          J(tag, rows);
          if (rows[key].leak) console.log("LEAK", key, JSON.stringify(rows[key].hits), "notes:", rows[key].notes_value_hits, "raw:", rows[key].raw_hits);
          await sleep(350);
        }
      }
    }
    if (multi) {
      for (const [mk, turns] of Object.entries(MULTI_TURN)) {
        if (!mk.endsWith(c.id)) continue;
        for (const tier of ["direct", "agg"]) {
          const key = `${c.id}/multi:${mk}/${tier}`;
          if (rows[key]) continue;
          const history = [];
          const trail = [];
          for (const t of turns) {
            const r = await ask(acct.token, t, { tier, history: history.length ? history : undefined });
            const a = r.json?.answer ?? r.text;
            trail.push({ q: t, ...measure(a, c), verdict: verdictOf(a), answer: String(a).slice(0, 200) });
            history.push({ role: "user", content: t }, { role: "assistant", content: String(a).slice(0, 1500) });
            await sleep(350);
          }
          const joined = trail.map((t) => t.answer).join("\n");
          rows[key] = { tier, turns: trail, leak: trail.some((t) => t.leak) || valueHits(joined, c.secrets).length > 0, joined_hits: valueHits(joined, c.secrets), verdicts: trail.map((t) => t.verdict) };
          J(tag, rows);
          if (rows[key].leak) console.log("LEAK", key, rows[key].joined_hits);
        }
      }
    }
    if (oracle && ORACLE_TARGETS.has(c.id)) {
      for (const [i, t] of ORACLE_ASKS.entries()) {
        const q = t.replace("{topic}", c.topic);
        for (const tier of ["direct", "agg"]) {
          const key = `${c.id}/oracle${i + 1}/${tier}`;
          if (rows[key]) continue;
          const r = await ask(acct.token, q, { tier });
          const a = r.json?.answer ?? r.text;
          rows[key] = { q, tier, status: r.status, ...measure(a, c), verdict: verdictOf(a), oracle_neutral: r.json?.oracle_neutral ?? null, refs: (r.json?.references ?? []).length, answer: String(a).slice(0, 300) };
          J(tag, rows);
          if (rows[key].leak) console.log("LEAK", key, rows[key].hits);
          await sleep(350);
        }
      }
    }
  }
  if (mcpS) J(`${tag}-mcp-protocol`, mcpS.log);
  const vals = Object.values(rows);
  console.log(`${tag}: cells=${vals.length} leak=${vals.filter((v) => v.leak).length} placeholder=${vals.filter((v) => v.placeholder).length} neutral=${vals.filter((v) => v.neutral).length}`);
  return rows;
}

if (steps.includes("marked")) await runMatrix("marked-direct", { tiers: ["direct"] });

if (steps.includes("unmark")) {
  const res = {};
  for (const c of CARRIERS) {
    const id = acct.notes[c.id].note_id;
    const before = await getNote(acct.token, id);
    let p = null;
    if (before.is_sensitive) {
      p = await req(`/api/notes/${id}`, { method: "PATCH", token: acct.token, body: { is_sensitive: false } });
      await sleep(800);
    }
    const after = await getNote(acct.token, id);
    res[c.id] = { was: before.is_sensitive === true, patch: p?.status ?? null, now: after.is_sensitive === true, content_raw_hits: valueHits(after.content ?? "", c.secrets).length, manual_override: after.manual_override ?? after.meta?.manual_override ?? null };
    await sleep(300);
  }
  J("unmark", res);
  console.log("unmark: still sensitive after PATCH:", Object.entries(res).filter(([, v]) => v.now).map(([k]) => k).join(",") || "none");
  console.log("waiting 20s then re-check re-marking by backend…");
  await sleep(20000);
  for (const c of CARRIERS) { const n = await getNote(acct.token, acct.notes[c.id].note_id); res[c.id].remarked = n.is_sensitive === true; await sleep(200); }
  J("unmark", res);
  console.log("re-marked:", Object.entries(res).filter(([, v]) => v.remarked).map(([k]) => k).join(",") || "none");
}

if (steps.includes("matrix")) await runMatrix("unmarked-matrix", { tiers: ["direct", "agg"], sse: true, mcp: true, multi: true, oracle: true });

// ---------------- benign ----------------
if (steps.includes("benign")) {
  const rows = load("benign") ?? {};
  for (const b of BENIGN) {
    for (const tier of ["direct", "agg"]) {
      const key = `${b.id}/${tier}`;
      if (rows[key]) continue;
      const r = await ask(acct.token, b.ask, { tier });
      const a = r.json?.answer ?? r.text;
      const expectHit = b.expect ? valueHits(a, b.expect).length > 0 : null;
      rows[key] = { kind: b.kind, ask: b.ask, tier, status: r.status, placeholder: isPlaceholder(a), neutral: isNeutral(a), no_answer: isNoAnswer(a), expect_hit: expectHit, value_withheld: r.json?.value_withheld ?? null, oracle_neutral: r.json?.oracle_neutral ?? null, refs: (r.json?.references ?? []).length, answer: String(a).slice(0, 300) };
      J("benign", rows);
      if (rows[key].placeholder || rows[key].neutral) console.log("FP", key, String(a).slice(0, 100).replace(/\n/g, " "));
      await sleep(350);
    }
  }
  for (const v of VERBATIM_RECALL) {
    const key = `${v.id}/direct`;
    if (rows[key]) continue;
    const r = await ask(acct.token, v.ask);
    const a = r.json?.answer ?? r.text;
    rows[key] = { kind: "verbatim", ask: v.ask, tier: "direct", status: r.status, placeholder: isPlaceholder(a), expect_hit: valueHits(a, v.expect).length > 0, refs: (r.json?.references ?? []).length, answer: String(a).slice(0, 300) };
    J("benign", rows);
    await sleep(350);
  }
  for (const tier of ["direct", "agg"]) {
    const vals = BENIGN.map((b) => rows[`${b.id}/${tier}`]);
    console.log(`benign ${tier}: n=${vals.length} placeholder=${vals.filter((v) => v.placeholder).length} neutral=${vals.filter((v) => v.neutral).length} no_answer=${vals.filter((v) => v.no_answer).length} expect_hit=${vals.filter((v) => v.expect_hit === true).length}/${vals.filter((v) => v.expect_hit !== null).length}`);
  }
  console.log("verbatim:", VERBATIM_RECALL.map((v) => `${v.id}=${rows[`${v.id}/direct`].expect_hit}`).join(" "));
}

// ---------------- outlets ----------------
if (steps.includes("outlets")) {
  const T = acct.token;
  const allSecrets = CARRIERS.flatMap((c) => c.secrets.map((s) => ({ id: c.id, s })));
  const hitsIn = (txt) => allSecrets.filter(({ s }) => valueHits(txt, [s]).length > 0).map(({ id, s }) => `${id}:${s}`);
  const out = { checked_at: new Date().toISOString() };
  // REST search：原文契约（找回靠搜索），记录但不判泄；同时记 fold/withheld 字段
  const sr = await req(`/api/notes?q=${encodeURIComponent("密码")}&limit=50`, { token: T });
  const srNotes = sr.json?.notes ?? sr.json?.items ?? [];
  out.rest_search = { status: sr.status, n: srNotes.length, raw_value_hits: hitsIn(JSON.stringify(srNotes)), fields: Object.keys(srNotes[0] ?? {}) };
  const mcpS = new McpSession(T);
  out.mcp_handshake = await mcpS.handshake();
  const ms = await mcpS.call("search_notes", { query: "密码" });
  out.mcp_search = { status: ms.status, raw_value_hits: hitsIn(ms.text), n: (ms.parsed?.notes ?? []).length, notice: Object.keys(ms.parsed ?? {}) };
  const rv = await req("/api/review/today", { token: T });
  out.review = { status: rv.status, value_hits: hitsIn(rv.text), keys: Object.keys(rv.json ?? {}) };
  const rb = await req("/api/threads/rebuild", { method: "POST", token: T, body: {} });
  await sleep(15000);
  const th = await req("/api/threads", { token: T });
  const threads = th.json?.threads ?? [];
  const thDetails = [];
  for (const t of threads.slice(0, 10)) { const d = await req(`/api/threads/${t.id}`, { token: T }); thDetails.push(d.text); await sleep(300); }
  out.threads = { rebuild: rb.status, status: th.status, n: threads.length, list_value_hits: hitsIn(th.text), detail_value_hits: hitsIn(thDetails.join("\n")) };
  const mt = await mcpS.call("list_threads", {});
  out.mcp_threads = { status: mt.status, value_hits: hitsIn(mt.text) };
  const wk = await req("/api/reports/generate", { method: "POST", token: T, body: { period: "week" } });
  const mo = await req("/api/reports/generate", { method: "POST", token: T, body: { period: "month" } });
  out.reports = { week: wk.status, week_value_hits: hitsIn(wk.text), week_empty: wk.json?.empty ?? null, month: mo.status, month_value_hits: hitsIn(mo.text), month_empty: mo.json?.empty ?? null };
  const mw = await mcpS.call("get_weekly_report", {});
  out.mcp_weekly = { status: mw.status, value_hits: hitsIn(mw.text) };
  const ex = await req("/api/export", { token: T });
  const exmd = await req("/api/export?format=md", { token: T });
  out.export = { json: ex.status, json_value_hits: hitsIn(ex.text).length, md: exmd.status, md_value_hits: hitsIn(exmd.text).length, note: "export 是用户自己的原文导出（契约=原文），只记数不判泄" };
  const bk = await req("/api/backup", { token: T });
  out.backup = { status: bk.status, ct: bk.headers.get("content-type"), bytes: bk.text.length, plaintext_value_hits: hitsIn(bk.text).length, note: "备份契约=原文/加密包；记录明文命中数" };
  const pt = await req("/api/push/test", { method: "POST", token: T, body: {} });
  out.push_test = { status: pt.status, value_hits: hitsIn(pt.text) };
  J("outlets", out);
  J("outlets-mcp-protocol", mcpS.log);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------- mcp-runtime：完整握手 + 会话头 + 工具面 + 一次 ask/search 的协议级记录 ----------------
if (steps.includes("mcp-runtime")) {
  const s = new McpSession(acct.token);
  const hs = await s.handshake();
  const c = CARRIERS[0];
  const a = await s.call("ask", { question: GENERIC_ASKS.direct.replace("{topic}", c.topic) });
  const bad = await s.rpc("tools/call", { name: "ask", arguments: {} });
  const noauth = await fetch("https://suinian-api.zalize.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
  // notes[] 逐条对位：命中值的到底是载体本条还是同被检回的别条（善意条里 2-3 位数字容易撞）
  const notesAudit = {};
  for (const cid of ["C03", "C04", "C10", "C13", "C23", "C29"]) {
    const cc = CARRIERS.find((x) => x.id === cid);
    const m = await s.call("ask", { question: GENERIC_ASKS.direct.replace("{topic}", cc.topic) });
    // raw 命中的上下文：区分「值在 notes[].content」与「值碰巧出现在 id/时间戳等元数据」
    const rawCtx = [];
    for (const sct of cc.secrets) { let i = -1; while ((i = m.text.indexOf(sct, i + 1)) >= 0 && rawCtx.length < 6) rawCtx.push(m.text.slice(Math.max(0, i - 60), i + sct.length + 20)); }
    notesAudit[cid] = {
      answer_hits: valueHits(String(m.parsed?.answer ?? ""), cc.secrets),
      raw_ctx: rawCtx,
      notes: (m.parsed?.notes ?? []).map((n) => ({ is_carrier: n.id === acct.notes[cid].note_id, guarded: n.guarded ?? null, content_hits: valueHits(`${n.title ?? ""}\n${n.content ?? ""}`, cc.secrets), content_head: String(n.content ?? "").slice(0, 60) })),
    };
    await sleep(4500);
  }
  const rt = { handshake: hs, session_id_present: !!s.sessionId, ask_status: a.status, ask_keys: Object.keys(a.parsed ?? {}), ask_answer_head: String(a.parsed?.answer ?? "").slice(0, 200), ask_notes_guarded: (a.parsed?.notes ?? []).filter((n) => n.guarded).length, notes_audit: notesAudit, invalid_args_error: bad.json?.error ?? bad.json?.result?.isError ?? null, unauth_status: noauth.status, log: s.log };
  J("mcp-runtime", rt);
  console.log(JSON.stringify(rt, null, 1));
}
