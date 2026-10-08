import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/build-model-catalog.mjs", import.meta.url));
const officialCatalogPath = fileURLToPath(new URL("../config/deepseek-official-catalog.json", import.meta.url));

// 官方 slug -> 面向 Codex 的本地 slug（与生成脚本里的 localOverrides 保持一致）。
// 目前只有 deepseek-v4-pro 被改名为 deepseek-pro 并隐藏。
function localSlugOf(slug) {
  return slug === "deepseek-v4-pro" ? "deepseek-pro" : slug;
}

function localDeepSeekSlugs() {
  return JSON.parse(readFileSync(officialCatalogPath, "utf8"))
    .models.map((model) => localSlugOf(model.slug));
}

// 用最小 models_cache.json 夹具跑生成脚本，避免依赖本机 %USERPROFILE%\.codex\models_cache.json
function fixture(models) {
  const dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
  const cachePath = join(dir, "models_cache.json");
  writeFileSync(cachePath, JSON.stringify({
    fetched_at: "2026-01-01T00:00:00Z",
    models: models || [
      // 本机 models_cache.json 的真实形态：Sol 含 ultra 档，Luna 只到 max
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        priority: 1,
        default_reasoning_level: "low",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
        service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6-Luna",
        visibility: "list",
        priority: 2,
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
      },
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 3 },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 4 },
      { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 5 },
    ],
  }), "utf8");
  return { dir, cachePath, outPath: join(dir, "models.json") };
}

function routerConfigPath(dir, name, models) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    host: "127.0.0.1",
    port: 4010,
    maxBodyBytes: 1048576,
    requestTimeoutMs: 1000,
    providers: [
      { id: "chatgpt", match: { prefixes: ["gpt-", "codex-"] } },
      { id: "deepseek", match: { models } },
      { id: "astrahub", match: { models: ["as-kimi-k3", "as-deepseek-v4.1-flash", "as-glm-5.2"] } },
    ],
  }), "utf8");
  return path;
}

