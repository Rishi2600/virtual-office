import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API and the game server share an origin in production. In dev we proxy
// /api and /auth to the Node server so the session cookie stays first-party and
// the Google OAuth redirect works without CORS.
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
  build: { outDir: "dist", sourcemap: true },
});
