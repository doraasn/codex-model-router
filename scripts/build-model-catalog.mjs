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
  model.default_reasoning_level =
    codexDefaultReasoningByDeepSeekEffort.get(model.default_reasoning_level)
    || model.default_reasoning_level;
  model.supported_reasoning_levels = (model.supported_reasoning_levels || [])
    .map((level) => codexReasoningLevelsByDeepSeekEffort.get(level.effort))
    .filter(Boolean);
  return model;
});

const preferredOrder = new Map([
  ["gpt-6-astra", 0],
  ["gpt-5.6-sol", 1],
  ["gpt-5.6-terra", 2],
  ["gpt-5.6-luna", 3],
  // DeepSeek 条目排在 GPT 之后，顺序跟随官方目录
  ...deepSeekSlugs.map((slug, index) => [slug, 4 + index]),
]);

const models = catalog.models
  .filter((model) => !deepSeekSlugs.includes(model.slug))
  .map(normalizeModel)
  .map((model) => hiddenCompatibilityModels.has(model.slug)
    ? { ...model, visibility: "hide" }
    : model);
models.push(...deepSeekModels);

// GPT-6 Astra 已官方发布（旗舰，1.05M 上下文），但本机 models_cache.json 迟迟未收录
// （桌面端模型列表实时来自服务端、不落盘）。缓存收录之前，以 gpt-5.6-sol 条目为模板、
// 按官方文档规格合成目录条目；缓存一旦收录，下方过滤会去重并由官方条目接管。
const cacheHasAstra = catalog.models.some((model) => model.slug === "gpt-6-astra");
if (!cacheHasAstra) {
  const solEntry = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
  if (!solEntry) throw new Error("gpt-5.6-sol missing from cache; cannot synthesize gpt-6-astra");
  const astra = structuredClone(normalizeModel(solEntry));
  astra.slug = "gpt-6-astra";
  astra.display_name = "GPT-6 Astra";
  astra.description = "Our most capable model, built for the hardest end-to-end work";
  astra.supported_reasoning_levels = (astra.supported_reasoning_levels || []).filter(
    (level) => ["low", "medium", "high", "xhigh", "max"].includes(level.effort),
  );
  astra.default_reasoning_level = "high";
  astra.context_window = 1050000;
  astra.max_context_window = 1050000;
  models.push(astra);
}
// 去重兜底：缓存已收录 astra 时，上面不会再合成；此处防御未来重复。
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

await writeFile(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(
  `Wrote ${models.length} models to ${outputPath} (multi_agent_version=${multiAgentVersion}, route check ok)\n`,
);
