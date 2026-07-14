/** Platform-agnostic pesäpallo domain logic. No localStorage, no fs, no DOM —
 *  persistence lives behind ports implemented by each app (web, broadcast). */
export const CORE_PACKAGE_NAME = "@pesisselostaja/core";

export * from "./types.js";
export * from "./api.js";
