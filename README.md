# Codex GPT + DeepSeek 本地模型路由器

## 文档定位

本文档面向 AI 代理与自动化流程，作为本仓库的部署与运维规范。按顺序执行各步骤即可完成部署、配置、验证与回滚。所有命令在 Windows PowerShell 中运行；`%USERPROFILE%` 是 Codex 配置目录 `%USERPROFILE%\.codex` 的父路径，AI 代理在运行时必须将其解析为实际用户目录，禁止写死具体用户名或盘符。

本仓库支持环境：Windows + 微软商店版 ChatGPT（Codex 桌面端）。其他安装渠道或版本仅供参考，不保证生效。

## 架构

- 路由器仅监听 `127.0.0.1:4010`，只接受 `POST /v1/responses`、`POST /responses` 与 `GET /healthz`。
- 按请求体 `model` 字段路由：`gpt-*` / `codex-*` 转发到 ChatGPT Codex 后端（沿用 `%USERPROFILE%\.codex\auth.json` 登录态）；`deepseek-v4-pro` / `deepseek-v4-flash` 转发到 DeepSeek Responses API（凭据来自环境变量 `DEEPSEEK_API_KEY`）。
- GPT 路由执行历史兼容清洗：第三方历史条目 id 规范化到官方类型前缀（`msg_`/`rs_`/`fc_`/`fco_`/`ctc_`/`ctco_`/`ws_`），`reasoning.content` 中的推理文本迁移到 `summary` 并清空 `content`。
- DeepSeek 路由执行两项转换，其余字段原样透传：无论请求原档位为何或是否携带档位，都强制使用官方 `max`；删除 `service_tier` / `serviceTier`（DeepSeek 无服务档位概念）。
- 模型目录以 DeepSeek 官方 Codex 条目为基准（[config/deepseek-official-catalog.json](config/deepseek-official-catalog.json)），构建时清空推理档位列表，使 DeepSeek 不显示档位选择；实际请求由路由器固定为官方 `max`。

## 前置条件

- Windows 10/11；Node.js 22.5+；Codex 0.144.0+
- Codex 已通过 ChatGPT 登录（`codex login` 或桌面端登录），保证 `auth.json` 存在
- 一个新的 DeepSeek API Key

当前声明 DeepSeek 官方支持的 `deepseek-v4-pro` 与 `deepseek-v4-flash`。两者均不显示推理档位选择，路由固定使用官方 `max`。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/server.mjs` | 路由、历史清洗、档位与 service tier 转换 |
| `src/config.mjs` | 读取 `config/router.config.json` 并校验 |
| `config/router.config.json` | 端口、上游地址、模型与路由前缀配置 |
| `config/codex-config-snippet.toml` | Codex 配置片段（`model`、`model_provider`、`[model_providers.local_router]`） |
| `config/deepseek-official-catalog.json` | DeepSeek 官方 Codex 模型条目（基准，勿手改字段语义） |
| `scripts/build-model-catalog.mjs` | 合并本机 GPT 模型与 DeepSeek 条目，输出 `config/models.json` |
| `scripts/Setup-Codex.ps1` | 自动备份并合并 Codex 配置 |
| `scripts/migrate-sessions.mjs` | 迁移历史会话的 `model_provider` 标签 |
| `scripts/Start-Router.ps1` / `Start-Background.ps1` / `Stop-Router.ps1` / `Test-Router.ps1` | 路由器启停与健康检查 |
| `scripts/Enable-Autostart.ps1` / `enable-autostart.bat` | 注册当前用户登录后自动启动路由器 |
| `start-router.bat` | 根目录入口：已运行则自动重启，未运行则后台启动 |

## 部署步骤

### 1. 生成合并模型目录

```powershell
node .\scripts\build-model-catalog.mjs
```

读取 `%USERPROFILE%\.codex\models_cache.json`，保留当前 GPT 模型并加入 DeepSeek Pro/Flash，输出到 `config\models.json`。模型顺序固定为 Sol、Terra、Luna、Pro、Flash，其余模型随后按原优先级排列。该文件已被 Git 忽略，每台机器需自行生成；若 `models_cache.json` 不存在，先启动一次 Codex 再退出，然后重跑。

### 2. 保存 DeepSeek Key（明文）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Set-DeepSeekKey.ps1
```

Key 明文保存在 `secrets\deepseek-key.txt`（Git 忽略），换机器直接复制该文件。也可以手动创建该文件并写入 Key。

