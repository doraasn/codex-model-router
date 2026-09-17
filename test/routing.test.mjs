import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createRouterServer } from "../src/server.mjs";

const DEEPSEEK_MODELS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

// 与 config/router.config.json 同构的 provider 化配置，端口指向本地模拟上游。
function routerConfig({ chatgptPort, deepseekPort, maxBodyBytes = 1024 * 1024, requestTimeoutMs = 5000 }) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes,
    requestTimeoutMs,
    providers: [
      {
        id: "chatgpt",
        baseUrl: `http://127.0.0.1:${chatgptPort}/codex/`,
        auth: { type: "chatgpt" },
        match: { models: new Set(), prefixes: ["gpt-", "codex-"] },
        transforms: ["chatgpt-history"],
        retryOnPromptCacheError: true,
      },
      {
        id: "deepseek",
        baseUrl: `http://127.0.0.1:${deepseekPort}/`,
        auth: { type: "env", envVar: "DEEPSEEK_API_KEY" },
        match: { models: new Set([...DEEPSEEK_MODELS]), prefixes: [] },
        transforms: ["deepseek-effort", "deepseek-call-ids"],
      },
    ],
  };
}

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

function mockUpstream(received) {
  return http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      authorization: request.headers.authorization,
      accountId: request.headers["chatgpt-account-id"],
      headers: { ...request.headers },
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n');
    response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
}

test("routes GPT and DeepSeek without crossing credentials", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const commonHeaders = {
    authorization: "Bearer chatgpt-test-token",
    "chatgpt-account-id": "account-test",
    "content-type": "application/json",
  };
  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
  });
  assert.equal(gptResponse.status, 200);
  assert.match(await gptResponse.text(), /response.completed/);

  for (const model of DEEPSEEK_MODELS) {
    const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ model, input: "hello" }),
    });
    assert.equal(deepSeekResponse.status, 200);
    assert.match(await deepSeekResponse.text(), /response.completed/);
  }

  assert.equal(chatGptReceived[0].authorization, "Bearer chatgpt-test-token");
  assert.equal(chatGptReceived[0].accountId, "account-test");
  assert.equal(deepSeekReceived.length, DEEPSEEK_MODELS.size);
  for (const request of deepSeekReceived) {
    assert.equal(request.authorization, "Bearer deepseek-test-key");
    assert.equal(request.accountId, undefined);
  }
});

test("maps DeepSeek efforts and leaves GPT effort unchanged", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };

  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "xhigh" } }),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();

  const deepSeekPayloads = [
    { payload: { model: "deepseek-v4-pro", input: "pro medium", reasoning: { effort: "medium" } }, expected: "low" },
    { payload: { model: "deepseek-v4-pro", input: "pro high", reasoning: { effort: "high" } }, expected: "high" },
    { payload: { model: "deepseek-v4-pro", input: "pro xhigh", reasoning: { effort: "xhigh" } }, expected: "max" },
    { payload: { model: "deepseek-v4-pro", input: "pro missing effort" }, expected: "high" },
    { payload: { model: "deepseek-v4-flash", input: "flash missing effort" }, expected: "high" },
    { payload: { model: "deepseek-v4-flash", input: "flash medium", reasoning: { effort: "medium" } }, expected: "low" },
    { payload: { model: "deepseek-v4-flash", input: "flash high", reasoning: { effort: "high" } }, expected: "high" },
    { payload: { model: "deepseek-v4-flash", input: "flash xhigh", reasoning: { effort: "xhigh" } }, expected: "max" },
    { payload: { model: "deepseek-v4-flash", input: "flash legacy", reasoning_effort: "medium" }, expected: "low", legacy: "low" },
    { payload: { model: "deepseek-v4-flash-vision-exp", input: "vision high", reasoning: { effort: "high" } }, expected: "high" },
    { payload: { model: "deepseek-v4-flash-vision-exp", input: "vision legacy", reasoning_effort: "xhigh" }, expected: "max", legacy: "max" },
  ];
  for (const { payload } of deepSeekPayloads) {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  assert.equal(chatGptReceived[0].body.reasoning.effort, "xhigh");
  assert.equal(deepSeekReceived.length, deepSeekPayloads.length);
  for (const [index, request] of deepSeekReceived.entries()) {
    assert.equal(request.body.reasoning.effort, deepSeekPayloads[index].expected);
    if (deepSeekPayloads[index].legacy) {
      assert.equal(request.body.reasoning_effort, deepSeekPayloads[index].legacy);
    }
  }
});

test("strips service tier only on the DeepSeek route", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };
  const payload = { model: "gpt-5.6-sol", input: "hello", service_tier: "priority" };

  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();
  assert.equal(chatGptReceived[0].body.service_tier, "priority");

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, model: "deepseek-v4-flash" }),
  });
  assert.equal(deepSeekResponse.status, 200);
  await deepSeekResponse.text();
  assert.equal(deepSeekReceived[0].body.service_tier, undefined);
  assert.equal("service_tier" in deepSeekReceived[0].body, false);
});

