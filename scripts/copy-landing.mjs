/* Copies the static landing page into the dist root after `vite build`
   (the app itself builds into dist/draftday). */
import { cpSync } from "node:fs";

cpSync("landing", "dist", { recursive: true });
console.log("landing/ copied to dist/");
