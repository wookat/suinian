// vitest runs on node; the tsconfig only loads workers-types, so declare the
// minimal fs/path surface tests need instead of pulling in @types/node.
declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function readFileSync(path: string): Uint8Array;
  export function statSync(path: string): { isDirectory(): boolean };
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}
interface ImportMeta {
  url: string;
}