test("removes legacy prompt cache retention fields and headers only on the ChatGPT route", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
    "x-prompt-cache-retention": "24h",
  };
  const legacyCacheOptions = {
    prompt_cache_retention: "24h",
    nested: { prompt_cache_retention: "1h", keep: true },
  };
  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "hello", ...legacyCacheOptions }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(chatGptReceived.length, 1);
  assert.equal("prompt_cache_retention" in chatGptReceived[0].body, false);
  assert.equal("prompt_cache_retention" in chatGptReceived[0].body.nested, false);
  assert.equal(chatGptReceived[0].body.nested.keep, true);
  assert.equal(chatGptReceived[0].headers["x-prompt-cache-retention"], undefined);

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", ...legacyCacheOptions }),
  });
  assert.equal(deepSeekResponse.status, 200);
  await deepSeekResponse.text();
  assert.equal(deepSeekReceived[0].body.prompt_cache_retention, "24h");
  assert.equal(deepSeekReceived[0].body.nested.prompt_cache_retention, "1h");
});

test("retries a ChatGPT cache retention error once without prompt_cache_key", async (t) => {
  const received = [];
  const chatGptServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    if (body.prompt_cache_key) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "prompt_cache_retention is not supported on this model",
          type: "invalid_request_error",
          param: "prompt_cache_retention",
          code: "invalid_parameter",
        },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  const chatGptPort = await listen(chatGptServer);
  t.after(() => chatGptServer.close());

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: 9 }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer chatgpt-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", prompt_cache_key: "thread-key" }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.equal(received.length, 2);
  assert.equal(received[0].prompt_cache_key, "thread-key");
  assert.equal("prompt_cache_key" in received[1], false);
});

test("sanitizes DeepSeek reasoning content only on the ChatGPT route", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  // 模拟会话历史里来自 DeepSeek 的推理条目：content 带 reasoning_text，summary 为空
  const reasoningItem = {
    type: "reasoning",
    id: "reasoning-deepseek-1",
    summary: [],
    content: [{ type: "reasoning_text", text: "内部推理过程" }],
    encrypted_content: null,
  };
  const requestBody = {
    model: "gpt-5.6-sol",
    input: [reasoningItem, { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };

  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();

  // GPT 路由：content 被清空，推理文本挪进 summary（summary_text），其余字段保留
  const gptItem = chatGptReceived[0].body.input[0];
  assert.equal(gptItem.type, "reasoning");
  assert.match(gptItem.id, /^rs_/);
  assert.deepEqual(gptItem.content, []);
  assert.deepEqual(gptItem.summary, [{ type: "summary_text", text: "内部推理过程" }]);

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...requestBody, model: "deepseek-v4-flash" }),
  });
  assert.equal(deepSeekResponse.status, 200);
  await deepSeekResponse.text();

  // DeepSeek 路由：请求体原样透传，推理条目不做任何改动
  assert.deepEqual(deepSeekReceived[0].body.input, requestBody.input);
});

test("normalizes third-party item ids on the ChatGPT route and keeps call_id pairing", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  // 模拟 DeepSeek 会话历史：各类型条目的 id 都不带官方要求的类型前缀
  const requestBody = {
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", id: "user-uuid-1", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "reasoning-uuid-1", summary: [], content: [{ type: "reasoning_text", text: "思考" }], encrypted_content: null },
      { type: "web_search_call", id: "call_00_websearch123", search: { query: "test" } },
      { type: "function_call", id: "fc-uuid-1", call_id: "call_00_fn123", name: "shell", arguments: "{}" },
      { type: "function_call_output", id: "fco_019f-valid", call_id: "call_00_fn123", output: "ok" },
      { type: "custom_tool_call", id: "ctc-uuid-1", call_id: "call_00_ct123", name: "my-tool", arguments: "{}" },
      { type: "custom_tool_call_output", id: "ctco_019f-valid", call_id: "call_00_ct123", output: "ok" },
    ],
  };

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };

  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();

  const input = chatGptReceived[0].body.input;
  assert.match(input[0].id, /^msg_/);
  assert.match(input[1].id, /^rs_/);
  assert.match(input[2].id, /^ws_/);
  assert.match(input[3].id, /^fc_/);
  assert.match(input[5].id, /^ctc_/);
  // 已带合法前缀的 id 保持不变
  assert.equal(input[4].id, "fco_019f-valid");
  assert.equal(input[6].id, "ctco_019f-valid");
  // call_id 保持原样，函数调用与调用结果仍能配对
  assert.equal(input[3].call_id, "call_00_fn123");
  assert.equal(input[4].call_id, "call_00_fn123");
  assert.equal(input[5].call_id, "call_00_ct123");
  assert.equal(input[6].call_id, "call_00_ct123");
  // 同一请求里映射稳定（每个旧 id 只会得到一个确定的新 id）
  const ids = new Set(input.map((item) => item.id));
  assert.equal(ids.size, input.length);

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...requestBody, model: "deepseek-v4-flash" }),
  });
  assert.equal(deepSeekResponse.status, 200);
  await deepSeekResponse.text();
  // DeepSeek 路由：id 与 call_id 全部原样
  assert.deepEqual(deepSeekReceived[0].body.input, requestBody.input);
});

