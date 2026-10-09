import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
// Multi-agent collaboration surface stamped onto every model.
//   v1 (default): subagent tasks are delivered as plain user messages, which
//     every provider can consume (DeepSeek cannot read v2 encrypted_content).
//   v2: keep the upstream values untouched (OpenAI-backend encrypted delivery).
const multiAgentVersion = argument("--multi-agent", "v1");
if (multiAgentVersion !== "v1" && multiAgentVersion !== "v2") {
  throw new Error("--multi-agent must be v1 or v2");
}
const catalog = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  throw new Error("The Codex model cache contains no models");
}

const officialDeepSeekPath = fileURLToPath(new URL("../config/deepseek-official-catalog.json", import.meta.url));
const officialDeepSeekCatalog = JSON.parse(await readFile(officialDeepSeekPath, "utf8"));
// 官方基准文件即 DeepSeek 官方 Codex 接入页 models.json 的原文：模型增删只改这个文件，
// 生成脚本自动跟随（不再硬编码 slug 列表，避免目录、路由匹配、显示名再次各说各话）。
const officialDeepSeekModels = officialDeepSeekCatalog.models || [];
if (officialDeepSeekModels.length === 0) {
  throw new Error("DeepSeek official catalog contains no models");
}
const deepSeekSlugs = officialDeepSeekModels.map((model) => model.slug);
const hiddenCompatibilityModels = new Set([
  "codex-auto-review",
  // 5.6 Terra/Luna 与 5.5 已被 GPT-6 取代（5.5 官方 2026-10-14 从 Codex 退市），本地不再显示；
  // 5.6 Sol 保留显示（GPT-6 Sol 与它同档且更便宜，但账号侧不一定可用，两个都留着方便切换）。
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);
// 本地改名 / 隐藏覆盖：键为官方 slug，值覆盖面向 Codex 的 slug、显示名和可见性。
// 官方基准文件保持原文，改名只在本地目录生效；因此 router.config.json 必须同步
// modelAliases 把新 slug 映射回官方 slug，否则上游会收到 DeepSeek 不认识的模型名。
const localOverrides = new Map([
  ["deepseek-v4-pro", { slug: "deepseek-pro", display_name: "DeepSeek-Pro", visibility: "hide" }],
]);
// 目录里实际使用的 DeepSeek slug（改名后可能与官方 slug 不同），排序按它计算。
const deepSeekLocalSlugs = officialDeepSeekModels
  .map((model) => localOverrides.get(model.slug)?.slug || model.slug);

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

const codexReasoningLevelsByDeepSeekEffort = new Map([
  ["low", { effort: "medium", description: "Maps to DeepSeek low" }],
  ["high", { effort: "high", description: "Maps to DeepSeek high" }],
  ["max", { effort: "xhigh", description: "Maps to DeepSeek max" }],
]);
const codexDefaultReasoningByDeepSeekEffort = new Map([
  ["low", "medium"],
  ["high", "high"],
  ["max", "xhigh"],
]);

// 以 DeepSeek 官方目录为基准（完整 GPT-5 harness、freeform apply_patch、
// 官方上下文窗口等），覆盖显示名与 Codex 档位。只映射官方目录已声明的
// low/high/max 档位，不为单个模型补充官方未声明的档位。
const deepSeekModels = officialDeepSeekModels.map((officialModel) => {
  const model = structuredClone(officialModel);
  Object.assign(model, localOverrides.get(officialModel.slug));
  model.default_reasoning_level =
    codexDefaultReasoningByDeepSeekEffort.get(model.default_reasoning_level)
    || model.default_reasoning_level;
  model.supported_reasoning_levels = (model.supported_reasoning_levels || [])
    .map((level) => codexReasoningLevelsByDeepSeekEffort.get(level.effort))
    .filter(Boolean);
  return model;
});

// AstraHub 使用独立的本地 slug，避免与已有 DeepSeek 模型冲突；
// 仅复用现有 Codex 目录条目的代理能力，实际型号由路由别名映射。
// 图像能力按 AstraHub /v1/responses 实测填写：kimi-k3、deepseek-v4.1-flash
// 能正确识别图片内容；GLM-5.2 对图片返回错误答案，按纯文本模型处理。
// 档位按实测填写：none/minimal/low/medium/high/xhigh/max 均被接受，ultra 会被
// 网关拒绝（unknown type: ultra），因此只暴露 Codex 常用的 low→max 五档。
const astraHubReasoningLevels = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
];
const astraHubModels = [
  ["as-kimi-k3", "AS-kimi-k3", "kimi-k3", true],
  ["as-deepseek-v4.1-flash", "AS-deepseek-v4.1-flash", "deepseek-v4.1-flash", true],
  ["as-glm-5.2", "AS-GLM-5.2", "GLM-5.2", false],
].map(([slug, displayName, upstreamModel, supportsImage]) => ({
  ...structuredClone(deepSeekModels[1]),
  slug,
  display_name: displayName,
  description: `AstraHub ${upstreamModel}`,
  // 三个上游模型均公开标称 1M 上下文；AstraHub 未在 /v1/models 返回单独限额。
  context_window: 1000000,
  max_context_window: 1000000,
  input_modalities: supportsImage ? ["text", "image"] : ["text"],
  supports_image_detail_original: supportsImage,
  default_reasoning_level: "medium",
  supported_reasoning_levels: astraHubReasoningLevels.map((level) => ({ ...level })),
  visibility: "list",
}));

