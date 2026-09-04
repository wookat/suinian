// R317 生产 QA 公共库：复用 R314/R313 的请求/注册/入库/MCP/ask/SSE 封装，只改账号前缀。
export * from "../../qa-r314/prod/lib.mjs";
export const QA_PREFIX = "[QA-R317]";
