import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* Draft Day deploys as its own Cloudflare Pages project served at the
   domain root (draftday.chibzapps.com). The landing page (landing/) is
   a separate Pages project on chibzapps.com built via
   `npm run build:landing`. In production Cloudflare serves
   functions/api/rankings.js at /api/rankings; Vite's dev server knows
   nothing about Pages Functions, so the same function is wired up here. */
function pagesDevShim() {
  return {
    name: "pages-dev-shim",
    configureServer(server) {
      server.middlewares.use("/api/rankings", async (req, res) => {
        try {
          const { onRequestGet } = await import("./functions/api/rankings.js");
          const url = new URL(req.url, "http://localhost");
          const request = new Request(
            `http://localhost/api/rankings${url.search}`
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
    },
  };
}

export default defineConfig({
  plugins: [react(), pagesDevShim()],
});
