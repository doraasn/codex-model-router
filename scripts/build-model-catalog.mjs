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

const deepSeek = structuredClone(template);
Object.assign(deepSeek, {
  slug: "deepseek-v4-flash",
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text",
  input_modalities: ["text"],
  supports_image_detail_original: false,
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: "v2",
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  auto_review_model_override: null,
  context_window: 1048576,
  max_context_window: 1048576,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  comp_hash: "3000",
  reasoning_summary_format: "experimental",
  default_reasoning_summary: "none",
  display_name: "DeepSeek-V4-Flash",
  description: "Latest frontier agentic coding model.",
  default_reasoning_level: "high",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "high", description: "Extra high reasoning depth for complex problems" },
    { effort: "max", description: "Maximum reasoning depth for the hardest problems" }
  ],
  shell_type: "shell_command",
  visibility: "list",
  minimal_client_version: "0.144.0",
  supported_in_api: true,
  availability_nux: null,
  upgrade: null,
  priority: 1,
  experimental_supported_tools: [],
  supports_search_tool: true,
  supports_reasoning_summaries: true,
  default_service_tier: null,
});

const models = catalog.models
  .filter((model) => model.slug !== deepSeek.slug)
  .map(normalizeModel)
  .map((model) => hiddenCompatibilityModels.has(model.slug)
    ? { ...model, visibility: "hide" }
    : model);
models.push(deepSeek);
await writeFile(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Wrote ${models.length} models to ${outputPath}\n`);
