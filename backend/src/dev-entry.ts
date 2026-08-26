// 本地 dev 入口：只导出 fetch handler。src/index.ts 里为单测导出的
// 字符串常量（如 ASK_KEYWORDS_SYSTEM）会被 workerd 当作命名入口拒绝，
// 生产 deploy 不受影响，仅 wrangler dev 需要这个薄包装。
export { default } from "./index";
