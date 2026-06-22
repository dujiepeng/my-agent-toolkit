import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "services/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".agents/**"],
  },
  resolve: {
    alias: {
      "@my-agent-toolkit/contracts": `${root}packages/contracts/src/index.ts`,
    },
  },
});
