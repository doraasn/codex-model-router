import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const restoreScript = join(projectDirectory, "scripts", "Restore-CodexOfficial.ps1");
const tempDirectory = join(projectDirectory, "temp");

async function fixture() {
  await mkdir(tempDirectory, { recursive: true });
  const root = await mkdtemp(join(tempDirectory, "restore-official-"));
  const codexHome = join(root, ".codex");
  const backupDirectory = join(root, "backups");
  const configPath = join(codexHome, "config.toml");
  await mkdir(codexHome, { recursive: true });
  const original = `model = "deepseek-v4-pro"
model_provider = "local_router"
model_catalog_json = "C:/Projects/codex-model-router/config/models.json"
model_reasoning_effort = "high"

[features]
web_search_request = true

[model_providers.local_router]
name = "GPT + DeepSeek"
base_url = "http://127.0.0.1:4010/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false

[model_providers.other]
name = "Preserved provider"
base_url = "https://example.invalid/v1"

[mcp_servers.example]
command = "example.exe"
`;
  await writeFile(configPath, original, "utf8");
  return { root, codexHome, backupDirectory, configPath, original };
}

function restore(
  { codexHome, backupDirectory, configPath },
  { dryRun = false, skipSessionMigration = true } = {},
) {
  const argumentsList = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", restoreScript,
    "-CodexHome", codexHome,
    "-ConfigPath", configPath,
    "-BackupDirectory", backupDirectory,
  ];
  if (skipSessionMigration) argumentsList.push("-SkipSessionMigration");
  if (dryRun) argumentsList.push("-DryRun");
  return execFileSync(
    "powershell.exe",
    argumentsList,
    { encoding: "utf8" },
  );
}

test("restores the built-in OpenAI provider without overwriting unrelated Codex settings", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));

  restore(paths);
  const restored = await readFile(paths.configPath, "utf8");
  assert.match(restored, /^model_provider = "openai"$/m);
  assert.doesNotMatch(restored, /^model\s*=/m);
  assert.doesNotMatch(restored, /^model_catalog_json\s*=/m);
  assert.doesNotMatch(restored, /^\[model_providers\.local_router\]$/m);
  assert.doesNotMatch(restored, /127\.0\.0\.1:4010/);
  assert.match(restored, /^model_reasoning_effort = "high"$/m);
  assert.match(restored, /^\[model_providers\.other\]$/m);
  assert.match(restored, /^\[mcp_servers\.example\]$/m);

  const backups = await readdir(paths.backupDirectory);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(paths.backupDirectory, backups[0]), "utf8"), paths.original);

  restore(paths);
  assert.deepEqual(await readdir(paths.backupDirectory), backups);
});

test("dry-run previews the official config without changing or backing up files", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));

  const output = restore(paths, { dryRun: true });
  assert.match(output, /model_provider = "openai"/);
  assert.equal(await readFile(paths.configPath, "utf8"), paths.original);
  await assert.rejects(readdir(paths.backupDirectory), { code: "ENOENT" });
});

test("restores local_router session labels to openai with backups", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));

  const sessionDirectory = join(paths.codexHome, "sessions", "2026", "08", "24");
  const sessionPath = join(sessionDirectory, "rollout-test.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-test", model_provider: "local_router" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    "utf8",
  );

  const statePath = join(paths.codexHome, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  state.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)")
    .run("thread-test", "local_router");
  state.close();

  restore(paths, { skipSessionMigration: false });

  const firstLine = (await readFile(sessionPath, "utf8")).split("\n", 1)[0];
  assert.equal(JSON.parse(firstLine).payload.model_provider, "openai");
  const restoredState = new DatabaseSync(statePath, { readOnly: true });
  assert.equal(
    restoredState.prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-test").model_provider,
    "openai",
  );
  restoredState.close();

  const backupEntries = await readdir(paths.backupDirectory, { withFileTypes: true });
  assert.equal(
    backupEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith("session-provider-migration-")).length,
    1,
  );
  assert.equal(
    backupEntries.filter((entry) => entry.isFile() && entry.name.startsWith("config.toml.official-restore.")).length,
    1,
  );
});
