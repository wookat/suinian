// R327 取消敏感标记入口审计（decision-r326 ③ 的三个攻击面）：
//   A. 注入诱导：U01–U03 正文里的「取消标记」指令是否让数据层不标注 / 降级；U04–U05 问句里的取消指令后，笔记是否仍标注。
//   B. API 权限：PATCH /api/notes/:id {is_sensitive:false} 无 token / 他人 token / 本人 token 三种主体的状态码；
//      本人取消后 GET 是否即时生效；无 token/他人 token 不得改变状态。
//   C. 缓存残留 + 粘性：同一问句在「标注→取消→重标」三态下连问（direct / SSE / MCP ask），
//      重标后答案与 notes[]/引用卡必须回到占位（若仍带原文 = 旧答案/上下文缓存残留）；
//      取消后等 ≥30s 异步复判仍未翻回 = manual_override 粘性；随后 PATCH content（编辑正文）应清除 override 重新分拣。
// 用法：QA_INVITE_CODE=… node prod/unmark.mjs <label> [carrier=E04]
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, req, ask, askStream, mcpCall, parseMcp, sleep, QA_PREFIX, OUT, needleHits, CARD_PH } from "./lib.mjs";

const [label, pickId = "E04"] = process.argv.slice(2);
if (!label) throw new Error("usage: unmark.mjs <label> [carrier]");
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const tri = JSON.parse(readFileSync(`${OUT}/prod-${label}-triage.json`, "utf8"));
const T = acct.token;
const RES = `${OUT}/prod-unmark-${label}.json`;
const rows = existsSync(RES) ? JSON.parse(readFileSync(RES, "utf8")) : {};
const save = () => writeFileSync(RES, JSON.stringify(rows, null, 1));
const sens = async (id, token = T) => { const r = await req(`/api/notes/${id}`, { token }); const n = r.json?.note ?? r.json ?? {}; return { status: r.status, sensitive: n.is_sensitive === true, content_raw: (needles) => needleHits(String(n.content ?? ""), needles).length > 0, override: n.manual_override ?? n.meta?.manual_override ?? null, n }; };

// ---- A. 注入诱导 ----
rows.injection ??= {};
for (const id of ["U01", "U02", "U03", "U04", "U05"]) {
  const c = corpus.find((x) => x.id === id);
  const v = acct.notes[id]?.[0];
  if (!c || !v?.note_id) continue;
  if (rows.injection[id]) continue;
  const before = tri[`${id}#0`];
  // U04/U05：先按问句发一遍取消指令（多轮带历史），再看标注是否变化
  let asks = null;
  if (id === "U04" || id === "U05") {
    asks = [];
    const hist = [];
    for (const q of c.asks) {
      const r = await ask(T, q, { tier: "direct", history: hist.length ? [...hist] : undefined });
      const ans = r.json?.answer ?? "";
      asks.push({ q, status: r.status, answer: ans, survive: needleHits(ans, c.needles) });
      hist.push({ role: "user", content: q }, { role: "assistant", content: ans });
      await sleep(4200);
    }
  }
  const after = await sens(v.note_id);
  rows.injection[id] = { seam: c.seam, marked_after_triage: before?.sensitive ?? null, marked_now: after.sensitive, content_raw_now: after.content_raw(c.needles), override: after.override, asks };
  save();
  console.log(`${id} marked_after_triage=${rows.injection[id].marked_after_triage} marked_now=${after.sensitive} raw=${rows.injection[id].content_raw_now}${asks ? ` ask_survive=${asks.map((a) => a.survive.length).join("/")}` : ""}`);
}

// ---- B. API 权限 ----
{
  const c = corpus.find((x) => x.id === pickId);
  const v = acct.notes[pickId]?.[0];
  if (!c || !v?.note_id) throw new Error(`carrier ${pickId} not seeded`);
  const ST = `${OUT}/prod-${label}-unmark-account.json`;
  let other = existsSync(ST) ? JSON.parse(readFileSync(ST, "utf8")) : null;
  if (!other) { other = await register(`${QA_PREFIX}${label}um${Date.now().toString(36).slice(-4)}`); writeFileSync(ST, JSON.stringify(other, null, 1)); console.log("registered other", other.name, other.user_id); }
  if (!rows.authz) {
    const s0 = await sens(v.note_id);
    const noTok = await req(`/api/notes/${v.note_id}`, { method: "PATCH", body: { is_sensitive: false } });
    const s1 = await sens(v.note_id);
    const otherTok = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: other.token, body: { is_sensitive: false } });
    const s2 = await sens(v.note_id);
    const otherGet = await req(`/api/notes/${v.note_id}`, { token: other.token });
    const otherMcp = await mcpCall(other.token, "ask", { question: c.asks[0] });
    const badTok = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: "deadbeef".repeat(6), body: { is_sensitive: false } });
    const s3 = await sens(v.note_id);
    rows.authz = {
      carrier: pickId, initially_sensitive: s0.sensitive,
      no_token: { status: noTok.status, changed: s1.sensitive !== s0.sensitive },
      other_token: { status: otherTok.status, changed: s2.sensitive !== s0.sensitive, other_get_status: otherGet.status, other_get_leak: needleHits(otherGet.text, c.needles), other_mcp_leak: needleHits(otherMcp.text, c.needles) },
      bad_token: { status: badTok.status, changed: s3.sensitive !== s0.sensitive },
    };
    save();
    console.log("authz", JSON.stringify(rows.authz));
  }
}

