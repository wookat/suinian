// vitest runs on node; the tsconfig only loads workers-types, so declare the
// minimal fs/path surface tests need instead of pulling in @types/node.
declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
interface ImportMeta {
  url: string;
}
