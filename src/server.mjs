import http from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProxyAgent, Agent, fetch as undiciFetch, interceptors } from "undici";
import { loadConfig } from "./config.mjs";

// 仅 ChatGPT 路由走代理，DeepSeek 等直连
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const baseProxyAgent = proxyUrl ? new ProxyAgent({
  uri: proxyUrl,
  pipelining: 0,
  connect: { timeout: 10_000 },
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 6_000,
}) : null;
// 给代理加自动重试，解决 SNI 干扰导致的间歇性 ECONNRESET
const proxyAgent = baseProxyAgent ? baseProxyAgent.compose(
  interceptors.retry({
    maxRetries: 3,
    minTimeout: 300,
    maxTimeout: 2_000,
    errorCodes: ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'],
  }),
) : null;
if (proxyAgent) {
  process.stdout.write("Proxy available for chatgpt route: " + proxyUrl + "\n");
} else {
  process.stdout.write("No proxy configured, all routes use direct connection\n");
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "x-request-id",
  "openai-processing-ms",
  "retry-after",
]);

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("request body exceeds configured limit");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 按 provider 配置解析模型：先精确匹配 match.models（Set），再按 match.prefixes 前缀匹配。
// 新增供应商只需在 config/router.config.json 增加一个 provider 条目，无需改代码。
function resolveProvider(model, config) {
  for (const provider of config.providers) {
    if (provider.match.models?.has?.(model)) return provider;
  }
  for (const provider of config.providers) {
    if (provider.match.prefixes?.some((prefix) => model.startsWith(prefix))) return provider;
  }
  return null;
}

// 官方后端按条目类型校验 id 前缀（消息 msg_、推理 rs_、函数调用 fc_、web 搜索 ws_ 等），
// DeepSeek 生成的历史条目 id 不带这些前缀（如 web_search_call 用 call_00_...、函数调用用裸 UUID），
// 回放时会触发官方后端 400（Invalid 'input[n].id': Expected an ID that begins with 'ws'）。
const ITEM_ID_PREFIXES = {
  message: "msg_",
  reasoning: "rs_",
  function_call: "fc_",
  function_call_output: "fco_",
  custom_tool_call: "ctc_",
  custom_tool_call_output: "ctco_",
  web_search_call: "ws_",
};

// 清洗发往 ChatGPT 后端的请求体，仅挂在 chatgpt provider 上：
// 1. 把第三方历史条目的 id 确定性规范到官方要求的类型前缀（同一旧 id 每次映射一致）；
//    call_id 保持原样，function_call_output/custom_tool_call_output 的配对关系不受影响。
// 2. 官方后端要求 reasoning 条目的 content 必须为空数组，推理摘要只能走 summary 字段；
//    把 DeepSeek 放在 content（reasoning_text）里的推理文本统一挪到 summary 并清空 content。
// 3. GPT-5.6 系列使用 prompt_cache_options，不接受旧的 prompt_cache_retention；
//    递归删除该字段，兼容历史请求或扩展对象中残留的旧参数。
function sanitizeChatGptPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let changed = false;
  const pending = [payload];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Object.prototype.hasOwnProperty.call(current, "prompt_cache_retention")) {
      delete current.prompt_cache_retention;
      changed = true;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") pending.push(value);
    }
  }
  if (!Array.isArray(payload.input)) return changed;
  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue;

    const prefix = ITEM_ID_PREFIXES[item.type];
    if (prefix && typeof item.id === "string" && !item.id.startsWith(prefix)) {
      // 用旧 id 的 SHA-1 派生出确定性的 UUID 后缀，保证同一历史条目每次映射结果一致
      const hash = createHash("sha1").update(item.id).digest("hex");
      const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
      item.id = prefix + uuid;
      changed = true;
    }

    if (item.type !== "reasoning") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    if (content.length === 0) continue;
    const summary = Array.isArray(item.summary) ? item.summary : [];
    for (const part of content) {
      if (part && part.type === "reasoning_text" && typeof part.text === "string") {
        summary.push({ type: "summary_text", text: part.text });
      }
    }
    item.summary = summary;
    item.content = [];
    changed = true;
  }
  return changed;
}

const DEEPSEEK_REASONING_EFFORT_MAP = new Map([
  ["low", "low"],
  ["medium", "low"],
  ["high", "high"],
  ["xhigh", "max"],
  ["max", "max"],
]);

