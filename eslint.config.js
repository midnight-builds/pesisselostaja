import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Every pattern needs `**/`: a bare "dist/" only matches the repo root, so
    // each workspace's build output was being linted. That produced 2700+
    // errors from generated bundles (onnxruntime alone accounted for 1290) and
    // buried the handful of real ones.
    ignores: [
      "**/dist/",
      "**/node_modules/",
      ".claude/worktrees/",
      ".incoming/",
    ],
  },
  {
    // React hook rules apply only to the one workspace that has React. The
    // exhaustive-deps rule is here mainly so its `eslint-disable-next-line`
    // comments mean something: without the plugin registered, a suppression
    // referencing an unknown rule is itself an error, which is what made
    // `npm run lint -w @pesisselostaja/control` fail.
    files: ["apps/control/src/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Playwright's fixture signature is `async ({}, use)` when a fixture uses
    // none of the others: the empty pattern is how you say "no dependencies",
    // not an oversight. Renaming it to `_` would change what Playwright injects.
    files: ["**/test-ui/**/*.ts"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    // Service workers run in ServiceWorkerGlobalScope, where `self` — not
    // `window` — is the global. Without this they read as undefined-variable
    // errors even though the file is correct.
    files: ["**/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", clients: "readonly", caches: "readonly" },
    },
  }
);
