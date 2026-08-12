import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createRouterServer } from "../src/server.mjs";

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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      chatgptBaseUrl: `http://127.0.0.1:${chatGptPort}/codex/`,
      deepseekBaseUrl: `http://127.0.0.1:${deepSeekPort}/`,
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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

  const deepSeekResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(deepSeekResponse.status, 200);
  assert.match(await deepSeekResponse.text(), /response.completed/);

  assert.equal(chatGptReceived[0].authorization, "Bearer chatgpt-test-token");
  assert.equal(chatGptReceived[0].accountId, "account-test");
  assert.equal(deepSeekReceived[0].authorization, "Bearer deepseek-test-key");
  assert.equal(deepSeekReceived[0].accountId, undefined);
});

test("forces max for every DeepSeek request and leaves GPT effort unchanged", async (t) => {
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      chatgptBaseUrl: `http://127.0.0.1:${chatGptPort}/codex/`,
      deepseekBaseUrl: `http://127.0.0.1:${deepSeekPort}/`,
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
    { model: "deepseek-v4-flash", input: "missing effort" },
    { model: "deepseek-v4-flash", input: "low effort", reasoning: { effort: "low" } },
    { model: "deepseek-v4-flash", input: "high effort", reasoning: { effort: "high" } },
    { model: "deepseek-v4-flash", input: "old xhigh effort", reasoning: { effort: "xhigh" } },
    { model: "deepseek-v4-flash", input: "legacy field", reasoning_effort: "low" },
  ];
  for (const payload of deepSeekPayloads) {
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
  for (const request of deepSeekReceived) {
    assert.equal(request.body.reasoning.effort, "max");
  }
  assert.equal(deepSeekReceived.at(-1).body.reasoning_effort, "max");
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      chatgptBaseUrl: `http://127.0.0.1:${chatGptPort}/codex/`,
      deepseekBaseUrl: `http://127.0.0.1:${deepSeekPort}/`,
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      chatgptBaseUrl: `http://127.0.0.1:${chatGptPort}/codex/`,
      deepseekBaseUrl: `http://127.0.0.1:${deepSeekPort}/`,
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 5000,
      chatgptBaseUrl: `http://127.0.0.1:${chatGptPort}/codex/`,
      deepseekBaseUrl: `http://127.0.0.1:${deepSeekPort}/`,
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024,
      requestTimeoutMs: 1000,
      chatgptBaseUrl: "http://127.0.0.1:9/codex/",
      deepseekBaseUrl: "http://127.0.0.1:9/",
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
    config: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024,
      requestTimeoutMs: 1000,
      chatgptBaseUrl: "http://127.0.0.1:9/codex/",
      deepseekBaseUrl: "http://127.0.0.1:9/",
      deepseekModels: new Set(["deepseek-v4-flash"]),
      gptModelPrefixes: ["gpt-", "codex-"],
    },
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
