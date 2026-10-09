# Codex 多供应商本地模型路由器（GPT / DeepSeek / AstraHub）

## 文档定位

本文档面向 AI 代理与自动化流程，作为本仓库的部署与运维规范。按顺序执行各步骤即可完成部署、配置、验证与回滚。所有命令在 Windows PowerShell 中运行；`%USERPROFILE%` 是 Codex 配置目录 `%USERPROFILE%\.codex` 的父路径，AI 代理在运行时必须将其解析为实际用户目录，禁止写死具体用户名或盘符。

本仓库支持环境：Windows + 微软商店版 ChatGPT（Codex 桌面端）。其他安装渠道或版本仅供参考，不保证生效。

## 架构

- 路由器仅监听 `127.0.0.1:4010`，只接受 `POST /v1/responses`、`POST /responses` 与 `GET /healthz`。
- 按 `config/router.config.json` 的 `providers` 列表路由：请求体 `model` 先精确匹配 `match.models`，再按 `match.prefixes` 前缀匹配，命中哪个 provider 就转发到哪个 `baseUrl`。内置三个 provider：`chatgpt`（沿用 `%USERPROFILE%\.codex\auth.json` 登录态）、`deepseek`（凭据来自环境变量 `DEEPSEEK_API_KEY`）与 `astrahub`（凭据来自环境变量 `ASTRAHUB_API_KEY`）。
- 每个 provider 通过 `transforms` 数组按序挂载请求清洗（见 `src/server.mjs` 的 `PAYLOAD_TRANSFORMS` 注册表）：
  - `chatgpt-history`：第三方历史条目 id 规范化到官方类型前缀（`msg_`/`rs_`/`fc_`/`fco_`/`ctc_`/`ctco_`/`ws_`）；`reasoning.content` 迁移到 `summary` 并清空 `content`；递归删除旧参数 `prompt_cache_retention`。
  - `deepseek-effort`：中/高/极高映射为官方 `low/high/max`；删除 `service_tier`/`serviceTier`。
  - `deepseek-call-ids`：为缺失 `call_id` 的工具输出条目按同名未配对调用回填，孤儿输出直接移除；工具声明按 DeepSeek 唯一性约束清理——顶层 `tools` 展开 `namespace` 包装器并按名去重，`input` 条目的 `tools` 保留 `namespace` 结构但全局去重（同名 namespace/工具只保留首个），缺失的 `tools` 字段补为空数组。
- provider 声明 `retryOnPromptCacheError: true` 时，上游对该缓存参数报 400 会自动去掉 `prompt_cache_key` 重试一次（仅 chatgpt 启用）。
- 模型目录以 DeepSeek 官方 Codex 条目为基准（[config/deepseek-official-catalog.json](config/deepseek-official-catalog.json)，取自 DeepSeek 官方 Codex 接入页的 `models.json` 原文）。模型增删只改该文件，生成脚本自动跟随；仅转换官方已声明的 `low/high/max` 档位，不为单个模型补充缺失档位。生成结束会校验目录与 `config/router.config.json` 的路由匹配一致（目录里有路由认不出的模型、或路由声明了目录里没有的模型，都直接报错），避免"重跑一次生成后模型全变 `unsupported_model`"。

### 多智能体协作面（multi_agent_version）

模型目录默认给**所有模型**打 `multi_agent_version = "v1"`。原因：v2 把父会话派给子代理的任务正文放在 `encrypted_content`（`agent_message` 输入项），只有 OpenAI 官方后端能解密——GPT 父 → DeepSeek 子在这条路上必然丢正文（上游已知问题，openai/codex#37237 等）；v1 用明文 user 消息投递任务，任何 provider 都能消费。代价是失去 v2 的并发会话/LRU 驱逐等管理特性，v1 保留完整的 spawn/send/resume/close 工具族。上游官方修复后可用 `--multi-agent v2` 恢复默认打标。

### 已知上游问题：子代理可能向错误线程发消息

