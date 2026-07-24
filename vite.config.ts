import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// data/tiles holds ~190k real WebP tile files for local dev (41 orthos).
// It must never be exposed as a symlink under public/: both vite's own
// chokidar watcher and vercel dev's separate project-wide chokidar watcher
// will recurse into a symlinked directory that large and exhaust the OS
// file descriptor table (EMFILE/ENFILE), crashing the dev server. Serving
// it through a small middleware instead means neither watcher ever sees
// the files — data/ stays untouched on disk and is already gitignored.
function serveRealTiles(): Plugin {
  const root = path.join(dirname, "data/tiles");
  return {
    name: "serve-real-tiles",
    configureServer(server) {
      server.middlewares.use("/tiles-real", (req, res, next) => {
        const urlPath = decodeURIComponent((req.url ?? "").split("?")[0]);
        const filePath = path.join(root, urlPath);
        if (!filePath.startsWith(root)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
            next();
            return;
          }
          res.setHeader("Content-Type", "image/webp");
          fs.createReadStream(filePath).pipe(res);
        });
      });
    },
  };
}

// Plain web app (no Tauri). Vercel builds `npm run build`; `npm run dev` serves
// localhost with hot reload. In cloud mode the /api functions don't run under
// vite — start `vercel dev --listen 3999` alongside and this proxy forwards to
// it, so the usual :5174 dev URL works end to end.
export default defineConfig({
  plugins: [react(), serveRealTiles()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3999",
    },
    watch: {
      ignored: ["**/public/tiles/**", "**/data/**"],
    },
  },
});
