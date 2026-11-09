// 데모 사이트가 그대로 가져다 쓰는 파일 하나(dist/actveri.js)와 타입을 만듦
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
await build({
  entryPoints: ["src/browser.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  outfile: "dist/actveri.js",
  logLevel: "warning",
});
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
writeFileSync("dist/actveri.d.ts", 'export * from "./types/browser.js";\n');
console.log("dist/actveri.js, dist/actveri.d.ts");
