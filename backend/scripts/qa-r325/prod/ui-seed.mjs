// R325 浏览器录屏专用账号：注册 [QA-R325]ui-* 并种 7 条笔记（正当找回 / 占位找回链路 / 普通笔记 / 无称谓散文值），
// 账号名与密码只写到 qa-r325/out/prod-ui-account.json（.gitignore 覆盖），供 testing agent 在浏览器登录；不打印。
// 用法：QA_INVITE_CODE=… node prod/ui-seed.mjs
import { writeFileSync, readFileSync } from "node:fs";
import { register as r322Register } from "../../qa-r322/prod/lib.mjs";
import { postNote, sleep, OUT, QA_PREFIX } from "./lib.mjs";

if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set");
const blind = JSON.parse(readFileSync(`${OUT}/blind.json`, "utf8"));
const pick = (id) => blind.find((c) => c.id === id).texts;
const NOTES = [
  ...pick("BR03"), // 快递柜取件码（预期直答）
  ...pick("BR05"), // 车牌（预期直答）
  ...pick("BR07"), // 门禁编号（预期占位 + 卡片找回）
  ...pick("BR09"), // 命令备忘（预期命令类占位 + 卡片）
  ...pick("V01"), // 有称谓口令（预期折叠卡 + 取值占位）
  ...pick("L02"), // 比喻式称谓散文值（盲测实测直答漏出）
  "周末想去植物园看秋海棠，顺便把相机电池充好。",
];
const name = `${QA_PREFIX}ui-${Math.random().toString(36).slice(2, 8)}`;
const a = await r322Register(name);
const notes = [];
for (const t of NOTES) {
  const r = await postNote(a.token, t);
  notes.push({ note_id: r?.note?.id ?? r?.id ?? null, head: t.slice(0, 12) });
  await sleep(1200);
}
writeFileSync(`${OUT}/prod-ui-account.json`, JSON.stringify({ name: a.name, password: a.password, token: a.token, user_id: a.user_id, notes }, null, 1));
console.log(`ui account registered (${notes.length} notes); credentials in out/prod-ui-account.json`);