// DeepSeek 模型将 Codex 的中/高/极高统一映射为官方 low/high/max；
// 缺省或未知档位回退 high。GPT 不经过此变换。
function normalizeDeepSeekPayload(payload) {
  let changed = false;
  const mapEffort = (effort) => DEEPSEEK_REASONING_EFFORT_MAP.get(effort) || "high";
  if (!payload.reasoning || typeof payload.reasoning !== "object" || Array.isArray(payload.reasoning)) {
    payload.reasoning = { effort: mapEffort(payload.reasoning_effort) };
    changed = true;
  } else {
    const mappedEffort = mapEffort(payload.reasoning.effort);
    if (payload.reasoning.effort !== mappedEffort) {
      payload.reasoning.effort = mappedEffort;
      changed = true;
    }
  }
  if (payload?.reasoning_effort !== undefined) {
    const mappedLegacyEffort = mapEffort(payload.reasoning_effort);
    if (payload.reasoning_effort !== mappedLegacyEffort) {
      payload.reasoning_effort = mappedLegacyEffort;
      changed = true;
    }
  }
  // DeepSeek 官方没有服务档位概念；防御性剥离 Codex 可能带上的 service_tier。
  if (payload?.service_tier !== undefined) {
    delete payload.service_tier;
    changed = true;
  }
  if (payload?.serviceTier !== undefined) {
    delete payload.serviceTier;
    changed = true;
  }
  return changed;
}

// DeepSeek 后端对 input 条目强校验 call_id：function_call、custom_tool_call、
// function_call_output、custom_tool_call_output 都要求 call_id。Codex 的委派工具
// send_message_to_thread 结果以 function_call_output 记录时只带 id（fco_...）
// 而不带 call_id，回放到 DeepSeek 会触发
// "Failed to deserialize ... input: missing field `call_id`"。
// 处理规则：
//  1. 缺失/为空 call_id 的输出条目，优先配对到「尚未有输出」的同名调用（按出现顺序取最早一条），
//     保证 call_id 不与其他输出重复，也不产生 "Duplicate tool output"。
//  2. 若不存在可配对的未调用，则该输出是真正的孤儿（其调用不在历史里），DeepSeek 无法接受，
//     直接从 input 中移除，避免既缺 call_id 又造成重复。
//  3. 缺失 call_id 的调用条目，从条目 id 派生兜底。
function sanitizeDeepSeekCallIds(payload) {
  if (!payload || !Array.isArray(payload.input)) return false;
  let changed = false;
  const callTypes = new Set(["function_call", "custom_tool_call"]);
  const outputTypes = new Set(["function_call_output", "custom_tool_call_output"]);

  const outputCallIds = new Set();
  for (const item of payload.input) {
    if (item && typeof item === "object" && outputTypes.has(item.type) && typeof item.call_id === "string" && item.call_id) {
      outputCallIds.add(item.call_id);
    }
  }

  // 收集「还没有输出」的同名调用 id，按出现顺序排队
  const unpairedCallsByName = new Map();
  for (const item of payload.input) {
    if (!item || typeof item !== "object" || !callTypes.has(item.type)) continue;
    if (typeof item.call_id !== "string" || !item.call_id) {
      if (typeof item.id === "string") {
        item.call_id = item.id;
        changed = true;
      }
    }
    if (typeof item.call_id === "string" && item.call_id && !outputCallIds.has(item.call_id)) {
      const key = typeof item.name === "string" ? item.name : "";
      if (!unpairedCallsByName.has(key)) unpairedCallsByName.set(key, []);
      unpairedCallsByName.get(key).push(item.call_id);
    }
  }

  const newInput = [];
  for (const item of payload.input) {
    if (!item || typeof item !== "object" || !outputTypes.has(item.type)) {
      newInput.push(item);
      continue;
    }
    if (typeof item.call_id === "string" && item.call_id) {
      newInput.push(item);
      continue;
    }
    const key = typeof item.name === "string" ? item.name : "";
    const pool = key ? unpairedCallsByName.get(key) : undefined;
    if (pool && pool.length > 0) {
      item.call_id = pool.shift();
      changed = true;
      newInput.push(item);
    } else {
      // 无可配对调用，丢弃孤儿输出
      changed = true;
    }
  }
  // 为「有调用但无输出」的孤儿调用补一个空占位输出，避免 DeepSeek 报
  // "No tool output found for tool call"。常见于 Codex 续接会话时丢失了
  // view_image 等工具的输出（大 base64 被截断）。
  const outputTypeForCall = new Map([
    ["function_call", "function_call_output"],
    ["custom_tool_call", "custom_tool_call_output"],
  ]);
  for (const [callType, callIds] of unpairedCallsByName.entries()) {
    for (const callId of callIds) {
      const outputType = outputTypeForCall.get(callType) || "function_call_output";
      newInput.push({
        type: outputType,
        id: outputType === "function_call_output" ? `fco_${callId}` : `ctco_${callId}`,
        call_id: callId,
        output: "[placeholder: tool output was missing from session history]",
      });
      process.stderr.write(
        `${new Date().toISOString()} deepseek-call-ids: patched orphan call_id=${callId} name=${callType}\n`,
      );
      changed = true;
    }
  }

  payload.input = newInput;

  // ---- tools 清理：DeepSeek 的工具唯一性约束 ----
  // DeepSeek 的校验集合包含「顶层 tools」与「各 input 条目的 tools」：平铺函数名重复报
  // "Tool names must be unique."，namespace 名重复报 "Duplicate namespace name ..."，
  // 同一 namespace 内子工具重名报 "Tool names within a namespace must be unique."。
  // Codex 会把每个已发现的 MCP namespace 同时写进顶层 tools 与历史 tool_search_output
  // 条目，长会话还会反复搜索同一 namespace，因此必须按出现顺序全局去重。
  // 顶层 tools 展开 namespace 包装器：DeepSeek 侧模型按平铺工具名调用，Codex 能解析回 MCP 工具；
  // input 条目的 tools 保留 namespace 结构（展开后反而会与顶层平铺工具重名），只丢弃重复声明。
  // `tools` 字段不能省略，DeepSeek 会报 "input: missing field `tools`"。
  const seenToolNames = new Set();
  const dedupToolNames = (tools, seen = new Set()) => {
    const kept = [];
    for (const tool of tools) {
      const key = (tool && (tool.name || tool.type)) || JSON.stringify(tool);
      if (seen.has(key)) {
        changed = true;
        continue;
      }
      seen.add(key);
      kept.push(tool);
    }
    return kept;
  };

  function unwrapNamespaces(tools) {
    const out = [];
    for (const t of tools) {
      if (t && t.type === "namespace" && Array.isArray(t.tools)) {
        for (const sub of t.tools) out.push(sub);
        changed = true;
      } else {
        out.push(t);
      }
    }
    return out;
  }
  if (Array.isArray(payload.tools)) {
    payload.tools = dedupToolNames(unwrapNamespaces(payload.tools), seenToolNames);
  }
  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue;
    if (!Array.isArray(item.tools)) {
      // tool_search_output 必须带 tools 字段，DeepSeek 允许空数组但不允许缺字段
      if (item.type === "tool_search_output") {
        item.tools = [];
        changed = true;
      }
      continue;
    }
    const tools = dedupToolNames(item.tools, seenToolNames);
    for (const tool of tools) {
      // namespace 内部子工具同样按名去重，重名会被 DeepSeek 拒绝
      if (tool && tool.type === "namespace" && Array.isArray(tool.tools)) {
        tool.tools = dedupToolNames(tool.tools);
      }
    }
    item.tools = tools;
  }

  return changed;
}

