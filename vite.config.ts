import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain web app (no Tauri). Vercel builds `npm run build`; `npm run dev` serves
// localhost with hot reload.
export default defineConfig({
  plugins: [react()],
});
