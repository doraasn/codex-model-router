import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function httpsBaseUrl(value, field, allowHttpLoopback = false) {
  const url = new URL(value);
  const isLoopbackHttp =
    allowHttpLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error(`${field} must use HTTPS${allowHttpLoopback ? " or loopback HTTP" : ""}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must not contain credentials, a query, or a fragment`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export async function loadConfig(configPath = process.env.ROUTER_CONFIG) {
  const defaultPath = fileURLToPath(new URL("../config/router.config.json", import.meta.url));
  const resolvedPath = resolve(configPath || defaultPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));

  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    throw new Error("host must be 127.0.0.1 or ::1; external binding is refused");
  }
  if (!Array.isArray(parsed.deepseekModels) || parsed.deepseekModels.length === 0) {
    throw new Error("deepseekModels must be a non-empty array");
  }
  if (!Array.isArray(parsed.gptModelPrefixes) || parsed.gptModelPrefixes.length === 0) {
    throw new Error("gptModelPrefixes must be a non-empty array");
  }

  return Object.freeze({
    host: parsed.host,
    port: positiveInteger(parsed.port, "port"),
    maxBodyBytes: positiveInteger(parsed.maxBodyBytes, "maxBodyBytes"),
    requestTimeoutMs: positiveInteger(parsed.requestTimeoutMs, "requestTimeoutMs"),
    chatgptBaseUrl: httpsBaseUrl(
      process.env.ROUTER_CHATGPT_BASE_URL || parsed.chatgptBaseUrl,
      "chatgptBaseUrl",
      process.env.NODE_ENV === "test",
    ),
    deepseekBaseUrl: httpsBaseUrl(
      process.env.ROUTER_DEEPSEEK_BASE_URL || parsed.deepseekBaseUrl,
      "deepseekBaseUrl",
      process.env.NODE_ENV === "test",
    ),
    deepseekModels: new Set(parsed.deepseekModels),
    gptModelPrefixes: [...parsed.gptModelPrefixes],
  });
}
