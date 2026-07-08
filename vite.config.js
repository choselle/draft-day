import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* In production, Cloudflare Pages serves functions/api/rankings.js at
   /api/rankings. Vite's dev server doesn't know about Pages Functions,
   so run the same function here for local dev. */
function pagesFunctions() {
  return {
    name: "cloudflare-pages-functions-dev",
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
  plugins: [react(), pagesFunctions()],
});
