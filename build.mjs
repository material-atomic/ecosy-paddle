/* src is one file — see the note at the top of src/index.ts — so dist is too.
   The SDK stays an import: it is a peer, and the app's copy is the one used. */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

await esbuild.build({
  entryPoints: globSync("src/**/*.ts"),
  outdir: "dist",
  outbase: "src",
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: false,
  logLevel: "info",
});

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { stdio: "inherit" });
console.log("dist ready");
