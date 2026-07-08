import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

/* Site layout: a static landing page (landing/) at "/" and the Draft Day
   app under "/draftday/". In production, Cloudflare Pages serves the repo's
   functions/draftday/api/rankings.js at /draftday/api/rankings and the
   landing page is copied to the dist root by scripts/copy-landing.mjs.
   Vite's dev server knows about neither, so both are wired up here. */
function pagesDevShim() {
  return {
    name: "pages-dev-shim",
    configureServer(server) {
      server.middlewares.use("/draftday/api/rankings", async (req, res) => {
        try {
          const { onRequestGet } = await import(
            "./functions/draftday/api/rankings.js"
          );
          const url = new URL(req.url, "http://localhost");
          const request = new Request(
            `http://localhost/draftday/api/rankings${url.search}`
          );
          const response = await onRequestGet({ request });
          res.statusCode = response.status;
          for (const [key, value] of response.headers) res.setHeader(key, value);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(err && err.message) }));
        }
      });
      server.middlewares.use((req, res, next) => {
        const path = req.url.split("?")[0];
        if (path === "/" || path === "/index.html") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(readFileSync("landing/index.html"));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: "/draftday/",
  plugins: [react(), pagesDevShim()],
  build: { outDir: "dist/draftday" },
});