// 请求体变换注册表：provider 通过 transforms 数组按序引用。
// 新供应商的兼容逻辑以新函数加入此处，再在配置里按名挂载。
const PAYLOAD_TRANSFORMS = new Map([
  ["chatgpt-history", sanitizeChatGptPayload],
  ["deepseek-effort", normalizeDeepSeekPayload],
  ["deepseek-call-ids", sanitizeDeepSeekCallIds],
]);

function buildChatGptHeaders(incomingHeaders) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(incomingHeaders)) {
    const lowerName = name.toLowerCase();
    const normalizedName = lowerName.replaceAll("_", "-");
    if (
      HOP_BY_HOP_HEADERS.has(lowerName)
      || normalizedName.includes("prompt-cache-retention")
      || rawValue === undefined
    ) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream, application/json");
  return headers;
}

function buildBearerHeaders(apiKey, incomingHeaders) {
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  });
  if (incomingHeaders["user-agent"]) headers.set("user-agent", incomingHeaders["user-agent"]);
  return headers;
}

function buildUpstreamHeaders(provider, credential, incomingHeaders) {
  if (provider.auth.type === "chatgpt") return buildChatGptHeaders(incomingHeaders);
  return buildBearerHeaders(credential, incomingHeaders);
}

// 返回值带 error 表示请求应被拒绝；chatgpt 类型要求客户端自带 Bearer 登录态，
// env 类型从环境变量取 Key（错误码带 provider id：deepseek -> deepseek_key_not_configured）。
function credentialError(provider, incomingHeaders) {
  if (provider.auth.type === "chatgpt") {
    const incoming = incomingHeaders.authorization || "";
    if (!incoming.startsWith("Bearer ")) {
      return { status: 401, error: "missing_chatgpt_auth" };
    }
    return { credential: "" };
  }
  const credential = process.env[provider.auth.envVar] || "";
  if (!credential) {
    return { status: 503, error: `${provider.id}_key_not_configured` };
  }
  return { credential };
}

