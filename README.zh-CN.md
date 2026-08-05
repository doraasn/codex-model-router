# Codex GPT + DeepSeek 本地模型路由器

这个项目让 Codex 使用一个本机 Responses API 地址，并按模型名称把请求转发到：

- `gpt-*` / `codex-*`：ChatGPT Codex 后端，沿用 Codex 提供的 ChatGPT 登录认证。
- `deepseek-v4-flash`：DeepSeek 官方 Responses API，使用单独的 DeepSeek API Key。

路由器无第三方运行时依赖，只监听 `127.0.0.1`，不记录请求头、请求正文或响应正文。

## 前置条件

- Windows 10/11
- Node.js 22.5 或更高版本（历史会话迁移脚本依赖 Node 内置 SQLite 支持）
- Codex CLI 0.144.0 或更高版本
- Codex 已通过 ChatGPT 登录（路由的 GPT 请求沿用这份登录态；配置路由器前先运行一次 `codex login` 或用 Codex 桌面端完成登录）
- 一个新的 DeepSeek API Key

DeepSeek 当前只声明 `deepseek-v4-flash` 可用于 Codex。不要在官方宣布支持前手动开启 `deepseek-v4-pro`。

## 安装目录

推荐放在：

```text
C:\Projects\codex-model-router
```

如果当前项目不在该目录，可在当前项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-To-CProjects.ps1
```

脚本在目标已经存在时会拒绝覆盖，并在复制完成后生成合并模型目录。

## 一、生成合并模型目录

在项目目录运行：

```powershell
node .\scripts\build-model-catalog.mjs
```

脚本读取 `%USERPROFILE%\.codex\models_cache.json`，保留当前 GPT 模型，并加入 DeepSeek-V4-Flash，输出到 `config\models.json`。建议在新机器上重新运行一次，让模型列表匹配该机器的客户端版本。

## 二、保存 DeepSeek Key（明文）

先在 DeepSeek 控制台轮换任何曾经粘贴到聊天或日志中的 Key，然后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Set-DeepSeekKey.ps1
```

Key 以明文保存在 `secrets\deepseek-key.txt`，该目录已被 Git 忽略。请把这个文件当作机密对待，不要分享或提交；换机器时直接复制该文件即可，不依赖当前用户或机器。也可以手动创建该文件、把 Key 作为第一行内容写入。

## 三、启动路由器

后台启动（推荐，双击即可）：

```text
start-router.bat
```

或者在项目目录运行：

```powershell
npm run start:bg
```

前台启动（便于查看日志）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Router.ps1
```

另开一个终端检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Router.ps1
```

路由器进程由用户自己启停；代码更新后需要手动重启路由器才会生效。

## 四、配置 Codex

推荐用自动脚本合并配置（自动备份、合并、校验，重复运行是幂等的）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-Codex.ps1
```

脚本会把 `config\codex-config-snippet.toml` 中的顶层字段和 provider 段合并到 `%USERPROFILE%\.codex\config.toml`，保留原有 MCP、插件、沙箱和项目设置，并把原配置备份到 `backups\config.toml.<时间戳>.bak`。想先看效果可以加 `-DryRun`；已经配置过时会提示并跳过，用 `-Force` 可重新应用。

手动合并也可以，合并后应包含：

```toml
model = "gpt-5.6-sol"
model_provider = "local_router"
model_catalog_json = "C:/Projects/codex-model-router/config/models.json"

[model_providers.local_router]
name = "GPT + DeepSeek"
base_url = "http://127.0.0.1:4010/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

确认 `model_catalog_json` 指向的路径与实际安装目录一致，然后完全退出并重新打开 Codex 桌面端。模型列表中应同时出现 GPT 模型和 `DeepSeek-V4-Flash`。

## 五、迁移历史会话（可选，带旧会话时才需要）

Codex 的续聊列表按会话里记录的 `model_provider` 分抽屉。新配置把 provider 指向 `local_router`，而旧会话记录的是 `openai`（或官方脚本写过的其他标签），所以旧会话会留在另一个抽屉里、看起来"消失了"。如果新环境带着旧会话并且想继续在续聊列表里看到它们，需要把旧会话的 `model_provider` 批量改成 `local_router`。

项目提供了迁移脚本，会同时处理：