test("rejects unsupported models", async (t) => {
  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: 9, deepseekPort: 9, maxBodyBytes: 1024, requestTimeoutMs: 1000 }),
  });
  const port = await listen(router);
  t.after(() => router.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "unexpected-model", input: "hello" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unsupported_model");
});

test("fails closed when route credentials are missing", async (t) => {
  delete process.env.DEEPSEEK_API_KEY;
  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: 9, deepseekPort: 9, maxBodyBytes: 1024, requestTimeoutMs: 1000 }),
  });
  const port = await listen(router);
  t.after(() => router.close());

  const gptResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
  });
  assert.equal(gptResponse.status, 401);
  assert.equal((await gptResponse.json()).error, "missing_chatgpt_auth");

  const deepSeekResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer chatgpt-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(deepSeekResponse.status, 503);
  assert.equal((await deepSeekResponse.json()).error, "deepseek_key_not_configured");
});

test("backfills missing call_id on DeepSeek input items only", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };
  // 场景1：存在未配对调用 -> 缺失 call_id 的输出按 name 回填
  const backfillInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", id: "call-item-1", name: "send_message_to_thread", call_id: "call_00_ABC", arguments: "{}" },
    { type: "function_call_output", id: "fco_01a06170", name: "send_message_to_thread", output: "{\"ok\":true}" },
  ];

  // 场景2（真实病根）：两次 send_message_to_thread 调用各自已有输出，
  // 再加一条无 call_id、且找不到可配对调用的孤儿输出 -> 应被丢弃，避免重复。
  const orphanInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", id: "call-item-1", name: "send_message_to_thread", call_id: "call_00_ABC", arguments: "{}" },
    { type: "function_call_output", id: "fco_01a0616c-1", call_id: "call_00_ABC", output: "{\"ok\":true}" },
    { type: "function_call", id: "call-item-2", name: "send_message_to_thread", call_id: "call_00_DEF", arguments: "{}" },
    { type: "function_call_output", id: "fco_01a0616c-2", call_id: "call_00_DEF", output: "{\"ok\":true}" },
    { type: "function_call_output", id: "fco_orphan", name: "send_message_to_thread", output: "<codex_delegation>" },
  ];

  let i = 0;
  for (const input of [backfillInput, orphanInput]) {
    const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "deepseek-v4-pro", input }),
    });
    assert.equal(deepSeekResponse.status, 200);
    await deepSeekResponse.text();
    if (i === 0) {
      const dsInput = deepSeekReceived[0].body.input;
      // 缺失 call_id 的输出按 name 回填到未配对调用
      assert.equal(dsInput[2].call_id, "call_00_ABC");
    } else {
      const dsInput = deepSeekReceived[1].body.input;
      // 孤儿输出被移除，input 长度 5
      assert.equal(dsInput.length, 5);
      // 原有 call_id 保持不变
      assert.equal(dsInput[2].call_id, "call_00_ABC");
      assert.equal(dsInput[4].call_id, "call_00_DEF");
      // 输出 call_id 之间无重复
      const outputIds = dsInput.filter((x) => x.type === "function_call_output").map((x) => x.call_id);
      assert.equal(new Set(outputIds).size, outputIds.length);
      assert.ok(!dsInput.some((x) => x.type === "function_call_output" && x.id === "fco_orphan"));
    }
    i += 1;
  }

  // GPT 路由不补齐 call_id、不丢弃条目（OpenAI 原生格式不需要，ChatGpt 清洗只处理 id 前缀/推理）
  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.6-sol", input: orphanInput }),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();
  const gptInput = chatGptReceived[0].body.input;
  assert.equal(gptInput.length, orphanInput.length);
  assert.equal(gptInput[5].call_id, undefined);
});

