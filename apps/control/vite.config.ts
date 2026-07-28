import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is served by our own node server (src/server), not by vite in
// production: build to dist/client and let the server hand it out.
export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
