// R307：Web Push 出口源码级确证（生产 Push 需真实订阅端点+解密，未实测）。
// 断言：pushSnippet 对数据面检测器漏判的载体会把原文前 60 字裸推（fail-open 于检测器）。
import { describe, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { pushSnippet } from "../../../src/push";
import { CARRIERS } from "../carriers";

const OUT = new URL("../out", import.meta.url).pathname;

describe("R307 push snippet", () => {
  it("dump", () => {
    mkdirSync(OUT, { recursive: true });
    const rows = CARRIERS.map((c) => {
      const s = pushSnippet({ is_sensitive: 0, title: null, content: c.text } as never, "敏感", "记录");
      return { id: c.id, family: c.family, exec: s.exec, text: s.text };
    });
    const bare = rows.filter((r) => !r.exec);
    writeFileSync(`${OUT}/push-snippet.json`, JSON.stringify(rows, null, 1));
    console.log(`push exec-marked ${rows.length - bare.length}/${rows.length}; bare: ${bare.map((r) => r.id).join(",")}`);
    for (const r of bare) console.log(` ${r.id} -> ${JSON.stringify(r.text)}`);
  });
});
