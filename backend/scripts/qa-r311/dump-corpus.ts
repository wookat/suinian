// R311 生产语料 = R307 145 + R309 70 危险 + R311 新造 44；善意 = R307 243 + R309 64 + R311 新造 42。
// 用法（backend/）：npx tsx scripts/qa-r311/dump-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS } from "../qa-r309/carriers";
import { BENIGN } from "../qa-r309/benign";
import { NEW311, BENIGN311 } from "./new-carriers.mjs";
const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
// id 冲突（R307 危险语料已有 N01–N05）：R311 同名条目加后缀 b，避免生产入库时被 skip。
const uniq = (base: Array<{ id: string }>, add: Array<{ id: string }>, cat: string) =>
  add.map((c) => ({ ...c, id: base.some((b) => b.id === c.id) ? `${c.id}b` : c.id, cat }));
const carriers = [...CARRIERS, ...uniq(CARRIERS, NEW311, "r311")];
const benign = [...BENIGN, ...uniq(BENIGN, BENIGN311, "r311")];
writeFileSync(`${OUT}/carriers.json`, JSON.stringify(carriers, null, 1));
writeFileSync(`${OUT}/benign.json`, JSON.stringify(benign, null, 1));
console.log(`carriers=${carriers.length} benign=${benign.length}`);
