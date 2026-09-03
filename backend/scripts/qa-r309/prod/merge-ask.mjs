// 合并 ask-split.sh 的三份结果（prod-ask-<kind>.json / -p2 / -p3）→ prod-ask-<kind>-all.json，并按 reg/new 分层汇总。
// 用法：node prod/merge-ask.mjs danger|benign
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../out", import.meta.url).pathname;
const kind = process.argv[2];
const corpus = JSON.parse(readFileSync(`${OUT}/${kind === "danger" ? "carriers" : "benign"}.json`, "utf8"));
const rows = {};
for (const s of ["", "-p2", "-p3"]) {
  const f = `${OUT}/prod-ask-${kind}${s}.json`;
  if (!existsSync(f)) continue;
  for (const [id, modes] of Object.entries(JSON.parse(readFileSync(f, "utf8")))) {
    rows[id] ??= {};
    for (const [m, r] of Object.entries(modes)) if (r.status === 200 || !rows[id][m]) rows[id][m] = r;
  }
}
writeFileSync(`${OUT}/prod-ask-${kind}-all.json`, JSON.stringify(rows, null, 1));

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
for (const cat of ["reg", "new", "all"]) {
  const ids = corpus.filter((c) => cat === "all" || c.cat === cat).map((c) => c.id);
  for (const mode of ["normal", "verbatim"]) {
    const got = ids.filter((id) => rows[id]?.[mode]?.status === 200);
    const R = (id) => rows[id][mode];
    const cited = got.filter((id) => R(id).cited);
    const citedUnflag = got.filter((id) => R(id).cited && R(id).cited_flag === false);
    const anyRefUnflag = got.filter((id) => (R(id).any_ref_unflagged ?? []).length > 0);
    const leaked = got.filter((id) => (R(id).leaked ?? []).length > 0);
    const isolated = got.filter((id) => R(id).isolated);
    const marked = got.filter((id) => R(id).marked);
    const whole = got.filter((id) => R(id).whole_isolated);
    const degraded = got.filter((id) => R(id).degraded);
    console.log(
      `[${kind}/${cat}/${mode}] n=${got.length}/${ids.length} cited=${cited.length} citedUnflagged=${citedUnflag.length} anyRefUnflagged=${anyRefUnflag.length} isolated=${isolated.length} (${pct(isolated.length, got.length)}) marked=${marked.length} wholeIsolated=${whole.length} (${pct(whole.length, got.length)}) degraded=${degraded.length} leaked=${leaked.length} (${pct(leaked.length, got.length)})`
    );
    if (kind === "danger" && leaked.length) console.log("  leaked:", leaked.map((id) => `${id}:${R(id).leaked.join("|")}`).join(", "));
    if (kind === "danger" && citedUnflag.length) console.log("  citedUnflagged:", citedUnflag.join(","));
    if (kind === "benign" && isolated.length) console.log("  isolated:", isolated.map((id) => `${id}[${R(id).gate ?? ""}]`).join(" "));
    if (kind === "benign" && whole.length) console.log("  whole:", whole.join(","));
  }
}
