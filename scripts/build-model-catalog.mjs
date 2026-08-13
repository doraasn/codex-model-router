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

const officialDeepSeekPath = fileURLToPath(new URL("../config/deepseek-official-catalog.json", import.meta.url));
const officialDeepSeekCatalog = JSON.parse(await readFile(officialDeepSeekPath, "utf8"));
const deepSeekSlugs = ["deepseek-v4-pro", "deepseek-v4-flash"];
const officialDeepSeekModels = deepSeekSlugs.map((slug) => {
  const model = (officialDeepSeekCatalog.models || []).find((candidate) => candidate.slug === slug);
  if (!model) throw new Error(`DeepSeek official catalog is missing ${slug}`);
  return model;
});
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
const deepSeekModels = officialDeepSeekModels.map((officialModel) => {
  const model = structuredClone(officialModel);
  model.display_name = officialModel.slug === "deepseek-v4-pro" ? "DS-V4-Pro" : "DS-V4-Flash";
  model.supported_reasoning_levels = [];
  return model;
});

const preferredOrder = new Map([
  ["gpt-5.6-sol", 0],
  ["gpt-5.6-terra", 1],
  ["gpt-5.6-luna", 2],
  ["deepseek-v4-pro", 3],
  ["deepseek-v4-flash", 4],
]);

const models = catalog.models
  .filter((model) => !deepSeekSlugs.includes(model.slug))
  .map(normalizeModel)
  .map((model) => hiddenCompatibilityModels.has(model.slug)
    ? { ...model, visibility: "hide" }
    : model);
models.push(...deepSeekModels);
models.sort((left, right) => {
  const leftRank = preferredOrder.get(left.slug);
  const rightRank = preferredOrder.get(right.slug);
  if (leftRank !== undefined || rightRank !== undefined) {
    return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
  }
  const visibilityOrder = (left.visibility === "list" ? 0 : 1) - (right.visibility === "list" ? 0 : 1);
  return visibilityOrder || (left.priority ?? 999) - (right.priority ?? 999);
});
models.forEach((model, index) => {
  model.priority = index + 1;
});
await writeFile(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Wrote ${models.length} models to ${outputPath}\n`);
