import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/build-model-catalog.mjs", import.meta.url));
const officialCatalogPath = fileURLToPath(new URL("../config/deepseek-official-catalog.json", import.meta.url));

// 用最小 models_cache.json 夹具跑生成脚本，避免依赖本机 %USERPROFILE%\.codex\models_cache.json
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
  const cachePath = join(dir, "models_cache.json");
  writeFileSync(cachePath, JSON.stringify({
    fetched_at: "2026-01-01T00:00:00Z",
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 2 },
      { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 3 },
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
  const officialSlugs = JSON.parse(readFileSync(officialCatalogPath, "utf8")).models.map((model) => model.slug);
  const configPath = routerConfigPath(dir, "router-ok.json", officialSlugs);

  const stdout = run({ cachePath, outPath, configPath });
  assert.match(stdout, /route check ok/);

  const generated = JSON.parse(readFileSync(outPath, "utf8")).models;
  const generatedSlugs = generated.map((model) => model.slug);
  for (const slug of officialSlugs) {
    assert.ok(generatedSlugs.includes(slug), `catalog is missing ${slug}`);
  }
  // GPT 侧仍按缓存保留、隐藏兼容模型、合成 Astra
  assert.ok(generatedSlugs.includes("gpt-5.6-sol"));
  assert.ok(generatedSlugs.includes("gpt-5.4"));
  assert.equal(generated.find((model) => model.slug === "gpt-5.4").visibility, "hide");
  assert.ok(generatedSlugs.includes("gpt-6-astra"));
  // DeepSeek 条目只做档位映射，不动官方 slug / 显示名
  const flash = generated.find((model) => model.slug === "deepseek-flash");
  assert.equal(flash.display_name, "DeepSeek-Flash");
  assert.deepEqual(flash.supported_reasoning_levels.map((level) => level.effort), ["medium", "high", "xhigh"]);
  assert.equal(flash.multi_agent_version, "v1");
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
  const officialSlugs = JSON.parse(readFileSync(officialCatalogPath, "utf8")).models.map((model) => model.slug);
  const configPath = routerConfigPath(dir, "router-extra.json", [...officialSlugs, "deepseek-legacy"]);

  assert.throws(
    () => run({ cachePath, outPath, configPath }),
    /declares models missing from the catalog: deepseek-legacy/,
  );
});
