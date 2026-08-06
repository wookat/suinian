import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../src/cursor";

describe("cursor", () => {
  it("round-trips", () => {
    const cur = encodeCursor("2026-08-06 01:00:00", "abc-123");
    expect(decodeCursor(cur)).toEqual({ createdAt: "2026-08-06 01:00:00", id: "abc-123" });
  });

  it("handles ids containing pipes via lastIndexOf", () => {
    const cur = encodeCursor("2026-01-01 00:00:00", "id");
    expect(decodeCursor(cur)?.id).toBe("id");
  });

  it("rejects invalid base64", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
  });

  it("rejects malformed payload", () => {
    expect(decodeCursor(btoa("no-separator"))).toBeNull();
  });
});
