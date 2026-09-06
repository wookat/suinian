// R326 找回矩阵 + 善意误标率（decision-r326 §7）：
//   1) 把 R325 B 族善意语料（B01–B34 日常散文 + BR01–BR10 正当找回）走默认分拣入库，量自动标敏感率（校准后实测值；
//      校准前口径 = audit-r325 §5 的 6/10 正当找回被标 + 本仓 main 的 maybeSensitive 规则层，见 calibration.ts）；
//   2) 对 ≥10 条「普通笔记 + 敏感标注」（自动标上的优先，不足则显式 PATCH is_sensitive:true 补齐）逐条量：
//      ask 直答必须给引用卡（notes[] 含该条、content_withheld=true、原文 0 出现）、REST 搜索必须命中（原文按登录态契约在列表里）、
//      GET /api/notes/:id 点开必见原文、MCP ask notes[] 对该条 0 原文（占位体 + id）；
//   3) 取消敏感标记：PATCH is_sensitive:false 后再问，同一条应退出占位（answer 可含原文或 notes[] content_withheld=false），
//      且等待异步复判后仍保持未标（manual_override 粘性）。
// 用法：QA_INVITE_CODE=… node prod/recall.mjs <label> [step=seed|matrix|unmark|all]
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, ask, mcpCall, sleep, QA_PREFIX, OUT, norm } from "./lib.mjs";

const [label, step = "all"] = process.argv.slice(2);
if (!label) throw new Error("usage: recall.mjs <label> [seed|matrix|unmark|all]");
const STATE = `${OUT}/prod-${label}-account.json`;
const RES = `${OUT}/prod-recall-${label}.json`;
const blind = JSON.parse(readFileSync(`${OUT}/blind.json`, "utf8"));
const B = blind.filter((c) => c.cat === "benign");
const rows = existsSync(RES) ? JSON.parse(readFileSync(RES, "utf8")) : {};
const save = () => writeFileSync(RES, JSON.stringify(rows, null, 1));
const MIN_MARKED = 10;
const CARD_PH = "敏感笔记：正文已加密保护";

// 每条善意笔记的「取值片段」：原文里最像被找回对象的 token（数字 / 拉丁串 / 书名号内文），用于量原文是否出现
const needleOf = (text) => {
  const m = text.match(/[A-Za-z]*\d[\dA-Za-z\s]{2,}|《[^》]+》|[A-Za-z]{5,}\d*/);
  return m ? m[0].trim() : text.replace(/[，。：:；;]/g, "").slice(0, 8);
};
const inText = (hay, needle) => norm(hay).includes(norm(needle));

