import { describe, it, expect } from "vitest";
import { CORE_PACKAGE_NAME } from "../src/index.js";

// Proves the workspace build pipeline (root vitest globs, core tsconfig)
// end to end before any real modules move in; replaced by the speech tests.
describe("core workspace wiring", () => {
  it("exports from the package source", () => {
    expect(CORE_PACKAGE_NAME).toBe("@pesisselostaja/core");
  });
});
