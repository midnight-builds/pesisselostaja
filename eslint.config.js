import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
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
    // Service workers run in ServiceWorkerGlobalScope, where `self` — not
    // `window` — is the global. Without this they read as undefined-variable
    // errors even though the file is correct.
    files: ["**/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", clients: "readonly", caches: "readonly" },
    },
  }
);
