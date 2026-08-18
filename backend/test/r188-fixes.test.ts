// R188（audit-r187）：
// P1-1 图片凭证链路断裂——视觉抽取三段式输出（文字/描述/敏感），凭证值不再
//      静默丢弃：敏感判定与文本管道同源（视觉判定 ∪ detectSensitive），
//      vision_sensitive 粘性防止只看文本的复判解除敏感位；
// P2-1 小票金额双计——表格合计行 / 多对象输出总额检测 / 散文合计 2T 兜底。
import { describe, it, expect } from "vitest";
import { parseImageExtraction, imageNoteFields, buildMediaReply, IMAGE_CREDENTIAL_GAP_NOTICE } from "../src/media";
import { parseLedgerCore, parseLedgerTable, parseTriageJson, fixReceiptDoubleCount, fixLedgerAmount, detectSensitive } from "../src/triage";
import { applyTriage } from "../src/note-store";
import { CREDENTIAL_Q_RE, credentialHintLine } from "../src/ask";
import { decryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import type { TriageResult } from "../src/types";

// ---- P1-1: 视觉抽取敏感口径 ----

describe("parseImageExtraction 三段式敏感解析 (R188 P1-1)", () => {
  it("凭证值在文字段中：内容保留原值，敏感=true", () => {
    const r = parseImageExtraction("文字：SSID：HomeNet\n密码：fam2026wifi\n描述：路由器背面标签。\n敏感：是");
    expect(r.content).toContain("fam2026wifi");
    expect(r.sensitive).toBe(true);
  });

  it("视觉判敏感但文字段无凭证值：正文如实标注值未提取", () => {
    const r = parseImageExtraction("文字：SSID：HomeNet\n描述：显示了一个Wi-Fi网络的SSID和密码。\n敏感：是");
    expect(r.sensitive).toBe(true);
    expect(r.content).toContain(IMAGE_CREDENTIAL_GAP_NOTICE);
  });

  it("视觉漏判但正文命中 detectSensitive：敏感仍为 true（与文本管道同源）", () => {
    const r = parseImageExtraction("文字：服务器 root 密码是 P@ssw0rd123\n描述：一张便签。\n敏感：否");
    expect(detectSensitive("服务器 root 密码是 P@ssw0rd123")).toBe(true);
    expect(r.sensitive).toBe(true);
    expect(r.content).not.toContain(IMAGE_CREDENTIAL_GAP_NOTICE);
  });

  it("普通图片：敏感=false，行为与旧两段式一致", () => {
    const r = parseImageExtraction("文字：会议纪要 8月7日\n描述：一张白板照片。\n敏感：否");
    expect(r.content).toBe("会议纪要 8月7日");
    expect(r.description).toBe("一张白板照片。");
    expect(r.sensitive).toBe(false);
  });

  it("旧两段式输出（无敏感段）向后兼容", () => {
    const r = parseImageExtraction("文字：购物清单：牛奶、鸡蛋\n描述：手写便条。");
    expect(r.content).toBe("购物清单：牛奶、鸡蛋");
    expect(r.sensitive).toBe(false);
  });

  it("无文字图片走描述兜底，敏感段照常解析", () => {
    const r = parseImageExtraction("文字：无\n描述：一只橘猫趴在沙发上。\n敏感：否");
    expect(r.content).toBe("一只橘猫趴在沙发上。");
    expect(r.sensitive).toBe(false);
  });

  it("敏感段带占位括号（<是>）也能解析", () => {
    const r = parseImageExtraction("文字：门禁密码 8642\n描述：门禁键盘照片。\n敏感：<是>");
    expect(r.sensitive).toBe(true);
  });
});

describe("imageNoteFields 映射 (R188 P1-1)", () => {
  it("敏感抽取 → is_sensitive 提示 + vision_sensitive 粘性标记", () => {
    const f = imageNoteFields({ content: "密码：fam2026wifi", description: "路由器标签", sensitive: true });
    expect(f.is_sensitive).toBe(true);
    expect(f.meta?.vision_sensitive).toBe(true);
    expect(f.meta?.image_description).toBe("路由器标签");
  });

  it("非敏感抽取 → 不带 vision_sensitive，不误标", () => {
    const f = imageNoteFields({ content: "会议纪要", description: "白板照片", sensitive: false });
    expect(f.is_sensitive).toBe(false);
    expect(f.meta?.vision_sensitive).toBeUndefined();
  });

  it("描述与正文相同则不重复进 meta", () => {
    const f = imageNoteFields({ content: "一张风景照", description: "一张风景照", sensitive: false });
    expect(f.meta).toBeNull();
  });
});

describe("buildMediaReply 敏感不回显 (R188 P1-1)", () => {
  it("敏感笔记回执不含内容片段", () => {
    const reply = buildMediaReply("image", "密码：fam2026wifi", true, true);
    expect(reply).not.toContain("fam2026wifi");
    expect(reply).toContain("已加密");
  });

  it("普通笔记回执保留内容预览", () => {
    expect(buildMediaReply("image", "会议纪要", true, false)).toContain("会议纪要");
  });
});

// ---- P1-1: vision_sensitive 粘性（复判不解除） ----

type Row = Record<string, unknown>;

function fakeDb(notes: Row[]) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM notes")) {
            const n = notes.find((r) => r.id === binds[0]);
            return n ? { ...n } : null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const whereIdx = sql.indexOf(" WHERE ");
            const setPart = sql.slice(0, whereIdx);
            const wherePart = sql.slice(whereIdx);
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const nullCols = [...setPart.matchAll(/(\w+) = NULL/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length);
            let targets = notes.filter((n) => n.id === whereBinds[0]);
            if (wherePart.includes("updated_at = ?"))
              targets = targets.filter((n) => n.updated_at === whereBinds[whereBinds.length - 1]);
            for (const n of targets) {
              cols.forEach((col, i) => (n[col] = binds[i]));
              nullCols.forEach((col) => (n[col] = null));
              if (/updated_at = datetime\('now'\)/.test(setPart)) n.updated_at = `bumped-${Math.random()}`;
            }
            return { meta: { changes: targets.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

describe("applyTriage vision_sensitive 粘性 (R188 P1-1)", () => {
  it("视觉判敏感 + 文本复判非敏感 → 敏感位保持并加密（原图秘密仍在附件里）", async () => {
    const content = "SSID：HomeNet\n" + IMAGE_CREDENTIAL_GAP_NOTICE;
    const notes: Row[] = [
      {
        id: "n1",
        user_id: "u1",
        content,
        content_enc: null,
        title: null,
        tags: "[]",
        category: null,
        todo_due: null,
        is_sensitive: 0,
        meta: JSON.stringify({ vision_sensitive: true, image_description: "路由器背面" }),
        updated_at: "2026-08-18 00:00:00",
      },
    ];
    const triage: TriageResult = { category: "data", tags: ["网络"], title: "家里 WiFi", is_sensitive: false, todo_due: null };
    await applyTriage({ DB: fakeDb(notes), SUINIAN_ENC_KEY: KEY }, "n1", triage, content);
    expect(notes[0].is_sensitive).toBe(1);
    expect(notes[0].content).toBe(ENC_PLACEHOLDER);
    expect(await decryptContent(KEY, String(notes[0].content_enc))).toBe(content);
    const meta = JSON.parse(String(notes[0].meta));
    expect(meta.vision_sensitive).toBe(true);
    expect(meta.image_description).toBeUndefined(); // 派生明文洗净
  });

  it("无 vision_sensitive 标记时模型判非敏感照常放行（不误伤普通图片）", async () => {
    const notes: Row[] = [
      {
        id: "n1",
        user_id: "u1",
        content: "会议纪要 8月7日",
        content_enc: null,
        title: null,
        tags: "[]",
        category: null,
        todo_due: null,
        is_sensitive: 0,
        meta: JSON.stringify({ image_description: "白板照片" }),
        updated_at: "2026-08-18 00:00:00",
      },
    ];
    const triage: TriageResult = { category: "data", tags: [], title: "会议纪要", is_sensitive: false, todo_due: null };
    await applyTriage({ DB: fakeDb(notes), SUINIAN_ENC_KEY: KEY }, "n1", triage, "会议纪要 8月7日");
    expect(notes[0].is_sensitive).toBe(0);
    expect(notes[0].content).toBe("会议纪要 8月7日");
  });
});

// ---- P1-1: 凭据类问法识别（QA 实测「WiFi 密码是多少」走零召回分支无指引） ----

describe("CREDENTIAL_Q_RE 凭据问法变体 (R188 P1-1)", () => {
  it("连字符/大小写变体均识别为凭据类问法", () => {
    for (const q of ["WiFi 密码是多少", "wifi密码是多少", "Wi-Fi 密码是多少", "助记词还记得吗", "服务器密钥在哪"]) {
      expect(CREDENTIAL_Q_RE.test(q)).toBe(true);
    }
  });

  it("凭据指引文案含原图确认口径", () => {
    expect(credentialHintLine()).toContain("原图");
  });
});

// ---- P2-1: 小票金额双计 ----

const expense = (amount: number | null): TriageResult => ({
  category: "expense",
  tags: [],
  title: null,
  is_sensitive: false,
  todo_due: null,
  amount,
  currency: amount !== null ? "CNY" : null,
});

describe("parseLedgerCore 合计行 (R188 P2-1)", () => {
  it("明细 + 合计行：金额取合计值，不叠加", () => {
    expect(parseLedgerCore("咖啡,12.5\n三明治,8.0\n蛋糕,15.8\n合计,36.3")).toEqual({ amount: 36.3, rows: 3 });
  });

  it("实付/总计等同义标签同样识别", () => {
    expect(parseLedgerCore("牛奶,18\n面包,12\n实付,30")).toEqual({ amount: 30, rows: 2 });
    expect(parseLedgerCore("键盘,199\n鼠标,99\n总计,298")).toEqual({ amount: 298, rows: 2 });
  });

  it("合计值与明细和不一致（折扣）也以合计为准", () => {
    expect(parseLedgerCore("牛奶,18\n面包,12\n实付,25")).toEqual({ amount: 25, rows: 2 });
  });

  it("无合计行的普通多行账单仍逐行求和（不回归）", () => {
    expect(parseLedgerTable("日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20")).toEqual({
      amount: 356,
      rows: 4,
    });
    expect(parseLedgerTable("买菜,55.5\n地铁,4")).toEqual({ amount: 59.5, rows: 2 });
  });

  it("多个合计行无法归一 → 歧义不猜", () => {
    expect(parseLedgerCore("咖啡,12.5\n合计,12.5\n蛋糕,15.8\n总计,28.3")).toBe("ambiguous");
  });

  it("品名含「共」字不误判为合计行", () => {
    expect(parseLedgerCore("共享单车月卡,25\n地铁,4")).toEqual({ amount: 29, rows: 2 });
  });
});

describe("parseTriageJson 多对象总额检测 (R188 P2-1)", () => {
  it("模型把合计行也当一笔输出：取总额而不是再叠加", () => {
    const text =
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":12.5,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":8,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":15.8,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":36.3,"currency":"CNY"}';
    expect(parseTriageJson(text)?.amount).toBe(36.3);
  });

  it("无总额关系的多笔输出仍求和（不回归 R170）", () => {
    const text =
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":199,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":99,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":38,"currency":"CNY"}';
    expect(parseTriageJson(text)?.amount).toBe(336);
  });

  it("两笔输出不做总额检测（a+b 场景无从判别）", () => {
    const text =
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":55.5,"currency":"CNY"}\n' +
      '{"category":"expense","tags":[],"title":null,"is_sensitive":false,"todo_due":null,"amount":4,"currency":"CNY"}';
    expect(parseTriageJson(text)?.amount).toBe(59.5);
  });
});

describe("fixReceiptDoubleCount 散文合计兜底 (R188 P2-1)", () => {
  const receipt = "超市小票：咖啡 12.5 元，三明治 8 元，蛋糕 15.8 元，合计 36.3 元";

  it("模型金额 ≈ 2×合计（明细与合计被叠加）→ 锁回合计值", () => {
    expect(fixReceiptDoubleCount(receipt, expense(72.6)).amount).toBe(36.3);
  });

  it("模型金额已是合计值 → 不动", () => {
    expect(fixReceiptDoubleCount(receipt, expense(36.3)).amount).toBe(36.3);
  });

  it("金额与 2T 不符（正常差异）→ 不动，模型主判", () => {
    expect(fixReceiptDoubleCount(receipt, expense(48.8)).amount).toBe(48.8);
    expect(fixReceiptDoubleCount("付了这个月房租 2600", expense(2600)).amount).toBe(2600);
  });

  it("无合计声明 → 不动", () => {
    expect(fixReceiptDoubleCount("咖啡 12.5 元，三明治 8 元", expense(20.5)).amount).toBe(20.5);
  });

  it("非记账类别 / 金额为空 → 不动", () => {
    const idea: TriageResult = { category: "idea", tags: [], title: null, is_sensitive: false, todo_due: null };
    expect(fixReceiptDoubleCount(receipt, idea)).toBe(idea);
    expect(fixReceiptDoubleCount(receipt, expense(null)).amount).toBeNull();
  });
});

describe("fixLedgerAmount 合计行表格 (R188 P2-1)", () => {
  it("模型双计时锁回表格合计值", () => {
    const r = fixLedgerAmount("咖啡,12.5\n三明治,8.0\n蛋糕,15.8\n合计,36.3", expense(72.6));
    expect(r.amount).toBe(36.3);
  });
});