function isPromptCacheRetentionError(upstream) {
  if (upstream.status !== 400) return false;
  return upstream.clone().json()
    .then((body) => body?.error?.param === "prompt_cache_retention")
    .catch(() => false);
}

function upstreamUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  const target = new URL("responses", baseUrl);
  target.search = incoming.search;
  return target;
}

function copyResponseHeaders(upstream, response) {
  for (const [name, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-store");
}

export async function createRouterServer(overrides = {}) {
  const config = overrides.config || (await loadConfig(overrides.configPath));

  return http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      jsonResponse(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || !["/v1/responses", "/responses"].includes(requestUrl.pathname)) {
      jsonResponse(response, 404, { error: "not_found" });
      return;
    }

    let model = "unknown";
    let route = "rejected";
    try {
      const body = await readBody(request, config.maxBodyBytes);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        jsonResponse(response, 400, { error: "invalid_json" });
        return;
      }

      model = typeof payload.model === "string" ? payload.model.trim() : "";
      const provider = resolveProvider(model, config);
      route = provider ? provider.id : route;
      if (!provider) {
        jsonResponse(response, 400, { error: "unsupported_model", model });
        return;
      }

      const authResult = credentialError(provider, request.headers);
      if (authResult.error) {
        jsonResponse(response, authResult.status, { error: authResult.error });
        return;
      }

      // 按配置顺序执行该 provider 的全部清洗（不用 || 短路：后续变换可能在
      // 前一个已改写时仍需运行），任一变换生效才重新序列化请求体。
      let requestBody = body;
      let transformed = false;
      for (const name of provider.transforms) {
        const transform = PAYLOAD_TRANSFORMS.get(name);
        if (transform && transform(payload)) transformed = true;
      }
      if (transformed) {
        requestBody = Buffer.from(JSON.stringify(payload), "utf8");
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("upstream timeout")),
        config.requestTimeoutMs,
      );
      request.once("aborted", () => controller.abort(new Error("client aborted")));

      try {
        const targetUrl = upstreamUrl(provider.baseUrl, request.url);
        const headers = buildUpstreamHeaders(provider, authResult.credential, request.headers);
        const fetchOpts = {
          method: "POST",
          headers,
          body: requestBody,
          signal: controller.signal,
          redirect: "error",
        };
        // 仅 ChatGPT 路由走代理，DeepSeek 等直连
        if (proxyAgent && provider.id === "chatgpt") fetchOpts.dispatcher = proxyAgent;
        let upstream = await undiciFetch(targetUrl, fetchOpts);

        // ChatGPT 后端偶尔会对带 prompt_cache_key 的 GPT-5.6 长会话后续请求返回
        // prompt_cache_retention 兼容错误。仅当 provider 声明 retryOnPromptCacheError
        // 且上游明确返回该参数错误时，去掉缓存亲和键重试一次；其他 400 原样返回。
        if (
          provider.retryOnPromptCacheError
          && Object.prototype.hasOwnProperty.call(payload, "prompt_cache_key")
          && await isPromptCacheRetentionError(upstream)
        ) {
          delete payload.prompt_cache_key;
          requestBody = Buffer.from(JSON.stringify(payload), "utf8");
          process.stdout.write(
            `${new Date().toISOString()} route=${provider.id} model=${model} retry=without_prompt_cache_key\n`,
          );
          upstream = await undiciFetch(targetUrl, fetchOpts);
        }

        response.statusCode = upstream.status;
        copyResponseHeaders(upstream, response);
        if (!upstream.body) {
          response.end();
          return;
        }
        await new Promise((resolve, reject) => {
          const stream = Readable.fromWeb(upstream.body);
          stream.once("error", reject);
          response.once("error", reject);
          response.once("finish", resolve);
          stream.pipe(response);
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      process.stderr.write(
        `${new Date().toISOString()} route=${route} model=${model} error=${error.message} code=${error.cause?.code || ""}\n`,
      );
      if (!response.headersSent) {
        jsonResponse(response, error.statusCode || 502, {
          error: error.name === "AbortError" ? "upstream_timeout" : "upstream_failure",
        });
      } else if (!response.writableEnded) {
        response.destroy(error);
      }
    } finally {
      const durationMs = Date.now() - startedAt;
      process.stdout.write(
        `${new Date().toISOString()} route=${route} model=${model || "missing"} status=${response.statusCode} duration_ms=${durationMs}\n`,
      );
    }
  });
}

export async function startRouter() {
  const config = await loadConfig();
  const server = await createRouterServer({ config });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`Codex model router listening on http://${config.host}:${config.port}\n`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRouter().catch((error) => {
    process.stderr.write(`Router failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
