import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const AUTH_TYPES = new Set(["chatgpt", "env"]);

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

// Validate one provider entry and produce the runtime shape used by the server:
// match.models becomes a Set, match.prefixes stays an array, transforms keep order.
function normalizeProvider(entry, index, allowHttpLoopback) {
  const field = `providers[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${field} must be an object`);
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) throw new Error(`${field}.id must be a non-empty string`);

  const baseUrl = httpsBaseUrl(entry.baseUrl, `${field}.baseUrl`, allowHttpLoopback);

  const auth = entry.auth && typeof entry.auth === "object" ? entry.auth : {};
  if (!AUTH_TYPES.has(auth.type)) {
    throw new Error(`${field}.auth.type must be one of ${[...AUTH_TYPES].join(", ")}`);
  }
  if (auth.type === "env" && typeof auth.envVar !== "string") {
    throw new Error(`${field}.auth.envVar is required when auth.type is "env"`);
  }

  const match = entry.match && typeof entry.match === "object" ? entry.match : {};
  const models = Array.isArray(match.models) ? match.models.filter((m) => typeof m === "string" && m) : [];
  const prefixes = Array.isArray(match.prefixes)
    ? match.prefixes.filter((p) => typeof p === "string" && p)
    : [];
  if (models.length === 0 && prefixes.length === 0) {
    throw new Error(`${field}.match needs a non-empty "models" or "prefixes" array`);
  }

  const transforms = Array.isArray(entry.transforms)
    ? entry.transforms.filter((t) => typeof t === "string" && t)
    : [];

  return {
    id,
    baseUrl,
    auth: { type: auth.type, envVar: auth.envVar },
    match: { models: new Set(models), prefixes },
    transforms,
    retryOnPromptCacheError: entry.retryOnPromptCacheError === true,
  };
}

export async function loadConfig(configPath = process.env.ROUTER_CONFIG) {
  const defaultPath = fileURLToPath(new URL("../config/router.config.json", import.meta.url));
  const resolvedPath = resolve(configPath || defaultPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));

  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    throw new Error("host must be 127.0.0.1 or ::1; external binding is refused");
  }
  if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
    throw new Error("providers must be a non-empty array");
  }
  const allowHttpLoopback = process.env.NODE_ENV === "test";
  const providers = parsed.providers.map((entry, index) =>
    normalizeProvider(entry, index, allowHttpLoopback),
  );
  const ids = new Set(providers.map((provider) => provider.id));
  if (ids.size !== providers.length) {
    throw new Error("provider ids must be unique");
  }

  return Object.freeze({
    host: parsed.host,
    port: positiveInteger(parsed.port, "port"),
    maxBodyBytes: positiveInteger(parsed.maxBodyBytes, "maxBodyBytes"),
    requestTimeoutMs: positiveInteger(parsed.requestTimeoutMs, "requestTimeoutMs"),
    providers,
  });
}