function run({ cachePath, outPath, configPath }) {
  return execFileSync(process.execPath, [
    scriptPath,
    "--source", cachePath,
    "--output", outPath,
    "--router-config", configPath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("generates the catalog from the official DeepSeek baseline and passes the route check", () => {
  const { dir, cachePath, outPath } = fixture();
  const configPath = routerConfigPath(dir, "router-ok.json", localDeepSeekSlugs());

  const stdout = run({ cachePath, outPath, configPath });
  assert.match(stdout, /route check ok/);

  const generated = JSON.parse(readFileSync(outPath, "utf8")).models;
  const generatedSlugs = generated.map((model) => model.slug);
  for (const slug of localDeepSeekSlugs()) {
    assert.ok(generatedSlugs.includes(slug), `catalog is missing ${slug}`);
  }
  // GPT 侧仍按缓存保留、隐藏旧模型，并合成 GPT-6 家族
  // 5.6 Terra/Luna 与 5.5/5.4 只保留路由、不在模型列表显示（已被 GPT-6 取代）
  for (const slug of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]) {
    assert.equal(generated.find((model) => model.slug === slug).visibility, "hide", `${slug} 应隐藏`);
  }
  // 5.6 Sol 保持显示，可与更便宜的 6 Sol 并存
  assert.equal(generated.find((model) => model.slug === "gpt-5.6-sol").visibility, "list");
  for (const slug of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
    assert.ok(generatedSlugs.includes(slug), `catalog is missing ${slug}`);
  }
  // 可见条目顺序：GPT-6 三个条目 → 5.6 Sol → DeepSeek，隐藏条目排在最后
  assert.deepEqual(generatedSlugs.slice(0, 4), ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(generatedSlugs.slice(4, 4 + localDeepSeekSlugs().length), localDeepSeekSlugs());
  assert.equal(generated.at(-1).visibility, "hide");
  // 生成结果旁边的元信息文件：条数、官方抓取时间与可见模型清单
  const meta = JSON.parse(readFileSync(join(dir, "models.meta.json"), "utf8"));
  assert.equal(meta.model_count, generated.length);
  assert.equal(meta.official_fetched_at, "2026-01-01T00:00:00Z");
  assert.deepEqual(meta.visible_models, ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "deepseek-flash", "as-kimi-k3", "as-deepseek-v4.1-flash", "as-glm-5.2"]);
  assert.equal(typeof meta.generated_at, "string");
  // 合成条目按官方规格：1.05M 上下文、默认档位、档位上界与 Fast 费率说明
  const astra = generated.find((model) => model.slug === "gpt-6-astra");
  assert.equal(astra.context_window, 1050000);
  assert.equal(astra.default_reasoning_level, "low");
  assert.deepEqual(astra.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "xhigh", "max"]);
  const sol = generated.find((model) => model.slug === "gpt-6-sol");
  assert.equal(sol.display_name, "GPT-6 Sol");
  assert.equal(sol.context_window, 1050000);
  assert.equal(sol.max_context_window, 1050000);
  assert.equal(sol.default_reasoning_level, "medium");
  assert.deepEqual(sol.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  const luna = generated.find((model) => model.slug === "gpt-6-luna");
  assert.equal(luna.display_name, "GPT-6 Luna");
  assert.equal(luna.default_reasoning_level, "high");
  assert.deepEqual(luna.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "xhigh", "max"]);
  // 未被本地覆盖的 DeepSeek 条目保持官方 slug / 显示名，只做档位映射
  const flash = generated.find((model) => model.slug === "deepseek-flash");
  assert.equal(flash.display_name, "DeepSeek-Flash");
  assert.deepEqual(flash.supported_reasoning_levels.map((level) => level.effort), ["medium", "high", "xhigh"]);
  assert.equal(flash.multi_agent_version, "v1");
  // deepseek-v4-pro 按本地覆盖改名为 deepseek-pro、显示名 DeepSeek-Pro，并暂时隐藏
  const pro = generated.find((model) => model.slug === "deepseek-pro");
  assert.equal(pro.display_name, "DeepSeek-Pro");
  assert.equal(pro.visibility, "hide");
  assert.equal(pro.context_window, 1048576);
  assert.equal(generated.some((model) => model.slug === "deepseek-v4-pro"), false);
  for (const [slug, displayName, expectsImage] of [
    ["as-kimi-k3", "AS-kimi-k3", true],
    ["as-deepseek-v4.1-flash", "AS-deepseek-v4.1-flash", true],
    ["as-glm-5.2", "AS-GLM-5.2", false],
  ]) {
    const model = generated.find((entry) => entry.slug === slug);
    assert.equal(model.display_name, displayName);
    assert.equal(model.visibility, "list");
    assert.equal(model.context_window, 1000000);
    assert.equal(model.max_context_window, 1000000);
    assert.deepEqual(model.input_modalities, expectsImage ? ["text", "image"] : ["text"]);
    assert.equal(model.supports_image_detail_original, expectsImage);
  }
});

test("prefers the official cache entry once the cache lists GPT-6 models", () => {
  const { dir, cachePath, outPath } = fixture([
    { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list", priority: 1 },
    { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list", priority: 2 },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 3 },
  ]);
  const configPath = routerConfigPath(dir, "router-official-gpt6.json", localDeepSeekSlugs());

  run({ cachePath, outPath, configPath });

  const generated = JSON.parse(readFileSync(outPath, "utf8")).models;
  const slugs = generated.map((model) => model.slug);
  // 缓存已收录的 GPT-6 条目不再重复合成，也不被合成值覆盖
  assert.equal(slugs.filter((slug) => slug === "gpt-6-sol").length, 1);
  assert.equal(slugs.filter((slug) => slug === "gpt-6-luna").length, 1);
  assert.equal(generated.find((model) => model.slug === "gpt-6-sol").context_window, undefined);
  // 缓存未收录的 gpt-6-astra 仍走合成，5.6 Sol 保持显示
  assert.ok(slugs.includes("gpt-6-astra"));
  assert.equal(generated.find((model) => model.slug === "gpt-5.6-sol").visibility, "list");
});

test("fails when the router cannot route a generated model", () => {
  const { dir, cachePath, outPath } = fixture();
  // 历史故障形态：路由还停在旧命名，生成出来的新模型路由认不出
  const configPath = routerConfigPath(dir, "router-stale.json", ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

  assert.throws(
    () => run({ cachePath, outPath, configPath }),
    /cannot route: .*deepseek-flash/,
  );
});

test("fails when the router declares a model missing from the catalog", () => {
  const { dir, cachePath, outPath } = fixture();
  const configPath = routerConfigPath(dir, "router-extra.json", [...localDeepSeekSlugs(), "deepseek-legacy"]);

  assert.throws(
    () => run({ cachePath, outPath, configPath }),
    /declares models missing from the catalog: deepseek-legacy/,
  );
});

test("fails when modelAliases points at an unknown model", () => {
  const { dir, cachePath, outPath } = fixture();
  const configPath = routerConfigPath(dir, "router-bad-alias.json", localDeepSeekSlugs());
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.providers[1].modelAliases = { "deepseek-pro": "deepseek-pro-typo" };
  writeFileSync(configPath, JSON.stringify(config), "utf8");

  assert.throws(
    () => run({ cachePath, outPath, configPath }),
    /unknown modelAliases targets: deepseek-pro-typo/,
  );
});