const preferredOrder = new Map([
  // 官方 2026-10-08 起把 gpt-6.1-sol 排在列表第一位，本地顺序跟随官方优先级
  ["gpt-6.1-sol", 0],
  ["gpt-6-astra", 1],
  ["gpt-6-sol", 2],
  ["gpt-6-luna", 3],
  ["gpt-5.6-sol", 4],
  // DeepSeek 条目排在 GPT 之后，顺序跟随官方目录
  ...deepSeekLocalSlugs.map((slug, index) => [slug, 5 + index]),
  ...astraHubModels.map((model, index) => [model.slug, 5 + deepSeekLocalSlugs.length + index]),
]);

const models = catalog.models
  .filter((model) => !deepSeekSlugs.includes(model.slug))
  .map(normalizeModel)
  .map((model) => hiddenCompatibilityModels.has(model.slug)
    ? { ...model, visibility: "hide" }
    : model);
models.push(...deepSeekModels);
models.push(...astraHubModels);

// GPT-6 家族（Astra / Sol / Luna，均为 1.05M 上下文）已官方发布，但本机 models_cache.json
// 迟迟未收录（桌面端模型列表实时来自服务端、不落盘）。缓存收录之前，以同档 5.6 条目为模板、
// 按官方模型页规格合成目录条目；缓存一旦收录，下方过滤会去重并由官方条目接管。
// 规格来源：https://developers.openai.com/api/docs/models/gpt-6-sol （1.05M 上下文与档位）、
// https://learn.chatgpt.com/docs/models （默认档位：Sol=medium、Luna=high、Astra=low；Luna 支持到 Max、不支持 Ultra）。
const gpt6Specs = [
  {
    slug: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "Our most capable model, built for the hardest end-to-end work",
    templateSlug: "gpt-5.6-sol",
    defaultReasoningLevel: "low",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    slug: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    description: "Built to power complex coding and agentic workflows",
    templateSlug: "gpt-5.6-sol",
    defaultReasoningLevel: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    slug: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    description: "Our most efficient model for focused, high-volume tasks",
    templateSlug: "gpt-5.6-luna",
    defaultReasoningLevel: "high",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
];
const cacheSlugs = new Set(catalog.models.map((model) => model.slug));
for (const spec of gpt6Specs) {
  if (cacheSlugs.has(spec.slug)) continue;
  const template = catalog.models.find((model) => model.slug === spec.templateSlug);
  if (!template) throw new Error(`${spec.templateSlug} missing from cache; cannot synthesize ${spec.slug}`);
  const gpt6Model = structuredClone(normalizeModel(template));
  gpt6Model.slug = spec.slug;
  gpt6Model.display_name = spec.displayName;
  gpt6Model.description = spec.description;
  gpt6Model.supported_reasoning_levels = (gpt6Model.supported_reasoning_levels || [])
    .filter((level) => spec.supportedEfforts.includes(level.effort));
  gpt6Model.default_reasoning_level = spec.defaultReasoningLevel;
  gpt6Model.context_window = 1050000;
  gpt6Model.max_context_window = 1050000;
  models.push(gpt6Model);
}
// 去重兜底：缓存已收录 GPT-6 条目时，上面不会再合成；此处防御未来重复。
const seenSlugs = new Set();
const dedupedModels = models.filter((model) => {
  if (seenSlugs.has(model.slug)) return false;
  seenSlugs.add(model.slug);
  return true;
});
models.length = 0;
models.push(...dedupedModels);

// Stamp the collaboration surface. v1 applies to every model so parent and
// child sessions always share one plaintext surface; v2 keeps upstream pins.
if (multiAgentVersion === "v1") {
  for (const model of models) {
    model.multi_agent_version = "v1";
  }
}

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

// 防漂移校验（可用 --router-config 指向其它配置做测试）：目录里的每个模型都必须能被
// router.config.json 的某个 provider 匹配，provider 精确声明的模型也必须存在于目录里。
// 否则 Codex 选到该模型会被路由直接判 unsupported_model —— 历史故障就是生成脚本产出
// deepseek-v4-*，而路由只认 deepseek-flash。
const routerConfigPath = resolve(
  argument("--router-config", fileURLToPath(new URL("../config/router.config.json", import.meta.url))),
);
const routerConfig = JSON.parse(await readFile(routerConfigPath, "utf8"));
const providers = Array.isArray(routerConfig.providers) ? routerConfig.providers : [];
const unroutableSlugs = models
  .map((model) => model.slug)
  .filter((slug) => !providers.some((provider) => {
    const match = provider.match || {};
    const exact = Array.isArray(match.models) ? match.models : [];
    const prefixes = Array.isArray(match.prefixes) ? match.prefixes : [];
    return exact.includes(slug) || prefixes.some((prefix) => slug.startsWith(prefix));
  }));
if (unroutableSlugs.length > 0) {
  throw new Error(`router config ${routerConfigPath} cannot route: ${unroutableSlugs.join(", ")}`);
}
const missingFromCatalog = providers
  .flatMap((provider) => (provider.match && Array.isArray(provider.match.models) ? provider.match.models : []))
  .filter((slug) => !models.some((model) => model.slug === slug));
if (missingFromCatalog.length > 0) {
  throw new Error(`router config ${routerConfigPath} declares models missing from the catalog: ${missingFromCatalog.join(", ")}`);
}
// modelAliases 的目标必须是已知模型名（本地目录 slug 或官方 DeepSeek slug）。写错时
// 上游会收到一个不存在的模型名并在远端报错，很难定位，所以在这里直接拦下。
const knownSlugs = new Set([
  ...models.map((model) => model.slug),
  ...deepSeekSlugs,
  "kimi-k3", "deepseek-v4.1-flash", "GLM-5.2",
]);
const unknownAliasTargets = providers
  .flatMap((provider) => (provider.modelAliases && typeof provider.modelAliases === "object"
    ? Object.values(provider.modelAliases)
    : []))
  .filter((target) => typeof target !== "string" || !knownSlugs.has(target));
if (unknownAliasTargets.length > 0) {
  throw new Error(`router config ${routerConfigPath} has unknown modelAliases targets: ${unknownAliasTargets.join(", ")}`);
}

await writeFile(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

// 与目录一起生成元信息（同样提交进仓库）：回答"这份模型列表是什么时候、按哪个官方版本抓的"。
const metaPath = resolve(argument("--meta-output", join(dirname(outputPath), "models.meta.json")));
const visibleModels = models.filter((model) => model.visibility === "list").map((model) => model.slug);
await writeFile(metaPath, `${JSON.stringify({
  generated_at: new Date().toISOString(),
  official_fetched_at: typeof catalog.fetched_at === "string" ? catalog.fetched_at : null,
  official_client_version: typeof catalog.client_version === "string" ? catalog.client_version : null,
  multi_agent_version: multiAgentVersion,
  model_count: models.length,
  visible_models: visibleModels,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

process.stdout.write(
  `Wrote ${models.length} models to ${outputPath} (multi_agent_version=${multiAgentVersion}, route check ok)\n`
  + `Wrote catalog metadata to ${metaPath} (visible: ${visibleModels.join(", ")})\n`,
);
