// 为无法取回口令的 QA 账号生成恢复码 + 哈希（哈希写 D1，恢复码只留在环境变量，不落盘）
import { hashPassword, generateRecoveryCode, normalizeRecoveryCode } from "../src/auth.ts";
const code = generateRecoveryCode();
const hash = await hashPassword(normalizeRecoveryCode(code)!);
console.log(JSON.stringify({ code, hash }));
