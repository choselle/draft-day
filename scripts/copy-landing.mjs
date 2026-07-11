/* Build for the landing-page Pages project (chibzapps.com): copies the
   static landing/ directory (index.html, _redirects) to dist-landing/.
   The app itself builds separately with `vite build` into dist/. */
import { rmSync, cpSync } from "node:fs";

rmSync("dist-landing", { recursive: true, force: true });
cpSync("landing", "dist-landing", { recursive: true });
console.log("landing/ copied to dist-landing/");
