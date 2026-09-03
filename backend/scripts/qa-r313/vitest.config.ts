import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.probe.ts"], testTimeout: 300_000 } });