### 3. 启动路由器

根目录入口（推荐）：双击 `start-router.bat`。脚本先停止已运行实例（没有则跳过），再后台启动新实例；启动失败时暂停显示错误并指向 `logs\router.err.log`。

等价命令：

```powershell
npm run start:bg
```

前台启动（便于查看日志）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Router.ps1
```

健康检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Router.ps1
```

代码更新后必须手动重启路由器才生效。

#### 登录后自动启动（可选）

双击 `scripts\enable-autostart.bat`，或执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Enable-Autostart.ps1
```

脚本会在当前用户的 Windows 登录启动项中注册 `CodexModelRouter`，随后立即启动路由并执行健康检查。无需管理员权限，重复运行会覆盖原启动项且不会创建重复路由进程。

### 4. 配置 Codex

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-Codex.ps1
```

脚本自动备份原配置到 `backups\config.toml.<时间戳>.bak`，把 `config\codex-config-snippet.toml` 的顶层字段与 `[model_providers.local_router]` 段合并进 `%USERPROFILE%\.codex\config.toml`；`model_catalog_json` 自动填入本机实际安装路径；保留原有 MCP/插件/沙箱设置；重复运行幂等。`-DryRun` 只预览，`-Force` 重新应用。

合并后的关键配置：

```toml
model = "gpt-5.6-sol"
model_provider = "local_router"
model_catalog_json = "<项目绝对路径>/config/models.json"

[model_providers.local_router]
name = "GPT + DeepSeek"
base_url = "http://127.0.0.1:4010/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

手动合并时替换 `<项目绝对路径>`。完成后完全退出并重新打开 Codex 桌面端。

### 5. 迁移历史会话

此步骤为部署必做项，无旧会话时脚本会自然报告 0 条，无需跳过。原因：续聊列表按会话的 `model_provider` 分抽屉，新配置为 `local_router`，旧会话（`openai`）不迁移则不可见。

先完全退出 Codex 桌面端和 CLI，然后：

```powershell
node .\scripts\migrate-sessions.mjs --dry-run
node .\scripts\migrate-sessions.mjs
```

脚本处理 `%USERPROFILE%\.codex\sessions\` 与 `archived_sessions\` 下 JSONL 第一行的 `session_meta.model_provider`，以及 `state_5.sqlite` 的 `threads.model_provider`；修改前自动备份到 `backups\session-provider-migration-<时间戳>\`；幂等。

参数：

```text
--codex-home <路径>   指定 Codex 配置目录（默认 %USERPROFILE%\.codex）
--from <标签>         源 provider 标签（默认 openai）
--to <标签>           目标 provider 标签（默认 local_router）
--dry-run             只统计和列出，不修改
```

迁移完成后重新打开 Codex。

### 6. 验证

- 健康检查：`Test-Router.ps1`，或访问 http://127.0.0.1:4010/healthz
- 模型列表前五项依次为 Sol、Terra、Luna、`DS-V4-Pro`、`DS-V4-Flash`；DeepSeek 不提供推理档位选择（始终调用官方 max）
- 发送消息后查看 `logs\router.out.log`（前台模式）：GPT 请求 `route=chatgpt`，DeepSeek 请求 `route=deepseek`，状态 200
- 4010 端口被占用：更换端口后同步修改 `config\router.config.json` 与 Codex 配置中的 `base_url`

### 7. 停止 / 恢复

停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-Router.ps1
```

恢复官方配置：把 `backups\config.toml.<时间戳>.bak` 还原到 `%USERPROFILE%\.codex\config.toml`，重启 Codex。`auth.json` 未被修改，无需重新登录。

## 安全边界

- 只监听 `127.0.0.1`；拒绝绑定非回环地址
- GPT 请求不携带 DeepSeek Key；DeepSeek 请求不转发 ChatGPT 认证或账户头
- 日志只含路由名、模型、HTTP 状态和耗时，不含请求/响应正文
- DeepSeek Key 明文存放于 `secrets\`（Git 忽略），注意访问权限
- 未配置 Key 时 DeepSeek 返回 503；未知模型直接 400

## 本地测试

```powershell
npm test
```

共 7 项测试：凭据隔离、DeepSeek 强制 max、service tier 剥离、推理清洗、id 规范化、未知模型拒绝、凭据缺失 fail closed。测试使用本地模拟上游，不访问真实 API。
