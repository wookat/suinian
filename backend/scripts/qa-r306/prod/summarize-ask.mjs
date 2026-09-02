import fs from "node:fs";
const dir = new URL("../out/", import.meta.url);
for (const f of ["prod-ask-danger.json", "prod-ask-benign.json"]) {
  let j;
  try { j = JSON.parse(fs.readFileSync(new URL(f, dir), "utf8")); } catch { console.log(f, "missing"); continue; }
  const rows = [];
  for (const [id, modes] of Object.entries(j)) for (const [mode, r] of Object.entries(modes)) rows.push({ id, mode, ...r });
  const by = (mode) => rows.filter((r) => r.mode === mode);
  for (const mode of ["normal", "verbatim"]) {
    const rs = by(mode);
    const iso = rs.filter((r) => r.isolated);
    const leak = rs.filter((r) => r.leak || (r.leaks && r.leaks.length > 0));
    const non200 = rs.filter((r) => r.status !== 200);
    console.log(`${f} ${mode}: n=${rs.length} isolated=${iso.length} (${rs.length ? ((100 * iso.length) / rs.length).toFixed(1) : "-"}%) leak=${leak.length} non200=${non200.length}`);
    if (f.includes("benign") && iso.length) console.log("  isolated:", iso.map((r) => `${r.id}${r.gate ? `[${r.gate}]` : ""}`).join(" "));
    if (f.includes("danger") && (leak.length || rs.some((r) => !r.isolated))) console.log("  not-isolated:", rs.filter((r) => !r.isolated).map((r) => r.id).join(" "), "leak:", leak.map((r) => r.id).join(" "));
  }
}
