import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain web app (no Tauri). Vercel builds `npm run build`; `npm run dev` serves
// localhost with hot reload. In cloud mode the /api functions don't run under
// vite — start `vercel dev --listen 3999` alongside and this proxy forwards to
// it, so the usual :5174 dev URL works end to end.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3999",
    },
  },
});
