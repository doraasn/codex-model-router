// 从 Codex 官方接口拉取模型目录并刷新本机 %USERPROFILE%\.codex\models_cache.json。
// 接口与客户端同源：GET https://chatgpt.com/backend-api/codex/models?client_version=<版本>，
// 用 auth.json 里的 ChatGPT 登录态鉴权；原缓存先备份到 backups\models_cache.<时间戳>.json。
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replace(/\..+$/, "").replace("T", "-");
}

const codexHome = resolve(argument("--codex-home", process.env.CODEX_HOME || join(homedir(), ".codex")));
const cachePath = join(codexHome, "models_cache.json");
const backupDirectory = resolve(
  argument("--backup-directory", fileURLToPath(new URL("../backups", import.meta.url))),
);
const authPath = join(codexHome, "auth.json");
if (!existsSync(authPath)) {
  throw new Error(`未找到 ${authPath}，请先用 ChatGPT 登录 Codex`);
}
const auth = JSON.parse(await readFile(authPath, "utf8"));
const token = auth.tokens?.access_token;
const accountId = auth.tokens?.account_id;
if (!token) {
  throw new Error(`${authPath} 中没有 ChatGPT access_token，请先用 ChatGPT 登录 Codex`);
}

// 客户端按自己的版本号请求目录，服务端据此裁剪：低于 0.153 不下发 GPT-6，0.153 只给 Astra，
// 0.155+ 才给 Astra/Sol/Luna 全套。默认取本机 codex 引擎版本，可用 --client-version 覆盖。
function localCodexVersion() {
  for (const command of ["codex", "codex.exe"]) {
    try {
      const output = execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const matched = output.match(/codex-cli\s+(\S+)/);
      if (matched) return matched[1];
    } catch {
      // 本机没有 CLI 时忽略，继续走兜底
    }
  }
  return null;
}

let clientVersion = argument("--client-version", null);
if (!clientVersion) clientVersion = localCodexVersion();
if (!clientVersion && existsSync(cachePath)) {
  clientVersion = JSON.parse(await readFile(cachePath, "utf8")).client_version;
}
clientVersion = clientVersion || "0.155.0";

const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`;
const response = await fetch(url, {
  headers: {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId || "",
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${clientVersion}`,
    accept: "application/json",
  },
});
if (!response.ok) {
  throw new Error(`官方模型目录请求失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
}
const payload = await response.json();
if (!Array.isArray(payload.models) || payload.models.length === 0) {
  throw new Error("官方模型目录响应中没有 models 数组");
}

await mkdir(backupDirectory, { recursive: true });
const backupPath = join(backupDirectory, `models_cache.${timestamp()}.json`);
if (existsSync(cachePath)) {
  await copyFile(cachePath, backupPath);
}
// 保持客户端缓存结构：fetched_at / etag / client_version / models。
await writeFile(cachePath, `${JSON.stringify({
  fetched_at: new Date().toISOString(),
  etag: response.headers.get("etag") ?? null,
  client_version: clientVersion,
  models: payload.models,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

process.stdout.write(
  `已刷新 ${cachePath}（client_version=${clientVersion}，备份 ${backupPath}）\n`
  + `共 ${payload.models.length} 个模型：${payload.models.map((model) => `${model.slug}[${model.visibility}]`).join(", ")}\n`,
);
