// 把 Codex 历史会话的 model_provider 从旧标签（默认 openai）批量改成 local_router，
// 让使用本地路由器的会话在 codex resume 续聊列表中保持可见。
// 使用方式：
//   node scripts/migrate-sessions.mjs            # 迁移（先完全退出 Codex）
//   node scripts/migrate-sessions.mjs --dry-run  # 只统计，不做任何修改
//   node scripts/migrate-sessions.mjs --from deepseek --to local_router
// 所有被修改的数据会先备份到 backups/session-provider-migration-<时间戳>/。
import { mkdir, readdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("此脚本依赖 Node.js 内置 SQLite 支持，需要 Node.js 22.5 或更高版本（建议 Node 24）。");
  process.exit(1);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userProfile = process.env.USERPROFILE;
if (!userProfile) {
  console.error("USERPROFILE is not set.");
  process.exit(1);
}

const codexHome = resolve(argument("--codex-home", `${userProfile}/.codex`));
const fromLabel = argument("--from", "openai");
const toLabel = argument("--to", "local_router");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

const sessionsDirectory = join(codexHome, "sessions");
const archivedDirectory = join(codexHome, "archived_sessions");
const stateDbCandidate = join(codexHome, "state_5.sqlite");
const legacyStateDbCandidate = join(codexHome, "state", "state_5.sqlite");

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonlFiles(directory) {
  const results = [];
  if (!(await pathExists(directory))) return results;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectJsonlFiles(fullPath)));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

// 只替换第一行 session_meta 里的 model_provider 字段值，其余内容保持原样。
function rewriteFirstLine(line, fromValue, toValue) {
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    return null; // 第一行不是合法 JSON，跳过
  }
  if (!header || header.type !== "session_meta" || header.payload?.model_provider !== fromValue) {
    return null;
  }
  const pattern = /("model_provider"\s*:\s*)"[^"]*"/;
  if (!pattern.test(line)) return null;
  return line.replace(pattern, `$1${JSON.stringify(toValue)}`);
}

function timestampForDirectory() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
}

async function main() {
  const stateDb = (await pathExists(stateDbCandidate)) ? stateDbCandidate : legacyStateDbCandidate;
  if (!(await pathExists(stateDb))) {
    console.error(`未找到会话状态数据库：${stateDbCandidate}（或 ${legacyStateDbCandidate}）。`);
    console.error("请确认 --codex-home 指向真实的 Codex 配置目录。");
    process.exit(1);
  }

  if (!dryRun && existsSync(`${stateDb}-wal`) && !force) {
    console.error("检测到 Codex 可能正在运行（存在 state_5.sqlite-wal）。");
    console.error("请先完全退出 Codex 桌面端/CLI，再运行迁移；确需在线执行请加 --force。");
    process.exit(1);
  }

  const jsonlFiles = [
    ...(await collectJsonlFiles(sessionsDirectory)),
    ...(await collectJsonlFiles(archivedDirectory)),
  ].sort();

  const pending = [];
  for (const file of jsonlFiles) {
    const text = await readFile(file, "utf8");
    const firstNewline = text.indexOf("\n");
    const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
    const rewritten = rewriteFirstLine(firstLine, fromLabel, toLabel);
    if (rewritten !== null) {
      pending.push({ file, originalFirstLine: firstLine, rewrittenFirstLine: rewritten });
    }
  }

  let sqliteRowsBefore = 0;
  {
    const db = new DatabaseSync(stateDb, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM threads WHERE model_provider = ?",
      ).get(fromLabel);
      sqliteRowsBefore = Number(row.n);
    } finally {
      db.close();
    }
  }

  console.log(`Codex 目录：${codexHome}`);
  console.log(`迁移方向：${fromLabel} -> ${toLabel}`);
  console.log(`待迁移 JSONL：${pending.length} 个文件`);
  console.log(`SQLite 中待迁移会话：${sqliteRowsBefore} 条`);

  if (dryRun) {
    for (const item of pending) {
      console.log(`  [dry-run] ${relative(codexHome, item.file)}`);
    }
    console.log("dry-run 完成，未做任何修改。");
    return;
  }

  if (pending.length === 0 && sqliteRowsBefore === 0) {
    console.log("没有需要迁移的会话，未做任何修改。");
    return;
  }

  // 1. 备份：JSONL 全部复制 + SQLite 一致性快照 + meta.json
  const stamp = timestampForDirectory();
  const backupRoot = join(projectDirectory, "backups", `session-provider-migration-${stamp}`);
  const backupJsonlRoot = join(backupRoot, "jsonl");
  const backupStatePath = join(backupRoot, "state", "state_5.sqlite");
  await mkdir(join(backupRoot, "state"), { recursive: true });

  for (const file of jsonlFiles) {
    const relativePath = relative(codexHome, file);
    const destination = join(backupJsonlRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }

  {
    const db = new DatabaseSync(stateDb, { readOnly: true });
    try {
      const snapshot = backupStatePath.replaceAll("\\", "/").replace(/'/g, "''");
      db.exec(`VACUUM INTO '${snapshot}'`);
    } finally {
      db.close();
    }
  }

  // 2. 修改 JSONL 第一行
  let migratedJsonl = 0;
  for (const item of pending) {
    const text = await readFile(item.file, "utf8");
    const firstNewline = text.indexOf("\n");
    const tail = firstNewline === -1 ? "" : text.slice(firstNewline);
    await writeFile(item.file, `${item.rewrittenFirstLine}${tail}`, "utf8");
    migratedJsonl += 1;
  }

  // 3. 修改 SQLite threads 表
  const db = new DatabaseSync(stateDb);
  let sqliteRowsAfter = 0;
  try {
    db.exec("BEGIN");
    const result = db.prepare(
      "UPDATE threads SET model_provider = ? WHERE model_provider = ?",
    ).run(toLabel, fromLabel);
    sqliteRowsAfter = Number(result.changes);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  // 4. 记录迁移元信息
  await writeFile(
    join(backupRoot, "meta.json"),
    `${JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        codexHome,
        sourceLabel: fromLabel,
        targetLabel: toLabel,
        migratedJsonlFiles: migratedJsonl,
        sqliteRowsBefore,
        sqliteRowsUpdated: sqliteRowsAfter,
        backupJsonlDir: backupJsonlRoot,
        backupStateFile: backupStatePath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`已修改 JSONL：${migratedJsonl} 个文件`);
  console.log(`已修改 SQLite：${sqliteRowsAfter} 条会话`);
  console.log(`备份位置：${backupRoot}`);
  console.log("迁移完成。重新打开 Codex 后，历史会话应出现在续聊列表中。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
