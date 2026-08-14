import { describe, it, expect } from "vitest";
import { spacifyCjk } from "../src/threads";

describe("spacifyCjk", () => {
  it("inserts spaces between CJK and Latin/digit runs", () => {
    expect(spacifyCjk("掌握了C和G和弦转换")).toBe("掌握了 C 和 G 和弦转换");
    expect(spacifyCjk("买了3本书花了68元")).toBe("买了 3 本书花了 68 元");
  });
  it("keeps already-spaced text and pure CJK/Latin unchanged", () => {
    expect(spacifyCjk("掌握了 C 和 G 和弦")).toBe("掌握了 C 和 G 和弦");
    expect(spacifyCjk("纯中文标题")).toBe("纯中文标题");
    expect(spacifyCjk("English only")).toBe("English only");
  });
  it("does not add spaces around CJK punctuation", () => {
    expect(spacifyCjk("学了React，很好用")).toBe("学了 React，很好用");
  });
});
