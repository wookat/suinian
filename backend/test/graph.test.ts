import { describe, it, expect } from "vitest";
import { parseExtraction, RELATION_LABEL } from "../src/graph";

describe("parseExtraction", () => {
  it("parses a well-formed extraction with entities and relations", () => {
    const out = parseExtraction(
      JSON.stringify({
        entities: [
          { name: "碎念", type: "product", aliases: ["Suinian"] },
          { name: "老王", type: "person" },
        ],
        relations: [{ src: "老王", dst: "碎念", relation: "belongs_to", confidence: 0.9 }],
      })
    );
    expect(out).not.toBeNull();
    expect(out!.entities).toHaveLength(2);
    expect(out!.entities[0]).toEqual({ name: "碎念", type: "product", aliases: ["Suinian"] });
    expect(out!.relations).toHaveLength(1);
    expect(out!.relations[0].relation).toBe("belongs_to");
    expect(out!.relations[0].confidence).toBe(0.9);
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const out = parseExtraction('好的，结果如下：\n{"entities":[{"name":"AB 测试","type":"concept"}],"relations":[]}');
    expect(out).not.toBeNull();
    expect(out!.entities).toHaveLength(1);
    expect(out!.entities[0].type).toBe("concept");
  });

  it("drops invalid entities, unknown relations and self-loops", () => {
    const out = parseExtraction(
      JSON.stringify({
        entities: [
          { name: "", type: "person" },
          { name: "x".repeat(100), type: "person" },
          { name: "有效实体", type: "not-a-type" },
        ],
        relations: [
          { src: "有效实体", dst: "有效实体", relation: "supports" },
          { src: "有效实体", dst: "别的", relation: "unknown_rel" },
          { src: "有效实体", dst: "别的", relation: "supports", confidence: 5 },
        ],
      })
    );
    expect(out).not.toBeNull();
    expect(out!.entities).toHaveLength(1);
    expect(out!.entities[0].type).toBe("other"); // unknown type coerced
    expect(out!.relations).toHaveLength(1);
    expect(out!.relations[0].confidence).toBe(0.5); // out-of-range confidence defaulted
  });

  it("caps entities at 6 and relations at 4", () => {
    const entities = Array.from({ length: 10 }, (_, i) => ({ name: `E${i}`, type: "concept" }));
    const relations = Array.from({ length: 8 }, (_, i) => ({
      src: `E${i}`,
      dst: `E${i + 1}`,
      relation: "relates_to",
    }));
    const out = parseExtraction(JSON.stringify({ entities, relations }));
    expect(out!.entities).toHaveLength(6);
    expect(out!.relations).toHaveLength(4);
  });

  it("returns null for non-JSON output", () => {
    expect(parseExtraction("抽不出来")).toBeNull();
  });

  it("labels every relation in Chinese", () => {
    for (const r of ["supports", "premise_of", "belongs_to", "todo_of", "relates_to", "mentions"]) {
      expect(RELATION_LABEL[r]).toBeTruthy();
    }
  });
});