- `%USERPROFILE%\.codex\sessions\`（按日期分层的会话 JSONL，只改第一行 `session_meta`）
- `%USERPROFILE%\.codex\archived_sessions\`（归档会话 JSONL）
- `%USERPROFILE%\.codex\state_5.sqlite`（`threads` 表的 `model_provider` 字段）

步骤：

1. 完全退出 Codex 桌面端和 CLI（脚本会检测 SQLite 的 WAL 文件，发现 Codex 正在运行时会拒绝执行）。
2. 先预览将要修改的内容（只读，不改任何数据）：

```powershell
node .\scripts\migrate-sessions.mjs --dry-run
```

3. 执行迁移（自动先备份，再修改）：

```powershell
node .\scripts\migrate-sessions.mjs
```

4. 重新打开 Codex，旧会话应出现在续聊列表中。

脚本会把修改前的全部会话文件和 SQLite 快照备份到 `backups\session-provider-migration-<时间戳>\`，确认无误后可以保留或删除该备份。脚本是幂等的：已经迁移过的会话不会被重复处理。

常用参数：

```text
--codex-home <路径>   指定 Codex 配置目录（默认 %USERPROFILE%\.codex）
--from <标签>         源 provider 标签（默认 openai）
--to <标签>           目标 provider 标签（默认 local_router）
--dry-run             只统计和列出，不做任何修改
--force               跳过"Codex 正在运行"检查（不推荐）
```

全新环境没有旧会话时，这一步可以直接跳过。

## 六、验证配置是否生效

- 检查路由器健康：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Router.ps1`，或直接访问 http://127.0.0.1:4010/healthz。
- 重新打开 Codex 桌面端，模型列表应同时出现 GPT 模型和 `DeepSeek-V4-Flash`。
- 新建任务发一条消息，查看 `logs\router.out.log`（前台启动时）：`gpt-*` 请求对应 `route=chatgpt`，`deepseek-v4-flash` 对应 `route=deepseek`，状态应为 200。
- 如果 `%USERPROFILE%\.codex\models_cache.json` 不存在（这台机器从没运行过 Codex），先启动一次 Codex 再退出，然后重新执行第一步生成模型目录。
- 如果 4010 端口被其他程序占用，路由器无法启动，先在任务管理器中确认占用进程，或换用其他端口（需同步修改 `config\router.config.json` 和 Codex 配置中的 `base_url`）。

## 七、停止路由器 / 恢复官方配置

停止路由器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-Router.ps1
```

恢复官方配置：把配置时生成的备份复制回 `%USERPROFILE%\.codex\config.toml`（例如 `backups\config.toml.<时间戳>.bak` 或手动备份的 `config.toml.before-model-router`），然后重启 Codex。`auth.json`（ChatGPT 登录态）从未被改动，恢复后无需重新登录。

## 关于同一任务中切换模型

模型选择器共存和新任务选择可以通过上述配置实现。同一条长任务在 GPT 与 DeepSeek 之间切换时，会话历史里会包含提供方专属的 reasoning 数据（DeepSeek 把推理文本放在 `reasoning.content` 中）。路由器在转发给 ChatGPT 后端前，会把 `reasoning_text` 统一转换到 `summary` 并清空 `content`，同时把第三方历史条目的 id 规范到官方要求的类型前缀（`msg_`/`rs_`/`fc_`/`ctc_`/`ws_` 等），因此切回 GPT 续聊不会再触发 400；DeepSeek 路由的请求保持原样透传，不受影响。

## 安全边界

- 服务拒绝绑定非回环地址。
- GPT 请求保留 ChatGPT 认证头，但绝不会使用 DeepSeek Key。
- DeepSeek 请求只发送 DeepSeek Key，不转发 ChatGPT 认证或账户头。
- DeepSeek Key 以明文存放在 `secrets\deepseek-key.txt`（已被 Git 忽略），请限制该目录的访问权限并妥善保管。
- 前台日志只包含路由名称、模型、HTTP 状态和耗时；后台模式不写请求日志。
- 只接受 `/v1/responses`、`/responses` 和 `/healthz`。
- 未配置 DeepSeek Key 时，DeepSeek 请求返回 503。
- 未识别模型会被拒绝，不会猜测上游。

## 本地测试

```powershell
npm test
```

测试使用两个本地模拟上游，验证 GPT Token 不会进入 DeepSeek 路线、DeepSeek Key 不会进入 GPT 路线，并验证未知模型被拒绝。测试不会访问真实 API。
