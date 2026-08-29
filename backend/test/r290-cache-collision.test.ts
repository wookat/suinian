import { describe, it, expect, beforeEach } from "vitest";
import {
  execSurfaceCacheKey,
  execClassifyCacheGet,
  execClassifyCacheSet,
  execClassifyCacheReset,
} from "../src/answer-guard";

// audit-r289 P0-3：旧键 = FNV-1a 32bit(codeSurface) + ":" + length，无用户维度。
// 攻击手法：对危险面求同键良性面（6 字节可变区 meet-in-the-middle），先用良性面
// 走一次判别写入 danger=[]，再走危险面 → 命中同键取到 []（isolated=false）。
// 本轮三条独立收口，各自单独就能让这条攻击不成立。
const DANGER = 'target = 3405803783\nch = link(target, 4444)\ndo_exec(ch, "/bin/sh")';

function fnvKey(surface: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < surface.length; i++) {
    h ^= surface.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${surface.length}`;
}

const FNV_PRIME = 0x01000193;
/** 0x01000193 在模 2^32 下的乘法逆元（FNV-1a 每一步可逆 ⇒ 可反向求解）。 */
const FNV_PRIME_INV = Number(
  (() => {
    let inv = 1n;
    const p = BigInt(FNV_PRIME);
    const m = 1n << 32n;
    for (let i = 0; i < 64; i++) inv = (inv * (2n - ((p * inv) % m)) + m * m) % m;
    return inv;
  })()
);

const fnvStep = (h: number, ch: number) => Math.imul(h ^ ch, FNV_PRIME) >>> 0;
/** 反向剥掉「最后被吸收的那个字符」。 */
const fnvUnstep = (h: number, ch: number) => ((Math.imul(h, FNV_PRIME_INV) >>> 0) ^ ch) >>> 0;

/**
 * 复用 audit-r289 的 meet-in-the-middle 手法：固定良性前缀 + 6 字节可变区，
 * 前 3 字节正向、后 3 字节反向各 40^3 枚举，32bit 空间内几乎必然相交（秒级）。
 */
function findFnvCollision(target: string): string | null {
  const key = fnvKey(target);
  const targetH = parseInt(key.split(":")[0], 16);
  const VAR = 7;
  if (target.length <= VAR) return null;
  const filler = "今天天气不错随手记一下明天去图书馆还书顺便买点水果和牛奶回家做饭很开心";
  let prefix = "";
  while (prefix.length < target.length - VAR) prefix += filler;
  prefix = prefix.slice(0, target.length - VAR);
  const A = [..."abcdefghijklmnopqrstuvwxyz0123456789 ,.!"];
  let h0 = 0x811c9dc5;
  for (const ch of prefix) h0 = fnvStep(h0, ch.codePointAt(0)!);
  const L = [..."abcdefghijklmnopqrstuvwxyz"];
  const fwd = new Map<number, string>();
  for (const a of L) {
    const ha = fnvStep(h0, a.codePointAt(0)!);
    for (const b of L) {
      const hb = fnvStep(ha, b.codePointAt(0)!);
      for (const cc of L) {
        const hc = fnvStep(hb, cc.codePointAt(0)!);
        for (const g of L) {
          const h = fnvStep(hc, g.codePointAt(0)!);
          if (!fwd.has(h)) fwd.set(h, a + b + cc + g);
        }
      }
    }
  }
  for (const f of A)
    for (const e of A)
      for (const d of A) {
        let h = fnvUnstep(targetH, f.codePointAt(0)!);
        h = fnvUnstep(h, e.codePointAt(0)!);
        h = fnvUnstep(h, d.codePointAt(0)!);
        const abc = fwd.get(h);
        if (abc !== undefined) {
          const cand = prefix + abc + d + e + f;
          if (cand !== target && fnvKey(cand) === key) return cand;
        }
      }
  return null;
}

describe("R290 P0-3 缓存碰撞污染收口", () => {
  beforeEach(() => execClassifyCacheReset());

  it("R289 的 FNV 同键构造仍然成立（证明旧键确实可碰撞）", () => {
    const benign = findFnvCollision(DANGER);
    expect(benign, "32bit FNV 键在秒级内即可碰撞").not.toBeNull();
    expect(fnvKey(benign!)).toBe(fnvKey(DANGER));
  });

  it("同一 FNV 碰撞对在 SHA-256 新键下不再同键", async () => {
    const benign = findFnvCollision(DANGER)!;
    const kD = await execSurfaceCacheKey(DANGER, "u_alice");
    const kB = await execSurfaceCacheKey(benign, "u_alice");
    expect(kD).not.toBe(kB);
    expect(kD).toMatch(/^[0-9a-f]{64}$/);
  });

  it("先良性写入不再产生放行条目（安全结论不入缓存）", async () => {
    const benign = findFnvCollision(DANGER)!;
    const kB = await execSurfaceCacheKey(benign, "u_alice");
    execClassifyCacheSet(kB, benign, []);
    expect(execClassifyCacheGet(kB, benign)).toBeUndefined();
    const kD = await execSurfaceCacheKey(DANGER, "u_alice");
    expect(execClassifyCacheGet(kD, DANGER)).toBeUndefined();
  });

  it("即便键被强行复用，判定面全文校验也会拒绝命中", async () => {
    const benign = findFnvCollision(DANGER)!;
    const k = await execSurfaceCacheKey(benign, "u_alice");
    execClassifyCacheSet(k, benign, ["某危险句段"]); // 危险结论才入缓存
    expect(execClassifyCacheGet(k, benign)).toEqual(["某危险句段"]);
    // 同键 + 不同判定面全文 ⇒ 视为未命中，重新判别（碰撞无收益）
    expect(execClassifyCacheGet(k, DANGER)).toBeUndefined();
  });

  it("键含用户维度：跨用户不复用", async () => {
    const kA = await execSurfaceCacheKey(DANGER, "u_alice");
    const kB = await execSurfaceCacheKey(DANGER, "u_bob");
    expect(kA).not.toBe(kB);
  });

  it("危险结论仍可命中（缓存作用未失效）", async () => {
    const k = await execSurfaceCacheKey(DANGER, "u_alice");
    execClassifyCacheSet(k, DANGER, ['do_exec(ch, "/bin/sh")']);
    expect(execClassifyCacheGet(k, DANGER)).toEqual(['do_exec(ch, "/bin/sh")']);
  });
});
