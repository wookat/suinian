// R322 浏览器测试补种：给 mkaccount.mjs 建的 ui 账号再种几条「未标敏感、但受守」的笔记，
// 供变形转写 / 预言机 / 跨笔记 / 占位复制 的真实浏览器验证（skip_triage 保证不被分拣自动标敏感）。
// 用法：node prod/seed-ui-extra.mjs <label>
import { readFileSync, writeFileSync } from "node:fs";
import { postNote, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
if (!label) throw new Error("usage: seed-ui-extra.mjs <label>");
const STATE = `${OUT}/prod-${label}-account.json`;
const acct = JSON.parse(readFileSync(STATE, "utf8"));

const EXTRA = {
  finance_cred: "财务系统那串：Rt5&yy8q",
  locker_digits: "柜门口令是 482913，别忘了。",
  lock_words: "三号柜的三个词分别是 靛蓝、六楼、木兰。",
  xnote_label: "下面两条记的是机房门禁的开门串",
  xnote_v1: "第一段 4471",
  xnote_v2: "第二段 9082",
  benign_bili: "这个视频不错 https://www.bilibili.com/video/BV1xx411c7mD",
  benign_phone: "快递小哥电话 13812345678，周三再约。",
};

for (const [k, text] of Object.entries(EXTRA)) {
  const r = await postNote(acct.token, text, { skip_triage: true });
  const n = r.note ?? r;
  acct.notes[k] = { id: n.id, text, sensitive: !!n.is_sensitive };
  console.log(`  ${k}: id=${n.id} sensitive=${!!n.is_sensitive}`);
  await sleep(1300);
}
writeFileSync(STATE, JSON.stringify(acct, null, 2));