Codex 桌面端为会话提供跨线程工具 `mcp__codex_app__send_message_to_thread` / `read_thread`。模型可能从上下文里挑错 `threadId`，把本应汇报给父会话的内容发到同项目的其他历史会话（上游已知问题 [openai/codex#42935](https://github.com/openai/codex/issues/42935)，引擎 0.153.0-alpha.5 已复现，尚未修复）。这是模型的工具选择错误——出站调用里明确带着错误的目标线程 id——不经过本路由器，路由层无法拦截。

缓解措施（AI 代理必须遵守）：

- 为子代理编写任务 `message` 或项目 AGENTS.md 时，明确写入约束：“禁止调用 `send_message_to_thread` / `read_thread` 联系任何其他线程；进度与结果只通过 `FINAL_ANSWER` 汇报”。
- 父会话上下文尽量避免携带其他线程的 id 或引用——子代理继承的 fork 上下文与压缩摘要会把它们带进投递目标的候选集。
- 若发现消息串会话，排查方法：在 `%USERPROFILE%\.codex\sessions\` 下全文搜索目标线程 id，定位调用方 `function_call`（特征为 `exec` 工具内嵌 `send_message_to_thread`），无需检查本路由器。

## 关键文件

| 文件 | 职责 |
|---|---|
| `manage-router.ps1` | **统一管理入口**：交互菜单 + 全部运维动作（启停、Key、目录、配置、迁移、恢复、自启动、安装） |
| `start-router.bat` | **双击入口**：打开功能菜单；命令行 `start-router.bat <action>` 可跳过菜单直达（如 `start-router.bat restart`） |
| `src/server.mjs` | provider 路由、清洗注册表、缓存重试 |
| `src/config.mjs` | 读取并校验 `config/router.config.json` |
| `config/router.config.json` | 端口与 providers 列表（新增供应商只改这里） |
| `config/codex-config-snippet.toml` | Codex 配置片段 |
| `config/deepseek-official-catalog.json` | DeepSeek 官方模型条目（基准，勿手改；更新方式：从官方 Codex 接入页复制该页 `models.json` 全文） |
| `config/models.json` | 生成好的模型目录（已提交，Codex 通过 `model_catalog_json` 直接读取） |
| `config/models.meta.json` | 模型目录元信息：生成时间、官方目录抓取时间、官方 client_version、可见模型清单 |
| `scripts/fetch-official-catalog.mjs` | 用本机登录态拉取官方模型目录并刷新 `%USERPROFILE%\.codex\models_cache.json`（原文件先备份） |
| `scripts/build-model-catalog.mjs` | 生成 `config/models.json` 与 `config/models.meta.json`（支持 `--multi-agent v1/v2`） |
| `scripts/migrate-sessions.mjs` | 迁移历史会话的 `model_provider` 标签 |
| `test/*.test.mjs` | 路由行为与官方配置恢复测试 |

## 模型列表（已随仓库提供）

`config/models.json` 已提交进仓库，克隆后无需任何抓取即可直接使用：`config/codex-config-snippet.toml` 的 `model_catalog_json` 由 `-Action setup-codex` 自动改写成本机实际路径，指向这份目录。

文件里只有模型 slug、显示名、档位、上下文参数和官方下发的模型说明文本，**不含任何令牌、API Key 或账号信息**（登录态只存在于 `%USERPROFILE%\.codex\auth.json`，不随仓库分发）。

| 想知道 | 看 `config/models.meta.json` |
|---|---|
| 这份列表什么时候生成的 | `generated_at` |
| 官方目录什么时候抓的 | `official_fetched_at` |
| 按哪个客户端版本抓的 | `official_client_version` |
| 一共几条、哪些可见 | `model_count`、`visible_models` |

### 拉取官方最新模型列表并合并

```powershell
npm run fetch:catalog    # 拉官方目录，刷新 %USERPROFILE%\.codex\models_cache.json（原文件先备份到 backups\）
npm run build:catalog    # 合并「官方 GPT 条目 + DeepSeek 官方条目」，重写 config/models.json 与 config/models.meta.json
```

`fetch:catalog` 用 `%USERPROFILE%\.codex\auth.json` 的 ChatGPT 登录态请求 `GET https://chatgpt.com/backend-api/codex/models?client_version=<版本>`（与桌面端同一个接口）。**版本门控**：服务端按 `client_version` 裁剪目录——低于 `0.153` 不下发 GPT-6（只有隐藏的 `gpt-reserve` 兜底），`0.153.x` 只给 Astra，`0.155+` 才给 Astra/Sol/Luna 全套；脚本默认取本机 `codex --version`，可用 `--client-version` 覆盖。拉不到 GPT-6 是该版本的正常结果，不要硬塞。合并规则见下方「生成模型目录」，改完提交 `config/models.json` 与 `config/models.meta.json` 即可。

## 统一管理脚本

整个项目只有一个功能入口：`manage-router.ps1`。双击 `start-router.bat`（或命令行运行下面命令）即进入交互菜单，菜单第 1 项就是"重启路由"：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1
```

不带 `-Action` 运行进入交互菜单；也可以直接用参数执行单个动作：

| `-Action` | 作用 | 等价菜单项 |
|---|---|---|
| `restart` | 停止旧实例并后台启动（`start-router.bat` 即此动作） | 1 |
| `start` / `stop` | 启动 / 停止 | 1 / 2 |
| `health` | 健康检查 | 3 |
| `set-key` | 直接录入 DeepSeek Key（菜单里可选任意已声明供应商，或用 `c` 录入自定义供应商） | 4 |
| `build-catalog` | 生成模型目录，`-MultiAgent v1|v2` 控制协作面（默认 v1） | 5 → 2 |
| `setup-codex` | 备份并合并 Codex 配置（`-DryRun` 预览、`-Force` 重应用） | 5 → 3 |
| `migrate-sessions` | 会话标签 `openai → local_router` | 6 → 1 |
| `restore-official` | 恢复 Codex 官方配置并迁回会话标签 | 5 → 4 |
| `enable-autostart` / `disable-autostart` | 登录自启动开关 | 6 → 2（按当前状态切换） |
| `install` | 复制项目到 `-TargetDirectory`（排除密钥/日志/git），并生成目录 | 无菜单项，仅命令 |

通用参数：`-CodexHome`、`-ConfigPath`、`-BackupDirectory`、`-DryRun`、`-Force`、`-SkipSessionMigration`。

## 部署步骤

前置条件：Windows 10/11；Node.js 22.5+；Codex 0.144.0+；Codex 已通过 ChatGPT 登录（保证 `auth.json` 存在）；一个 DeepSeek API Key。

在新机器可先运行 `-Action install` 把项目复制到目标目录（自动排除 `secrets/`、`logs/` 等本机数据）。

### 1. 生成模型目录

```powershell
node .\scripts\build-model-catalog.mjs            # 默认 --multi-agent v1
node .\scripts\build-model-catalog.mjs --multi-agent v2   # 恢复上游原值（v2/上游 pin）
```

读取 `%USERPROFILE%\.codex\models_cache.json`，保留 GPT 模型并加入 DeepSeek 与 AstraHub 条目，输出 `config\models.json` 与 `config\models.meta.json`（两者都已提交进仓库，克隆后可直接使用；缓存不存在时先执行 `npm run fetch:catalog` 拉取）。可见列表按官方优先级排列：GPT-6.1 Sol、GPT-6 Astra、GPT-6 Sol、GPT-6 Luna、GPT-5.6 Sol，之后是 DeepSeek 与 AstraHub 条目，其余为 `hide`。显示名、档位、上下文等一律以官方条目为准；只有 `hiddenCompatibilityModels` 与 DeepSeek `localOverrides` 会改写可见性。注意：官方缓存里没有的 GPT-6 条目会以同档 5.6 条目为模板合成兜底（1.05M 上下文；Astra=`low`、Sol=`medium`、Luna=`high`），一旦缓存收录官方条目就自动改用官方值（官方 `context_window` 为 272000、`max_context_window` 为 872000）。

`hiddenCompatibilityModels` 里的模型只在列表隐藏、仍可正常路由：`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`（官方 2026-10-14 从 Codex 退市）、`gpt-5.4`、`gpt-5.4-mini`，外加官方本身就标 `hide` 的 `gpt-reserve`、`codex-auto-review`。`gpt-5.6-sol` 保持显示，与 GPT-6 Sol 并存——两者同档，GPT-6 Sol 在官方两套计费口径下都只有它的一半（Codex 额度按每 1M tokens 计：GPT-6 Sol 50/5/250 credits，GPT-5.6 Sol 100/10/500 credits；API 标准档单价：gpt-6-sol $2/$0.2/$10，gpt-5.6-sol $4/$0.4/$20，来源：[Codex 定价](https://learn.chatgpt.com/docs/pricing)、[OpenAI API 定价](https://developers.openai.com/api/docs/pricing)），但账号侧对 GPT-6 Sol 的访问不一定开通（实测可能返回 404 `model_not_found`），所以两个都留着方便切换。

DeepSeek 条目默认沿用官方 slug/显示名，只有 `localOverrides` 里显式列出的会改名或隐藏。当前覆盖：官方 `deepseek-v4-pro` → 面向 Codex 的 `deepseek-pro`（显示名 `DeepSeek-Pro`，`visibility: hide` 暂时隐藏）。**改名必须在 `config/router.config.json` 的 `modelAliases` 里把新 slug 映射回官方 slug**（如 `"deepseek-pro": "deepseek-v4-pro"`），否则上游会收到 DeepSeek 不认识的模型名；生成脚本会校验 `modelAliases` 的目标是否为已知模型名，写错直接报错。

#### 刷新官方模型目录（官方上新模型后执行）

见上文「模型列表（已随仓库提供）」一节：`npm run fetch:catalog` → `npm run build:catalog`，最后完全重启 Codex。也可以走桌面端手动刷新：完全退出 Codex → 临时移除 `config.toml` 的 `model_catalog_json` 一行 → 打开 Codex 等其联网刷新后再退出并恢复该行。

### 2. 设置供应商 API Key（明文）

菜单 `4`（设置 API Key）会读取 `config\router.config.json`，列出所有 `auth.type = env` 的供应商并标注是否已配置，按编号录入；`c` 进入自定义供应商（输入 provider id 与环境变量名），`h` 查看手动配置说明。

Key 统一保存为 `secrets\<provider id>-key.txt`（Git 忽略），路由器启动时按配置里的 `auth.envVar` 自动注入：

| 供应商 | Key 文件 | 环境变量 |
|---|---|---|
| `deepseek` | `secrets\deepseek-key.txt` | `DEEPSEEK_API_KEY` |
| `astrahub` | `secrets\astrahub-key.txt` | `ASTRAHUB_API_KEY` |

修改 Key 后需重启路由器生效。命令行等价（直接录入 DeepSeek Key）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1 -Action set-key
```

换机器直接复制整个 `secrets\` 目录即可。本地目录中的 `AS-kimi-k3`、`AS-deepseek-v4.1-flash`、`AS-GLM-5.2` 分别映射到 AstraHub 的原始模型名。

### 3. 启动路由器

双击 `start-router.bat` 进入功能菜单，选 `1`（重启路由器）；或在命令行直达：`start-router.bat restart`。启动失败时暂停显示错误并指向 `logs\router.err.log`。等价命令：

```powershell
npm run start:bg
```

前台启动（便于看日志）：`npm start`。代码更新后必须手动重启路由器才生效。

### 4. 配置 Codex

菜单 `5` → `1`（重新生成并应用）会一并完成模型目录生成与 Codex 配置写入；命令行等价：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1 -Action setup-codex
```

自动备份到 `backups\config.toml.<时间戳>.bak`，把片段中的顶层字段与 `[model_providers.local_router]` 合并进 `%USERPROFILE%\.codex\config.toml`；`model_catalog_json` 自动填本机实际路径；保留原有 MCP/插件/沙箱设置；幂等（已配置过时需加 `-Force` 重新应用）。受管的顶层字段为 `model`、`model_reasoning_effort`、`model_provider`、`model_catalog_json`，当前片段给出默认模型 `gpt-6-sol` 与 `model_reasoning_effort = "medium"`（Sol 的官方默认档位）。合并后完全退出并重开 Codex 桌面端。

### 5. 迁移历史会话（必做）

续聊列表按会话的 `model_provider` 分抽屉，不迁移则旧会话（`openai` 标签）不可见。先完全退出 Codex，然后（菜单 `6` → `1` 带详细说明，或命令行）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1 -Action migrate-sessions
```

处理 `sessions\`、`archived_sessions\` 的 JSONL 首行与 `state_5.sqlite` 的 `threads` 表；修改前自动备份到 `backups\session-provider-migration-<时间戳>\`；幂等。无旧会话时自然报告 0 条。检测到 Codex 正在运行（存在 WAL）会拒绝执行。底层命令 `node .\scripts\migrate-sessions.mjs --dry-run` 可先预览。

### 6. 验证

- 健康检查：`-Action health`，或访问 http://127.0.0.1:4010/healthz
- 发消息后查看 `logs\router.out.log`：GPT 请求 `route=chatgpt`，DeepSeek 请求 `route=deepseek`，状态 200
- 4010 端口被占用：改 `config\router.config.json` 的 `port`，并同步修改 Codex 配置里的 `base_url`

### 通过代理访问上游（可选）

Node.js 的 `fetch` 不一定走 Windows"系统代理"，需要环境变量（Node 24 需同时 `NODE_USE_ENV_PROXY=1`）。以 Clash 类代理端口 `7897` 为例，写入当前用户永久环境：

```powershell
[Environment]::SetEnvironmentVariable('NODE_USE_ENV_PROXY', '1', 'User')
[Environment]::SetEnvironmentVariable('HTTP_PROXY', 'http://127.0.0.1:7897', 'User')
[Environment]::SetEnvironmentVariable('HTTPS_PROXY', 'http://127.0.0.1:7897', 'User')
[Environment]::SetEnvironmentVariable('NO_PROXY', 'localhost,127.0.0.1,::1', 'User')
```

`HTTPS_PROXY` 写 `http://...` 表示经 HTTP 代理的 CONNECT 隧道访问 HTTPS 上游；不要填仅 SOCKS 的端口。`NO_PROXY` 必须含回环地址。配置后重启路由器（`start-router.bat`）生效；验证方法：

```powershell
Get-NetTCPConnection -LocalPort 7897 -State Listen
$routerPid = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4010 -State Listen).OwningProcess
Get-NetTCPConnection -OwningProcess $routerPid -State Established
```

路由进程出现到 `127.0.0.1:7897` 的连接即表示上游走代理；分别发一次 GPT 和 DeepSeek 请求确认两条路由 200。停用代理：删除上述用户环境变量并重启路由器。

### 登录后自动启动（可选）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1 -Action enable-autostart
```

注册当前用户 Run 项 `CodexModelRouter`，随后立即启动并做健康检查；无需管理员权限，重复运行幂等。停用用 `-Action disable-autostart`（不影响运行中的路由）。

## 恢复官方配置

不再走本地路由时，先完全退出 Codex 桌面端与 CLI，然后（菜单 `5` → `4`，完成后可选择立即重启 Codex/ChatGPT 桌面端；或命令行）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-router.ps1 -Action restore-official
```

脚本会：备份当前 `config.toml` → 删除本项目写入的 `model`、`model_catalog_json`、`[model_providers.local_router]` → `model_provider` 改回官方默认 `openai` → 会话标签 `local_router → openai`（复用迁移脚本的备份机制）。保留 MCP、插件、权限等无关配置；不改 `auth.json`、DeepSeek Key、路由进程或自启动项。可先加 `-DryRun` 预览；仅明确不需要迁回历史时加 `-SkipSessionMigration`。官方配置依据：[OpenAI Docs：Codex Configuration Reference](https://developers.openai.com/codex/config-reference)。

由 DeepSeek 生成的旧会话会重新出现在官方历史里，但其第三方历史条目未经清洗，直接用官方 GPT 续聊仍可能失败；建议旧会话只作查看，新建官方会话继续工作。

## 新增模型供应商

1. 编辑 `config/router.config.json`，在 `providers` 追加条目：`id`、`baseUrl`（必须 HTTPS）、`auth`（`chatgpt` 透传登录态，或 `env` + `envVar` 从环境变量取 Key）、`match`（`models` 精确列表或 `prefixes` 前缀）、可选 `transforms`。
   `env` 类型用菜单 `4` 的 `c) 自定义供应商` 录入 Key（存 `secrets\<id>-key.txt`），路由器启动时按 `envVar` 自动注入，不需要改脚本。
2. 上游兼容 Responses API 时无需新代码；需要兼容清洗时在 `src/server.mjs` 的 `PAYLOAD_TRANSFORMS` 注册表加一个纯函数，再在 provider 的 `transforms` 里按序引用。
3. 若新模型要出现在 Codex 模型列表，参照 `scripts/build-model-catalog.mjs` 的 DeepSeek 处理方式扩展目录生成。
4. 重启路由器（`start-router.bat`）生效。

## 安全边界

- 只监听 `127.0.0.1`；拒绝绑定非回环地址
- 各 provider 凭据隔离：GPT 请求不携带 DeepSeek Key；DeepSeek 请求不转发 ChatGPT 认证或账户头
- 日志只含路由名、模型、HTTP 状态和耗时，不含请求/响应正文
- DeepSeek Key 明文存放于 `secrets\`（Git 忽略），注意访问权限
- 未配置 Key 时对应 provider 返回 503；未知模型直接 400

## 本地测试

```powershell
npm test
```

测试覆盖：模型目录生成（DeepSeek 官方基准、GPT-6 合成与 5.6 Sol 隐藏、路由/别名一致性校验）、凭据隔离、档位映射、service tier 与缓存清洗、历史 id 规范化、call_id 回填、未知模型拒绝、凭据缺失 fail closed、配置内声明新 provider 即插即用，以及官方配置恢复（含会话标签迁移）。测试使用本地模拟上游与临时目录，不访问真实 API。
