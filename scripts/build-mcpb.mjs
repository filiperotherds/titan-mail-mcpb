// Monta a extensão do Claude Desktop (out/titan-mail.mcpb).
// Uso: npm run build:mcpb
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const stage = "build/mcpb";
const run = (cmd, cwd = ".") => execSync(cmd, { cwd, stdio: "inherit" });

run("npx tsc");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync("out", { recursive: true });

cpSync("mcpb/manifest.json", `${stage}/manifest.json`);
cpSync("dist", `${stage}/dist`, { recursive: true });
cpSync("package.json", `${stage}/package.json`);
cpSync("package-lock.json", `${stage}/package-lock.json`);

run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);
run(`npx --yes @anthropic-ai/mcpb validate ${stage}/manifest.json`);
run(`npx --yes @anthropic-ai/mcpb pack ${stage} out/titan-mail.mcpb`);
