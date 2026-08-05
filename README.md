# Codex GPT + DeepSeek 本地模型路由器

让 Codex 通过本机地址按模型名转发请求：`gpt-*` / `codex-*` 走 ChatGPT 登录认证，`deepseek-v4-flash` 走 DeepSeek API Key。路由器只监听 `127.0.0.1`，无第三方运行时依赖。

## 适用环境

在 Windows + 微软商店版 ChatGPT（Codex 桌面端）上开发验证。其他安装渠道或版本仅供参考，不保证完全生效。

## 前置条件

- Windows 10/11，Node.js 22.5+，Codex 0.144.0+
- Codex 已通过 ChatGPT 登录（`codex login` 或用桌面端登录）
- 一个新的 DeepSeek API Key

当前只声明 `deepseek-v4-flash` 可用于 Codex，不要在官方支持前手动开启 `deepseek-v4-pro`。

## 安装

项目放任意目录即可（如 `D:\Tools\codex-model-router`）。如需从当前目录安装到目标目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-To-CProjects.ps1 -TargetDirectory D:\Tools\codex-model-router
```

目标已存在时脚本会拒绝覆盖。

## 一、生成模型目录

```powershell
node .\scripts\build-model-catalog.mjs
```

读取本机 `%USERPROFILE%\.codex\models_cache.json`，生成含 GPT 和 DeepSeek 的 `config\models.json`。建议在新机器上重新运行一次。

## 二、保存 DeepSeek Key

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Set-DeepSeekKey.ps1
```

Key 明文保存在 `secrets\deepseek-key.txt`（Git 已忽略），换机器直接复制该文件即可。

## 三、启动路由器

- 后台：双击 `start-router.bat`，或运行 `npm run start:bg`
- 前台（便于看日志）：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Router.ps1`
- 健康检查：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Router.ps1`

路由器由你手动启停，代码更新后需要重启才生效。

## 四、配置 Codex

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-Codex.ps1
```

自动备份原配置并合并 `config\codex-config-snippet.toml` 到 `%USERPROFILE%\.codex\config.toml`，`model_catalog_json` 自动填实际安装路径，保留原有 MCP/插件/沙箱设置，重复运行幂等。`-DryRun` 先预览，`-Force` 重新应用。

手动合并时替换 `<你的安装目录>`：

```toml
model = "gpt-5.6-sol"
model_provider = "local_router"
model_catalog_json = "<你的安装目录>/config/models.json"

[model_providers.local_router]
name = "GPT + DeepSeek"
base_url = "http://127.0.0.1:4010/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

然后完全退出并重新打开 Codex，模型列表应同时出现 GPT 和 DeepSeek-V4-Flash。

## 五、迁移历史会话（可选）

续聊列表按会话的 `model_provider` 分抽屉。切换到 `local_router` 后，旧会话（`openai`）不会显示；想保留续聊列表需批量改标签。

先完全退出 Codex，然后：

```powershell
node .\scripts\migrate-sessions.mjs --dry-run
node .\scripts\migrate-sessions.mjs
```

脚本处理 `sessions\`、`archived_sessions\` 的 JSONL 和 `state_5.sqlite`，修改前自动备份到 `backups\session-provider-migration-<时间戳>\`。参数：

```text
--codex-home <路径>   指定 Codex 配置目录（默认 %USERPROFILE%\.codex）
--from / --to <标签>  源/目标 provider 标签（默认 openai -> local_router）
--dry-run             只预览，不修改
```

全新环境没有旧会话时跳过。

## 六、验证

- 路由器健康：`Test-Router.ps1` 或访问 http://127.0.0.1:4010/healthz
- 模型列表出现 GPT 和 DeepSeek-V4-Flash
- 发消息后看 `logs\router.out.log`（前台模式）：`route=chatgpt` / `route=deepseek`，状态 200
- 没有 `models_cache.json`：先启动一次 Codex 再重新生成
- 4010 端口被占用：换端口，并同步改 `config\router.config.json` 和 Codex 配置的 `base_url`

## 七、停止 / 恢复

- 停止：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-Router.ps1`
- 恢复官方配置：把配置时的备份（`backups\config.toml.<时间戳>.bak`）还原到 `%USERPROFILE%\.codex\config.toml`，重启 Codex。登录态未动，无需重新登录。

## 同任务切换模型

DeepSeek 历史条目的推理文本和 id 格式与官方不同。转发给 ChatGPT 前，路由器会自动把推理文本转换到 `summary` 并规范化 id 前缀，因此同一会话双向切换不会报 400；DeepSeek 路由保持原样透传。

## 安全边界

- 只监听 `127.0.0.1`，只接受 `/v1/responses`、`/responses`、`/healthz`
- GPT 请求不携带 DeepSeek Key；DeepSeek 请求不转发 ChatGPT 认证
- 日志只含路由名、模型、HTTP 状态和耗时，不含请求/响应正文
- 未配置 Key 时 DeepSeek 返回 503；未知模型直接拒绝

## 本地测试

```powershell
npm test
```

测试使用本地模拟上游，不会访问真实 API。
