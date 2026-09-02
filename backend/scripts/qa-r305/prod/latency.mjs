// notes.list / search 延迟（危险账号 113 条 vs 善意账号 185 条）
import { readFileSync, writeFileSync } from "node:fs";
import { req, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const res = {};
for (const kind of ["danger", "benign"]) {
  const a = JSON.parse(readFileSync(`${OUT}/prod-${kind}-account.json`, "utf8"));
  for (const [name, path] of [["list100", "/api/notes?limit=100"], ["list20", "/api/notes?limit=20"], ["search", `/api/notes?q=${encodeURIComponent("脚本")}&limit=50`], ["search2", `/api/notes?q=${encodeURIComponent("会议")}&limit=50`]]) {
    const ts = [];
    let flagged = 0, n = 0;
    for (let i = 0; i < 12; i++) {
      const t0 = Date.now();
      const r = await req(path, { token: a.token });
      ts.push(Date.now() - t0);
      if (i === 0) { n = r.json?.notes?.length ?? 0; flagged = (r.json?.notes ?? []).filter((x) => x.contains_executable_command === true).length; }
      await sleep(300);
    }
    res[`${kind}/${name}`] = { n, flagged, p50: pct(ts, 0.5), p90: pct(ts, 0.9), max: Math.max(...ts) };
    console.log(kind, name, JSON.stringify(res[`${kind}/${name}`]));
  }
}
writeFileSync(`${OUT}/prod-latency.json`, JSON.stringify(res, null, 1));
