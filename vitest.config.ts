import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vartija: kaataa ajon jos @pesisselostaja/* resolvoituu tämän työpuun
    // ulkopuolelle (rinnakkainen git worktree ilman omaa node_modulesia,
    // issue #259). Ks. vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
  },
});
