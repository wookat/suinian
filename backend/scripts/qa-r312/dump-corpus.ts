// R312 生产语料 = R307 145 + R309 70 + R311 44 + R312 新造 36 危险；善意 = R307 243 + R309 64 + R311 42 + R312 36。
// 用法（backend/）：npx tsx scripts/qa-r312/dump-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS } from "../qa-r309/carriers";
import { BENIGN } from "../qa-r309/benign";
// @ts-expect-error 纯 JS 语料模块
import { NEW311, BENIGN311 } from "../qa-r311/new-carriers.mjs";
import { NEW312, BENIGN312 } from "./new-carriers";
const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const uniq = (base: Array<{ id: string }>, add: Array<{ id: string }>, cat: string) =>
  add.map((c) => ({ ...c, id: base.some((b) => b.id === c.id) ? `${c.id}${cat.slice(-2)}` : c.id, cat }));
const c311 = uniq(CARRIERS, NEW311 as Array<{ id: string }>, "r311");
const carriers = [...CARRIERS, ...c311, ...uniq([...CARRIERS, ...c311], NEW312, "r312")];
const b311 = uniq(BENIGN, BENIGN311 as Array<{ id: string }>, "r311");
const benign = [...BENIGN, ...b311, ...uniq([...BENIGN, ...b311], BENIGN312, "r312")];
for (const list of [carriers, benign]) {
  const ids = new Set<string>();
  for (const c of list) {
    if (ids.has(c.id)) throw new Error(`dup id ${c.id}`);
    ids.add(c.id);
  }
}
writeFileSync(`${OUT}/carriers.json`, JSON.stringify(carriers, null, 1));
writeFileSync(`${OUT}/benign.json`, JSON.stringify(benign, null, 1));
console.log(`carriers=${carriers.length} benign=${benign.length}`);