let acct;
if (existsSync(STATE)) acct = JSON.parse(readFileSync(STATE, "utf8"));
else {
  acct = await register(`${QA_PREFIX}${label}${Date.now().toString(36).slice(-4)}`);
  acct.notes = {};
  acct.corpus = "blind";
  acct.cat = "benign";
  acct.triage = true;
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;

function parseMcp(text) {
  try {
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
    const rpc = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    return JSON.parse(rpc.result?.content?.find((c) => c.type === "text")?.text ?? "{}");
  } catch {
    return {};
  }
}

// ---- 1) 默认分拣入库 + 自动标注率 ----
if (step === "seed" || step === "all") {
  for (const c of B) {
    if (acct.notes[c.id]?.[0]?.note_id) continue;
    const r = await postNote(T, c.texts[0], {});
    const n = r.note ?? r;
    acct.notes[c.id] = [{ note_id: n.id ?? null }];
    writeFileSync(STATE, JSON.stringify(acct, null, 1));
    await sleep(2500);
  }
  console.log("seeded", Object.keys(acct.notes).length, "benign notes; waiting for triage…");
  await sleep(20000);
  for (const c of B) {
    const id = acct.notes[c.id][0].note_id;
    const r = await req(`/api/notes/${id}`, { token: T });
    const n = r.json?.note ?? r.json ?? {};
    rows[c.id] = { ...(rows[c.id] ?? {}), family: c.family, text: c.texts[0], ask: c.asks[0], note_id: id, needle: needleOf(c.texts[0]), auto_sensitive: n.is_sensitive === true, category: n.category ?? null, title: n.title ?? null };
    await sleep(300);
  }
  save();
  const all = B.map((c) => rows[c.id]);
  const br = all.filter((r) => /retrieve/.test(r.family));
  const fp = (xs) => `${xs.filter((r) => r.auto_sensitive).length}/${xs.length}`;
  console.log(`[auto-sensitive after calibration] all=${fp(all)} retrieve(BR)=${fp(br)} prose(B)=${fp(all.filter((r) => !/retrieve/.test(r.family)))} marked: ${all.filter((r) => r.auto_sensitive).map((r) => r.family.replace("benign-", "")).join(",")}`);
}

// ---- 2) 找回矩阵（≥10 条带敏感标注的普通笔记）----
if (step === "matrix" || step === "all") {
  const auto = B.filter((c) => rows[c.id]?.auto_sensitive);
  const fill = B.filter((c) => !rows[c.id]?.auto_sensitive && /retrieve/.test(c.family)).concat(B.filter((c) => !rows[c.id]?.auto_sensitive && !/retrieve/.test(c.family)));
  const chosen = [...auto, ...fill.slice(0, Math.max(0, MIN_MARKED - auto.length))];
  for (const c of chosen) {
    const R = rows[c.id];
    if (R.matrix?.ok !== undefined) continue;
    if (!R.auto_sensitive && !R.manual_marked) {
      const p = await req(`/api/notes/${R.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: true } });
      R.manual_marked = p.status === 200 && (p.json?.note?.is_sensitive === true || p.json?.is_sensitive === true);
      await sleep(800);
    }
    // 2a ask 直答
    const a = await ask(T, c.asks[0], { tier: "direct" });
    const j = a.json ?? {};
    const notes = j.notes ?? [];
    const mine = notes.find((n) => n.id === R.note_id);
    const ans = j.answer ?? "";
    // 2b REST 搜索（用非取值的话题词）
    const kw = c.texts[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").find((w) => w.length >= 2 && !inText(w, R.needle) && !/\d/.test(w)) ?? c.texts[0].slice(0, 2);
    const s = await req(`/api/notes?q=${encodeURIComponent(kw)}&limit=20`, { token: T });
    const sHit = (s.json?.notes ?? []).find((n) => n.id === R.note_id);
    // 2c 点开
    const g = await req(`/api/notes/${R.note_id}`, { token: T });
    const gn = g.json?.note ?? g.json ?? {};
    // 2d MCP ask notes[]
    const m = await mcpCall(T, "ask", { question: c.asks[0] });
    const mb = parseMcp(m.text);
    const mNotes = mb.notes ?? [];
    const mMine = mNotes.find((n) => n.id === R.note_id);
    R.matrix = {
      search_kw: kw,
      ask_status: a.status, ask_answer: ans, ask_sensitive_cards: j.sensitive_cards === true, ask_trust_tier: j.trust_tier ?? null,
      ask_card: !!mine, ask_card_withheld: mine?.content_withheld === true, ask_card_placeholder: typeof mine?.content === "string" && mine.content.includes(CARD_PH),
      ask_answer_raw: inText(ans, R.needle), ask_notes_raw: inText(JSON.stringify(notes), R.needle) || inText(JSON.stringify(notes), c.texts[0].slice(0, 10)),
      search_status: s.status, search_hit: !!sHit, search_sensitive_flag: sHit?.is_sensitive === true,
      open_status: g.status, open_raw: inText(String(gn.content ?? ""), c.texts[0].slice(0, 10)), open_sensitive: gn.is_sensitive === true,
      mcp_status: m.status, mcp_card: !!mMine, mcp_guard_kind: mMine?.guard_kind ?? null, mcp_notes_raw: inText(JSON.stringify(mNotes), R.needle) || inText(JSON.stringify(mNotes), c.texts[0].slice(0, 10)), mcp_answer_raw: inText(mb.answer ?? "", R.needle),
    };
    R.matrix.ok = R.matrix.ask_card && R.matrix.ask_card_withheld && !R.matrix.ask_answer_raw && !R.matrix.ask_notes_raw && R.matrix.search_hit && R.matrix.open_raw && !R.matrix.mcp_notes_raw && !R.matrix.mcp_answer_raw && (!R.matrix.mcp_card || R.matrix.mcp_guard_kind === "sensitive");
    save();
    console.log(`${c.id} ${R.matrix.ok ? "OK  " : "FAIL"} card=${R.matrix.ask_card} withheld=${R.matrix.ask_card_withheld} ans_raw=${R.matrix.ask_answer_raw} notes_raw=${R.matrix.ask_notes_raw} search=${R.matrix.search_hit} open=${R.matrix.open_raw} mcp_card=${R.matrix.mcp_card}/${R.matrix.mcp_guard_kind} mcp_raw=${R.matrix.mcp_notes_raw || R.matrix.mcp_answer_raw} | ${ans.slice(0, 60).replace(/\n/g, " ")}`);
    await sleep(4200);
  }
  const done = chosen.filter((c) => rows[c.id].matrix);
  const zero = done.filter((c) => !rows[c.id].matrix.ask_card);
  console.log(`== recall matrix: marked=${done.length} (auto=${auto.length}) ok=${done.filter((c) => rows[c.id].matrix.ok).length} zero_recall=${zero.length} ${zero.map((c) => c.id).join(",")} search_miss=${done.filter((c) => !rows[c.id].matrix.search_hit).map((c) => c.id).join(",") || 0} raw_leak=${done.filter((c) => rows[c.id].matrix.ask_answer_raw || rows[c.id].matrix.ask_notes_raw || rows[c.id].matrix.mcp_notes_raw || rows[c.id].matrix.mcp_answer_raw).map((c) => c.id).join(",") || 0} open_fail=${done.filter((c) => !rows[c.id].matrix.open_raw).map((c) => c.id).join(",") || 0}`);
}

// ---- 3) 取消敏感标记：退出占位 + 复判粘性 ----
if (step === "unmark" || step === "all") {
  // 选两条：一条日常散文（B 族）、一条正当找回（BR 族）
  const pick = ["B04", "BR07"].map((id) => B.find((c) => c.id === id)).filter((c) => c && rows[c.id]?.matrix);
  for (const c of pick) {
    const R = rows[c.id];
    if (R.unmark?.sticky !== undefined) continue;
    const p = await req(`/api/notes/${R.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
    const pn = p.json?.note ?? p.json ?? {};
    await sleep(1500);
    const a = await ask(T, c.asks[0], { tier: "direct" });
    const j = a.json ?? {};
    const mine = (j.notes ?? []).find((n) => n.id === R.note_id);
    // 等异步复判窗口（retriage 在下一次读取 / 后台扫时触发），再读一次
    await sleep(25000);
    const g = await req(`/api/notes/${R.note_id}`, { token: T });
    const gn = g.json?.note ?? g.json ?? {};
    R.unmark = {
      patch_status: p.status, patch_sensitive: pn.is_sensitive === true,
      ask_answer: j.answer ?? "", ask_card: !!mine, ask_card_withheld: mine?.content_withheld === true, ask_exits_placeholder: !!mine && mine.content_withheld !== true && !String(mine.content ?? "").includes(CARD_PH),
      after_wait_sensitive: gn.is_sensitive === true, sticky: g.status === 200 && gn.is_sensitive !== true,
    };
    save();
    console.log(`${c.id} unmark patch=${p.status} exits_placeholder=${R.unmark.ask_exits_placeholder} sticky_after_wait=${R.unmark.sticky} | ${R.unmark.ask_answer.slice(0, 80).replace(/\n/g, " ")}`);
    await sleep(4200);
  }
}
