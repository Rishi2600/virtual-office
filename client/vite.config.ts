import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API and the game server share an origin in production. In dev we proxy
// /api and /auth to the Node server so the session cookie stays first-party and
// the OAuth redirects (Microsoft, GitHub) work without CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:2567", changeOrigin: true },
      "/auth": { target: "http://localhost:2567", changeOrigin: true },
    },
  },
  // @vo/shared is a linked workspace package; let Vite process its source
  // rather than trying to pre-bundle it.
  optimizeDeps: { exclude: ["@vo/shared"] },
  // "hidden": maps are written for local debugging, but the bundle doesn't
  // point at them, and the Docker image deletes them so they're never served.
  build: { outDir: "dist", sourcemap: "hidden" },
});
