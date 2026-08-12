import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const userProfile = process.env.USERPROFILE;
if (!userProfile) throw new Error("USERPROFILE is not set");

const sourcePath = resolve(argument("--source", `${userProfile}/.codex/models_cache.json`));
const defaultOutputPath = fileURLToPath(new URL("../config/models.json", import.meta.url));
const outputPath = resolve(argument("--output", defaultOutputPath));
const catalog = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  throw new Error("The Codex model cache contains no models");
}

const template = catalog.models.find((model) => model.slug === "gpt-5.6-sol") || catalog.models[0];
const officialDeepSeekPath = fileURLToPath(new URL("../config/deepseek-official-catalog.json", import.meta.url));
const officialDeepSeekCatalog = JSON.parse(await readFile(officialDeepSeekPath, "utf8"));
const officialFlash = (officialDeepSeekCatalog.models || []).find(
  (model) => model.slug === "deepseek-v4-flash",
);
if (!officialFlash) {
  throw new Error("DeepSeek official catalog is missing deepseek-v4-flash");
}
const hiddenCompatibilityModels = new Set([
  "codex-auto-review",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

function normalizeModel(model) {
  return {
    ...model,
    supports_reasoning_summaries: model.supports_reasoning_summaries ?? true,
    default_service_tier: model.default_service_tier ?? null,
    minimal_client_version: model.minimal_client_version ?? "0.144.0",
    auto_review_model_override: model.auto_review_model_override ?? null,
    auto_compact_token_limit: model.auto_compact_token_limit ?? null,
  };
}

// 以 DeepSeek 官方目录为基准（完整 GPT-5 harness、freeform apply_patch、
// 官方上下文窗口等），覆盖两个有意调整的字段：显示名简化，以及不向 Codex
// 暴露推理档位选择。路由器会在 DeepSeek 路线上无条件使用官方 max。
const deepSeek = structuredClone(officialFlash);
deepSeek.display_name = "DS-V4-Flash";
deepSeek.supported_reasoning_levels = [];

const models = catalog.models
  .filter((model) => model.slug !== deepSeek.slug)
  .map(normalizeModel)
  .map((model) => hiddenCompatibilityModels.has(model.slug)
    ? { ...model, visibility: "hide" }
    : model);
models.push(deepSeek);
await writeFile(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Wrote ${models.length} models to ${outputPath}\n`);
