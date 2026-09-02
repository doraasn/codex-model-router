import http from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

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

function routeForModel(model, config) {
  if (config.deepseekModels.has(model)) return "deepseek";
  if (config.gptModelPrefixes.some((prefix) => model.startsWith(prefix))) return "chatgpt";
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

// 清洗发往 ChatGPT 后端的请求体，仅影响 ChatGPT 路由，DeepSeek 请求原样透传：
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
// 缺省或未知档位回退 high。GPT 不经过此函数。
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
// 此处按名称把缺失的 call_id 回填为前序同名调用的 call_id，找不到再从条目 id 派生。
function sanitizeDeepSeekCallIds(payload) {
  if (!payload || !Array.isArray(payload.input)) return false;
  let changed = false;
  const callTypes = new Set(["function_call", "custom_tool_call"]);
  const outputTypes = new Set(["function_call_output", "custom_tool_call_output"]);
  const lastCallIdByName = new Map();
  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue;
    if (callTypes.has(item.type)) {
      if (typeof item.call_id === "string" && item.call_id) {
        const key = typeof item.name === "string" ? item.name : item.call_id;
        lastCallIdByName.set(key, item.call_id);
      } else if (typeof item.id === "string") {
        item.call_id = item.id;
        const key = typeof item.name === "string" ? item.name : item.call_id;
        lastCallIdByName.set(key, item.call_id);
        changed = true;
      }
      continue;
    }
    if (!outputTypes.has(item.type)) continue;
    if (typeof item.call_id === "string" && item.call_id) continue;
    const key = typeof item.name === "string" ? item.name : "";
    const pairedCallId = key ? lastCallIdByName.get(key) : undefined;
    if (typeof pairedCallId === "string" && pairedCallId) {
      item.call_id = pairedCallId;
    } else if (typeof item.id === "string") {
      item.call_id = item.id;
    } else {
      item.call_id = "call_" + Date.now().toString(36);
    }
    changed = true;
  }
  return changed;
}

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

function isPromptCacheRetentionError(upstream) {
  if (upstream.status !== 400) return false;
  return upstream.clone().json()
    .then((body) => body?.error?.param === "prompt_cache_retention")
    .catch(() => false);
}

function buildDeepSeekHeaders(apiKey, incomingHeaders) {
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  });
  if (incomingHeaders["user-agent"]) headers.set("user-agent", incomingHeaders["user-agent"]);
  return headers;
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
      route = routeForModel(model, config);
      if (!route) {
        jsonResponse(response, 400, { error: "unsupported_model", model });
        return;
      }

      const incomingAuthorization = request.headers.authorization || "";
      if (route === "chatgpt" && !incomingAuthorization.startsWith("Bearer ")) {
        jsonResponse(response, 401, { error: "missing_chatgpt_auth" });
        return;
      }

      // 仅对 ChatGPT 路由清洗推理条目，保持 DeepSeek 请求原样透传
      let requestBody = body;
      if (route === "chatgpt" && sanitizeChatGptPayload(payload)) {
        requestBody = Buffer.from(JSON.stringify(payload), "utf8");
      } else if (route === "deepseek") {
        // 两个清洗都要执行，不能用 || 短路：第 2 个可能在上一个已改写时仍需跑
        const normalized = normalizeDeepSeekPayload(payload);
        const sanitizedCallIds = sanitizeDeepSeekCallIds(payload);
        if (normalized || sanitizedCallIds) {
          requestBody = Buffer.from(JSON.stringify(payload), "utf8");
        }
      }

      const deepSeekKey = process.env.DEEPSEEK_API_KEY || "";
      if (route === "deepseek" && !deepSeekKey) {
        jsonResponse(response, 503, { error: "deepseek_key_not_configured" });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("upstream timeout")),
        config.requestTimeoutMs,
      );
      request.once("aborted", () => controller.abort(new Error("client aborted")));

      try {
        const baseUrl = route === "deepseek" ? config.deepseekBaseUrl : config.chatgptBaseUrl;
        const headers =
          route === "deepseek"
            ? buildDeepSeekHeaders(deepSeekKey, request.headers)
            : buildChatGptHeaders(request.headers);
        const targetUrl = upstreamUrl(baseUrl, request.url);
        let upstream = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: requestBody,
          signal: controller.signal,
          redirect: "error",
        });

        // ChatGPT 后端偶尔会对带 prompt_cache_key 的 GPT-5.6 长会话后续请求返回
        // prompt_cache_retention 兼容错误。仅在上游明确返回该参数错误时，去掉
        // 缓存亲和键重试一次；其他 400 原样返回，DeepSeek 路由也不参与重试。
        if (
          route === "chatgpt"
          && Object.prototype.hasOwnProperty.call(payload, "prompt_cache_key")
          && await isPromptCacheRetentionError(upstream)
        ) {
          delete payload.prompt_cache_key;
          requestBody = Buffer.from(JSON.stringify(payload), "utf8");
          process.stdout.write(
            `${new Date().toISOString()} route=chatgpt model=${model} retry=without_prompt_cache_key\n`,
          );
          upstream = await fetch(targetUrl, {
            method: "POST",
            headers,
            body: requestBody,
            signal: controller.signal,
            redirect: "error",
          });
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
