// 复现 faithful30 「座位号是多少？」召回失败：同一账号问 3 次，打印 refs/答案。
import { register, postNote, req, sleep, ask, QA_PREFIX } from "./lib.mjs";
const acct = await register(`${QA_PREFIX}seat${Date.now().toString(36).slice(-4)}`);
console.log("registered", acct.name);
try {
  const r = await postNote(acct.token, "高铁票：G1024 次，8 月 30 日 10:05 发车，13 车 7A。");
  console.log("note", r.note?.id, "fold", r.note?.fold, r.note?.fold_reason);
  await sleep(60_000);
  for (const q of ["座位号是多少？", "座位号是多少？", "高铁座位是几号？", "座位号是多少？"]) {
    const a = await ask(acct.token, q);
    const j = a.json ?? {};
    console.log(`Q ${q} status ${a.status} tier=${j.trust_tier} closed=${j.verbatim_closed_spans} refs=${(j.notes ?? j.references ?? []).length} A ${JSON.stringify(j.answer)}`);
    await sleep(4200);
  }
} finally {
  const d = await req("/api/auth/me", { method: "DELETE", token: acct.token });
  const c = await req("/api/auth/me", { token: acct.token });
  console.log("deleted", d.status, "old token", c.status);
}