test("deduplicates DeepSeek tool declarations across top-level tools and input items", async (t) => {
  const chatGptReceived = [];
  const deepSeekReceived = [];
  const chatGptServer = mockUpstream(chatGptReceived);
  const deepSeekServer = mockUpstream(deepSeekReceived);
  const chatGptPort = await listen(chatGptServer);
  const deepSeekPort = await listen(deepSeekServer);
  t.after(() => chatGptServer.close());
  t.after(() => deepSeekServer.close());

  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  t.after(() => delete process.env.DEEPSEEK_API_KEY);

  const router = await createRouterServer({
    config: routerConfig({ chatgptPort: chatGptPort, deepseekPort: deepSeekPort }),
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const headers = {
    authorization: "Bearer chatgpt-test-token",
    "content-type": "application/json",
  };
  const fn = (name, description) => ({
    type: "function",
    name,
    description,
    strict: false,
    parameters: { type: "object", properties: {}, required: [] },
  });
  // Codex 每个已发现的 MCP namespace 会同时出现在顶层 tools 和历史 tool_search_output 条目里
  const ideaNamespace = () => ({
    type: "namespace",
    name: "mcp__idea",
    description: "Tools in the mcp__idea namespace.",
    tools: [fn("get_run_configurations", "列出运行配置"), fn("execute_run_configuration", "执行运行配置")],
  });
  const searchCall = (callId) => ({
    type: "tool_search_call",
    id: `tsc_${callId}`,
    call_id: callId,
    status: "completed",
    execution: "client",
    arguments: { query: "idea mcp", limit: 10 },
  });
  const searchOutput = (callId, tools) => ({
    type: "tool_search_output",
    id: `tso_${callId}`,
    call_id: callId,
    status: "completed",
    execution: "client",
    tools,
  });
  const payload = {
    model: "deepseek-v4-pro",
    tools: [fn("exec_command", "跑命令"), fn("exec_command", "重复定义"), ideaNamespace()],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "用 idea mcp 重启下后端" }] },
      searchCall("call_idea_1"),
      searchOutput("call_idea_1", [ideaNamespace()]),
      searchCall("call_idea_2"),
      searchOutput("call_idea_2", [ideaNamespace()]),
      // 客户端在搜索结果为空时会省略 tools 字段，DeepSeek 会直接报 missing field `tools`
      { type: "tool_search_output", id: "tso_empty", call_id: "call_empty", status: "completed", execution: "client" },
    ],
  };

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(deepSeekResponse.status, 200);
  await deepSeekResponse.text();

  // 顶层 tools 展开 namespace 后按 name 去重，DeepSeek 侧模型仍按平铺工具名调用
  const toolNames = deepSeekReceived[0].body.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, ["exec_command", "get_run_configurations", "execute_run_configuration"]);
  const firstOutput = deepSeekReceived[0].body.input[2];
  assert.equal(firstOutput.tools.length, 1);
  assert.equal(firstOutput.tools[0].name, "mcp__idea");
  assert.deepEqual(firstOutput.tools[0].tools.map((tool) => tool.name), ["get_run_configurations", "execute_run_configuration"]);
  // input 条目保留 namespace 结构，只丢弃重复声明（不能展开，展开后与顶层平铺工具重名）
  assert.deepEqual(deepSeekReceived[0].body.input[4].tools, []);
  // 缺失的 tools 字段补成空数组
  assert.deepEqual(deepSeekReceived[0].body.input[5].tools, []);

  // GPT 路由不做 DeepSeek 专有清洗，tools 结构原样透传
  const gptResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, model: "gpt-5.6-sol" }),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();
  const gptBody = chatGptReceived[0].body;
  assert.equal(gptBody.tools.length, 3);
  assert.equal(gptBody.tools[2].type, "namespace");
  assert.equal(gptBody.input[2].tools[0].name, "mcp__idea");
  assert.equal(gptBody.input[5].tools, undefined);
});

test("supports additional providers declared in config without code changes", async (t) => {
  const zaiReceived = [];
  const zaiServer = mockUpstream(zaiReceived);
  const zaiPort = await listen(zaiServer);
  t.after(() => zaiServer.close());

  process.env.GLM_API_KEY = "glm-test-key";
  t.after(() => delete process.env.GLM_API_KEY);

  const router = await createRouterServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      providers: [
        {
          id: "zai",
          name: "Z.ai GLM",
          baseUrl: `http://127.0.0.1:${zaiPort}/`,
          auth: { type: "env", envVar: "GLM_API_KEY" },
          match: { prefixes: ["glm-"] },
          transforms: [],
        },
      ],
    },
  });
  const routerPort = await listen(router);
  t.after(() => router.close());

  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer chatgpt-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "glm-4.7", input: "hello", service_tier: "priority" }),
  });
  assert.equal(response.status, 200);
  await response.text();

  // 新 provider 使用自己的凭据；未声明 transforms 时请求体保持原样
  assert.equal(zaiReceived.length, 1);
  assert.equal(zaiReceived[0].authorization, "Bearer glm-test-key");
  assert.equal(zaiReceived[0].accountId, undefined);
  assert.equal(zaiReceived[0].body.model, "glm-4.7");
  assert.equal(zaiReceived[0].body.service_tier, "priority");
});