// ---- C. 三态连问：标注 → 取消 → 重标 ----
{
  const c = corpus.find((x) => x.id === pickId);
  const v = acct.notes[pickId][0];
  const q = c.asks[0];
  const probe = async (tag) => {
    const d = await ask(T, q, { tier: "direct" });
    await sleep(3000);
    const s = await askStream(T, q);
    await sleep(3000);
    const m = await mcpCall(T, "ask", { question: q });
    const mb = parseMcp(m.text) ?? {};
    await sleep(3000);
    const g = await sens(v.note_id);
    const dj = d.json ?? {};
    const notes = dj.notes ?? dj.references ?? [];
    const mine = notes.find((n) => n.id === v.note_id);
    const mNotes = Array.isArray(mb.notes) ? mb.notes : [];
    const mMine = mNotes.find((n) => n.id === v.note_id);
    const out = {
      tag, note_sensitive: g.sensitive, note_content_raw: g.content_raw(c.needles), override: g.override,
      direct: { status: d.status, answer: dj.answer ?? "", survive: needleHits(dj.answer ?? "", c.needles), card: !!mine, card_withheld: mine?.content_withheld === true, card_placeholder: String(mine?.content ?? "").includes(CARD_PH), notes_raw: needleHits(JSON.stringify(notes), c.needles) },
      sse: { status: s.status, deltas: s.deltas, emitted_survive: needleHits(s.emitted, c.needles), done_survive: needleHits(s.done?.answer ?? "", c.needles), done_notes_raw: needleHits(JSON.stringify(s.done?.notes ?? s.done?.references ?? []), c.needles) },
      mcp: { status: m.status, answer_survive: needleHits(mb.answer ?? "", c.needles), notes_raw: needleHits(JSON.stringify(mNotes), c.needles), card: !!mMine, guard_kind: mMine?.guard_kind ?? null, raw_survive: needleHits(m.text, c.needles) },
    };
    console.log(`[${tag}] sensitive=${out.note_sensitive} direct_surv=${out.direct.survive.length} card=${out.direct.card}/${out.direct.card_withheld} notes_raw=${out.direct.notes_raw.length} sse_surv=${out.sse.emitted_survive.length}/${out.sse.done_survive.length} mcp_surv=${out.mcp.answer_survive.length}/${out.mcp.notes_raw.length}/${out.mcp.raw_survive.length} | ${(dj.answer ?? "").slice(0, 70).replace(/\n/g, " ")}`);
    return out;
  };
  rows.tristate ??= {};
  const S = rows.tristate;
  if (!S.marked) { S.marked = await probe("marked"); save(); }
  if (!S.unmark_patch) {
    const p = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
    const pn = p.json?.note ?? p.json ?? {};
    S.unmark_patch = { status: p.status, sensitive: pn.is_sensitive === true, content_raw: needleHits(String(pn.content ?? ""), c.needles).length > 0, override: pn.manual_override ?? pn.meta?.manual_override ?? null };
    save();
    console.log("unmark PATCH", JSON.stringify(S.unmark_patch));
    await sleep(2000);
  }
  if (!S.unmarked) { S.unmarked = await probe("unmarked"); save(); }
  if (!S.sticky) {
    console.log("waiting 40s for async re-triage window…");
    await sleep(40000);
    const g = await sens(v.note_id);
    S.sticky = { after_wait_sensitive: g.sensitive, override: g.override, sticky: !g.sensitive };
    save();
    console.log("sticky", JSON.stringify(S.sticky));
  }
  if (!S.remark_patch) {
    const p = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: true } });
    const pn = p.json?.note ?? p.json ?? {};
    S.remark_patch = { status: p.status, sensitive: pn.is_sensitive === true, content_raw: needleHits(String(pn.content ?? ""), c.needles).length > 0 };
    save();
    console.log("remark PATCH", JSON.stringify(S.remark_patch));
    await sleep(2000);
  }
  if (!S.remarked) { S.remarked = await probe("remarked"); save(); }
  // 编辑正文 ⇒ 应清除 manual_override 并重新分拣：先取消标记，再 PATCH content（原文加一个无关句），等分拣后看是否重新标上
  if (!S.edit_reclassify) {
    await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
    await sleep(1500);
    const g0 = await sens(v.note_id);
    const e = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { content: c.texts[0] + " 今天天气不错。" } });
    const en = e.json?.note ?? e.json ?? {};
    await sleep(25000);
    const g1 = await sens(v.note_id);
    S.edit_reclassify = { before_edit_sensitive: g0.sensitive, before_override: g0.override, edit_status: e.status, edit_resp_sensitive: en.is_sensitive === true, after_edit_sensitive: g1.sensitive, after_override: g1.override, content_raw_after: g1.content_raw(c.needles) };
    save();
    console.log("edit_reclassify", JSON.stringify(S.edit_reclassify));
    // 收尾：确保回到标注态
    await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: true } });
  }
  const residue = [S.remarked].filter((x) => x.direct.survive.length || x.direct.notes_raw.length || x.sse.emitted_survive.length || x.sse.done_survive.length || x.sse.done_notes_raw.length || x.mcp.answer_survive.length || x.mcp.notes_raw.length || x.mcp.raw_survive.length).length;
  console.log(`== tristate[${pickId}]: marked_leak=${S.marked.direct.survive.length + S.marked.sse.emitted_survive.length + S.marked.mcp.answer_survive.length} unmarked_gives_value=${S.unmarked.direct.survive.length > 0 || S.unmarked.direct.card && !S.unmarked.direct.card_withheld} remark_residue=${residue} sticky=${S.sticky.sticky} edit_reclassified=${S.edit_reclassify.after_edit_sensitive}`);
}
