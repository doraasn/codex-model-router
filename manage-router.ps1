<#
.SYNOPSIS
    Single management entry for the Codex model router project.
.DESCRIPTION
    Interactive menu when run without -Action; non-ininteractive automation
    mode when -Action is given. All router lifecycle, key management, model
    catalog generation, Codex config merge/restore, session label migration,
    autostart and install actions live here.
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File manage-router.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File manage-router.ps1 -Action restart
#>
param(
    [string]$Action = '',
    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [string]$ConfigPath = '',
    [string]$BackupDirectory = '',
    [string]$SecretPath = (Join-Path $PSScriptRoot 'secrets\deepseek-key.txt'),
    [ValidateSet('v1', 'v2')][string]$MultiAgent = 'v1',
    [string]$TargetDirectory = 'C:\Projects\codex-model-router',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipSessionMigration
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = $PSScriptRoot
$RouterPort = 4010
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AutostartEntry = 'CodexModelRouter'

function Get-NodeCommand {
    Get-Command node.exe -ErrorAction Stop
}

function Invoke-RouterStop {
    $listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $RouterPort -State Listen -ErrorAction SilentlyContinue
    $stopped = @()
    foreach ($listener in $listeners) {
        try {
            Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
            $stopped += $listener.OwningProcess
        } catch {
            Write-Warning "无法停止进程 $($listener.OwningProcess)：$($_.Exception.Message)"
        }
    }

    # Fallback: stop the recorded launcher only if it is really this project's PowerShell wrapper.
    $pidFilePath = Join-Path $ProjectDirectory 'runtime\router.pid'
    if (Test-Path -LiteralPath $pidFilePath) {
        $launcherPid = 0
        $pidText = (Get-Content -LiteralPath $pidFilePath -Raw).Trim()
        if ([int]::TryParse($pidText, [ref]$launcherPid)) {
            $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $launcherPid" -ErrorAction SilentlyContinue
            if ($launcher -and $launcher.Name -eq 'powershell.exe' -and $launcher.CommandLine -like '*codex-model-router*manage-router.ps1*') {
                try {
                    Stop-Process -Id $launcherPid -Force -ErrorAction Stop
                    $stopped += $launcherPid
                } catch {
                    Write-Warning "无法停止启动器进程 ${launcherPid}：$($_.Exception.Message)"
                }
            }
        }
        Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
    }

    if ($stopped.Count -gt 0) {
        Write-Host "已停止路由进程：$($stopped -join ', ')"
    } else {
        Write-Host "127.0.0.1:$RouterPort 上没有正在运行的路由器。"
    }
}

# Foreground serve; used directly by the background launcher (-Action serve).
function Invoke-RouterServe {
    if (-not (Test-Path -LiteralPath $SecretPath)) {
        throw "未找到 DeepSeek Key 文件：$SecretPath。请先执行动作 set-key。"
    }
    $plainKey = [IO.File]::ReadAllText($SecretPath, [Text.Encoding]::UTF8).Trim()
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw "DeepSeek Key 文件为空：$SecretPath"
    }
    $nodeCommand = Get-NodeCommand
    try {
        $env:DEEPSEEK_API_KEY = $plainKey
        & $nodeCommand.Source (Join-Path $ProjectDirectory 'src\server.mjs')
    } finally {
        Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
        $plainKey = $null
    }
}

function Invoke-RouterStartBackground {
    $logsDirectory = Join-Path $ProjectDirectory 'logs'
    $runtimeDirectory = Join-Path $ProjectDirectory 'runtime'
    $stdoutPath = Join-Path $logsDirectory 'router.out.log'
    $stderrPath = Join-Path $logsDirectory 'router.err.log'
    $manageScript = Join-Path $ProjectDirectory 'manage-router.ps1'

    New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$RouterPort/healthz" -TimeoutSec 1
        if ($health.status -eq 'ok') {
            # 端口仍被占用，强制杀掉旧进程后继续启动
            Write-Host "检测到旧路由器仍在运行，正在强制停止..."
            Invoke-RouterStop
            for ($wait = 0; $wait -lt 20; $wait++) {
                $occupied = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $RouterPort -State Listen -ErrorAction SilentlyContinue
                if (-not $occupied) { break }
                Start-Sleep -Milliseconds 250
            }
        }
    } catch {
        # Expected when the router is not running.
    }

    $process = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $manageScript, '-Action', 'serve') `
        -WorkingDirectory $ProjectDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    [IO.File]::WriteAllText(
        (Join-Path $runtimeDirectory 'router.pid'),
        "$($process.Id)`n",
        [Text.UTF8Encoding]::new($false)
    )

    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$RouterPort/healthz" -TimeoutSec 1
            if ($health.status -eq 'ok') {
                $healthy = $true
                break
            }
        } catch {
            # Retry while the child process starts.
        }
    }

    if (-not $healthy) {
        $diagnostic = if (Test-Path -LiteralPath $stderrPath) {
            (Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine
        } else {
            'No error log was created.'
        }
        throw "路由器未能进入健康状态。`n$diagnostic"
    }

    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $RouterPort -State Listen
    Write-Host "路由器已启动。launcher_pid=$($process.Id) node_pid=$($listener.OwningProcess)"
}

# 设置 API Key：查看手动配置说明，或选择供应商录入（当前仅支持 deepseek）。
function Show-ApiKeyManualGuide {
    Write-Host ''
    Write-Host 'Key 明文保存在以下文件（一行即可，UTF-8 编码）：'
    Write-Host "  $SecretPath"
    Write-Host '路由启动时读取该文件并注入环境变量 DEEPSEEK_API_KEY；修改后需重启路由器（菜单 1）生效。'
    Write-Host '该文件已被 Git 忽略，换机器直接复制。对应 config\router.config.json 的 provider 配置示例：'
    Write-Host ''
    Write-Host @'
{
  "id": "deepseek",
  "baseUrl": "https://api.deepseek.com/",
  "auth": { "type": "env", "envVar": "DEEPSEEK_API_KEY" },
  "match": { "models": ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] },
  "transforms": ["deepseek-effort", "deepseek-call-ids"]
}
'@
    Write-Host ''
}

function Invoke-SetApiKeyFlow {
    Clear-Host
    Write-Host '=============================================='
    Write-Host ' 设置 API Key'
    Write-Host '=============================================='
    Write-Host ' 1) 查看手动配置说明（文件位置与配置示例）'
    Write-Host ' 2) 选择供应商并录入 API Key'
    Write-Host ' 0) 返回主菜单'
    Write-Host ''
    $choice = Read-Host '请输入选项'
    if ([string]::IsNullOrEmpty($choice)) { return }
    switch ($choice) {
        '1' { Show-ApiKeyManualGuide }
        '2' {
            $provider = Read-Host '供应商（当前支持：deepseek）[deepseek]'
            if (-not $provider) { $provider = 'deepseek' }
            if ($provider -ne 'deepseek') {
                Write-Host "暂不支持供应商 $provider。新增供应商需先在 config\router.config.json 的 providers 中声明。"
                return
            }
            Save-DeepSeekKey
        }
        '0' { return }
        default { Write-Host '无效选项。' }
    }
}

function Invoke-RouterRestart {
    Invoke-RouterStop
    # 等待端口完全释放，最多 5 秒
    for ($wait = 0; $wait -lt 20; $wait++) {
        $occupied = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $RouterPort -State Listen -ErrorAction SilentlyContinue
        if (-not $occupied) { break }
        Start-Sleep -Milliseconds 250
    }
    Invoke-RouterStartBackground
}

function Invoke-RouterHealth {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$RouterPort/healthz" -Method Get -TimeoutSec 5
    if ($response.status -ne 'ok') {
        throw '路由器健康检查返回了异常响应。'
    }
    Write-Host '路由器健康检查通过。'
}

function Save-DeepSeekKey {
    $secretDirectory = Split-Path -Parent $SecretPath
    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    $plainKey = Read-Host '请输入新的 DeepSeek API Key'
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw '未输入任何 Key。'
    }
    [IO.File]::WriteAllText($SecretPath, $plainKey.Trim(), [Text.UTF8Encoding]::new($false))
    Write-Host "Key 已明文保存：$SecretPath"
    Write-Host '请保管好该文件；secrets\ 目录已被 Git 忽略。'
}

function Build-ModelCatalog([string]$Version) {
    $nodeCommand = Get-NodeCommand
    & $nodeCommand.Source (Join-Path $ProjectDirectory 'scripts\build-model-catalog.mjs') '--multi-agent' $Version
    if ($LASTEXITCODE -ne 0) {
        throw '模型目录生成失败。'
    }
    Write-Host '请完全退出并重新打开 Codex 桌面端，模型列表才会刷新。'
}

function Invoke-SetupCodex {
    if (-not $ConfigPath) {
        $script:ConfigPath = Join-Path $CodexHome 'config.toml'
    }
    $snippetPath = Join-Path $ProjectDirectory 'config\codex-config-snippet.toml'
    $backupsDirectory = Join-Path $ProjectDirectory 'backups'
    $expectedCatalogPath = ($ProjectDirectory.Replace('\', '/') + '/config/models.json')

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "config.toml not found: $ConfigPath"
    }
    if (-not (Test-Path -LiteralPath $snippetPath)) {
        throw "Config snippet not found: $snippetPath"
    }

    $configText = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
    $snippetText = [IO.File]::ReadAllText($snippetPath, [Text.Encoding]::UTF8)

    # Idempotency check: if already configured for this project, exit unless -Force.
    $alreadyConfigured =
        ($configText -match '(?m)^\[model_providers\.local_router\]\s*$') -and
        ($configText -match [regex]::Escape($expectedCatalogPath))
    if ($alreadyConfigured -and -not $Force) {
        Write-Host "Codex 已配置为 local_router：$ConfigPath"
        Write-Host '如需重新应用请加 -Force 参数。'
        return
    }

    # Extract the three top-level keys and the local_router section from the snippet.
    $topKeys = [regex]::Matches($snippetText, '(?m)^(model|model_provider|model_catalog_json)\s*=.*$') |
        ForEach-Object { $_.Value }
    # model_catalog_json must point at this project's actual location, never a hardcoded path.
    $topKeys = $topKeys | ForEach-Object {
        if ($_ -match '^model_catalog_json\s*=') {
            'model_catalog_json = "' + $expectedCatalogPath + '"'
        } else {
            $_
        }
    }
    $providerMatch = [regex]::Match($snippetText, '(?ms)\[model_providers\.local_router\].*$')
    if (-not $providerMatch.Success) {
        throw "No [model_providers.local_router] section found in $snippetPath"
    }
    $providerBlock = $providerMatch.Value.TrimEnd()

    # Split existing config into the top-level area (before the first [table]) and the rest.
    $firstTable = [regex]::Match($configText, '(?m)^\s*\[.*$')
    if ($firstTable.Success) {
        $topBlock = $configText.Substring(0, $firstTable.Index)
        $restText = $configText.Substring($firstTable.Index)
    } else {
        $topBlock = $configText
        $restText = ''
    }

    # Remove the old three keys from the top-level area only (table-internal fields are untouched).
    $topBlock = [regex]::Replace($topBlock, '(?m)^\s*(model|model_provider|model_catalog_json)\s*=.*(?:\r?\n|$)', '')

    # Remove any existing local_router section from the table area.
    $restText = [regex]::Replace($restText, '(?ms)^\[model_providers\.local_router\][^\r\n]*\r?\n(?:[^\r\n\[\]]*(?:\r?\n|$))*', '')

    # Join parts; TOML top-level keys must precede every [table].
    $parts = @()
    foreach ($part in @(($topKeys -join "`n"), $topBlock.TrimEnd(), $restText.TrimEnd(), $providerBlock)) {
        if (-not [string]::IsNullOrWhiteSpace($part)) {
            $parts += $part
        }
    }
    $merged = ($parts -join "`n`n") + "`n"

    # Validate the merged result.
    if ($merged -notmatch [regex]::Escape($expectedCatalogPath)) {
        throw "Merged config does not reference the project model catalog: $expectedCatalogPath"
    }
    if ($merged -notmatch '(?m)^\[model_providers\.local_router\]\s*$') {
        throw 'Merged config is missing the [model_providers.local_router] section'
    }

    if ($DryRun) {
        Write-Host "[预演] 将把以下内容写入 $ConfigPath ："
        Write-Host '---'
        Write-Host $merged
        return
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $backupsDirectory "config.toml.$stamp.bak"
    New-Item -ItemType Directory -Path $backupsDirectory -Force | Out-Null
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
    [IO.File]::WriteAllText($ConfigPath, $merged, [Text.UTF8Encoding]::new($false))

    Write-Host "已备份原配置到：$backupPath"
    Write-Host "已更新：$ConfigPath"
    Write-Host '请完全退出并重新打开 Codex 桌面端，模型列表才会刷新。'
}

function Invoke-MigrateSessions([string]$FromLabel, [string]$ToLabel) {
    $nodeCommand = Get-NodeCommand
    $arguments = @(
        (Join-Path $ProjectDirectory 'scripts\migrate-sessions.mjs')
        '--codex-home'; $CodexHome
        '--from'; $FromLabel
        '--to'; $ToLabel
        '--backup-directory'; $(if ($BackupDirectory) { $BackupDirectory } else { Join-Path $ProjectDirectory 'backups' })
    )
    if ($DryRun) {
        $arguments += '--dry-run'
    }
    & $nodeCommand.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        throw '会话标签迁移失败。'
    }
}

function Invoke-RestoreOfficial {
    if (-not $ConfigPath) {
        $script:ConfigPath = Join-Path $CodexHome 'config.toml'
    }
    if (-not $BackupDirectory) {
        $script:BackupDirectory = Join-Path $ProjectDirectory 'backups'
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "config.toml not found: $ConfigPath"
    }

    $configText = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)

    # Remove only top-level model settings managed by this project.
    $firstTable = [regex]::Match($configText, '(?m)^\s*\[.*$')
    if ($firstTable.Success) {
        $topBlock = $configText.Substring(0, $firstTable.Index)
        $restText = $configText.Substring($firstTable.Index)
    } else {
        $topBlock = $configText
        $restText = ''
    }

    $topBlock = [regex]::Replace($topBlock, '(?m)^\s*(model|model_provider|model_catalog_json)\s*=.*(?:\r?\n|$)', '')

    # Remove the simple local_router table written by the setup action.
    $restText = [regex]::Replace($restText, '(?ms)^\[model_providers\.local_router\][^\r\n]*\r?\n(?:[^\r\n\[\]]*(?:\r?\n|$))*', '')

    $parts = @('model_provider = "openai"')
    foreach ($part in @($topBlock.Trim(), $restText.Trim())) {
        if (-not [string]::IsNullOrWhiteSpace($part)) {
            $parts += $part
        }
    }
    $officialConfig = ($parts -join "`n`n") + "`n"

    # Refuse to write a generated config that still selects this router.
    $officialTopEnd = [regex]::Match($officialConfig, '(?m)^\s*\[.*$')
    $officialTop = if ($officialTopEnd.Success) {
        $officialConfig.Substring(0, $officialTopEnd.Index)
    } else {
        $officialConfig
    }
    if ($officialTop -notmatch '(?m)^model_provider\s*=\s*"openai"\s*$') {
        throw '生成的配置没有选择内置 openai provider。'
    }
    if ($officialTop -match '(?m)^(model|model_catalog_json)\s*=') {
        throw '生成的配置仍包含本项目管理过的模型设置。'
    }
    if ($officialConfig -match '(?m)^\[model_providers\.local_router\]\s*$') {
        throw '生成的配置仍包含 [model_providers.local_router] 段。'
    }

    $normalizedCurrent = $configText.Replace("`r`n", "`n")
    $configNeedsUpdate = $normalizedCurrent -cne $officialConfig

    if ($DryRun) {
        Write-Host "[预演] Codex 配置目标：$ConfigPath"
        Write-Host "[预演] 是否需要更新配置：$configNeedsUpdate"
        Write-Host '[预演] 生成结果：'
        Write-Host '---'
        Write-Host $officialConfig
    }

    # Move session labels back so official resume history remains visible.
    if (-not $SkipSessionMigration) {
        $stateCandidates = @(
            (Join-Path $CodexHome 'state_5.sqlite')
            (Join-Path $CodexHome 'state\state_5.sqlite')
        )
        $hasStateDatabase = @($stateCandidates | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
        if ($hasStateDatabase) {
            $backupDirectoryForMigration = if ($BackupDirectory) { $BackupDirectory } else { Join-Path $ProjectDirectory 'backups' }
            $migrationArguments = @(
                (Join-Path $ProjectDirectory 'scripts\migrate-sessions.mjs')
                '--codex-home'; $CodexHome
                '--from'; 'local_router'
                '--to'; 'openai'
                '--backup-directory'; $backupDirectoryForMigration
            )
            if ($DryRun) {
                $migrationArguments += '--dry-run'
            }
            $nodeCommand = Get-NodeCommand
            & $nodeCommand.Source @migrationArguments
            if ($LASTEXITCODE -ne 0) {
                throw '会话标签迁移失败，Codex 配置未做任何修改。'
            }
        } else {
            Write-Host '未找到 Codex 会话数据库，已跳过会话迁移。'
        }
    } else {
        Write-Host '已按要求跳过会话迁移。'
    }

    if ($DryRun) {
        Write-Host '预演完成，未修改任何配置文件。'
        return
    }

    if ($configNeedsUpdate) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $backupPath = Join-Path $BackupDirectory "config.toml.official-restore.$stamp.bak"
        New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
        Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
        [IO.File]::WriteAllText($ConfigPath, $officialConfig, [Text.UTF8Encoding]::new($false))
        Write-Host "已备份原配置到：$backupPath"
        Write-Host "已更新：$ConfigPath"
    } else {
        Write-Host "Codex 已在使用内置 openai provider：$ConfigPath"
    }

    Write-Host '官方配置将在 Codex 完全重启后生效。'
    Write-Host '路由进程与 Windows 登录自启动项均未被修改。'
}

function Enable-RouterAutostart {
    $manageScript = Join-Path $ProjectDirectory 'manage-router.ps1'
    New-Item -Path $RunKey -Force | Out-Null
    $command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$manageScript`" -Action start"
    Set-ItemProperty -Path $RunKey -Name $AutostartEntry -Value $command -Type String

    # Start once now; the start action is idempotent.
    Invoke-RouterStartBackground
    Invoke-RouterHealth

    Write-Host ''
    Write-Host '路由器登录自启动已开启。'
    Write-Host "启动项名称：$AutostartEntry"
}

function Disable-RouterAutostart {
    Remove-ItemProperty -Path $RunKey -Name $AutostartEntry -ErrorAction SilentlyContinue
    Write-Host "已删除登录自启动项：$AutostartEntry（路由进程未被停止）。"
}

function Copy-ProjectInstall {
    if (Test-Path -LiteralPath $TargetDirectory) {
        throw "Target already exists; refusing to overwrite it: $TargetDirectory"
    }
    $targetParent = Split-Path -Parent $TargetDirectory
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null

    # Copy the project without local-only data (keys, logs, backups, VCS, tooling).
    robocopy $ProjectDirectory $TargetDirectory /E /XD .git secrets logs runtime backups temp node_modules .mimocode | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy 复制失败，退出码 $LASTEXITCODE"
    }

    $nodeCommand = Get-NodeCommand
    & $nodeCommand.Source (Join-Path $TargetDirectory 'scripts\build-model-catalog.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw '项目已复制，但模型目录生成失败。'
    }

    Write-Host "项目已安装到：$TargetDirectory"
    Write-Host '下一步：先运行 manage-router.ps1 的 set-key 保存 Key，再用安装目录里的 start-router.bat 启动。'
}

function Show-Menu {
    Clear-Host
    Write-Host '=============================================='
    Write-Host ' Codex 模型路由器 - 管理菜单'
    Write-Host " 项目目录: $ProjectDirectory"
    Write-Host '=============================================='
    Write-Host ' 1) 重启路由器（停止旧实例 + 后台启动）'
    Write-Host ' 2) 后台启动路由器'
    Write-Host ' 3) 停止路由器'
    Write-Host ' 4) 健康检查'
    Write-Host ' 5) 设置 API Key（供应商密钥）'
    Write-Host ' 6) 重新生成配置（模型目录 + 写入 Codex 配置）'
    Write-Host ' 7) 迁移历史会话标签'
    Write-Host ' 8) 开启登录自启动'
    Write-Host ' 9) 关闭登录自启动'
    Write-Host '10) 恢复 Codex 官方配置'
    Write-Host ' 0) 退出'
    Write-Host ''
}

# 重启 Codex / ChatGPT 桌面端：优雅关闭后按开始菜单条目重新拉起。
function Restart-CodexApps {
    $names = @('Codex', 'ChatGPT')
    $running = Get-Process -Name $names -ErrorAction SilentlyContinue
    if (-not $running) {
        Write-Host '未发现正在运行的 Codex / ChatGPT 桌面端。'
        return
    }
    $running | ForEach-Object { $null = $_.CloseMainWindow() }
    Start-Sleep -Seconds 3
    Get-Process -Name $names -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host '已退出 Codex / ChatGPT 桌面端，正在重新启动...'
    Start-Sleep -Seconds 1
    foreach ($name in $names) {
        $app = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if ($app) {
            Start-Process explorer.exe "shell:AppsFolder\$($app.AppID)"
        } else {
            Write-Host "未在开始菜单找到 $name，请手动打开。"
        }
    }
}

# 重新生成配置：模型目录 + Codex config.toml；完成后说明重启要求并提供立即重启选项。
function Invoke-ApplyRouterConfig {
    $version = Read-Host '多智能体协作面：v1=明文投递（所有供应商可用），v2=上游默认 [v1]'
    if ($version -ne 'v2') { $version = 'v1' }
    Build-ModelCatalog $version
    Invoke-SetupCodex
    Write-Host ''
    Write-Host '配置已重新生成并应用。生效还需要：'
    Write-Host '  1) 完全退出并重新打开 Codex 桌面端（模型列表才会刷新）'
    Write-Host '  2) 如修改过路由代码或 router.config.json，路由器也需要重启'
    $answer = Read-Host '是否立即重启路由器和 Codex/ChatGPT 桌面端？(y/N)'
    if ($answer -match '^[yY]') {
        Invoke-RouterRestart
        Restart-CodexApps
    } else {
        Write-Host '已跳过，请稍后手动重启路由器和 Codex/ChatGPT 桌面端。'
    }
}

function Invoke-MenuAction([string]$Choice) {
    switch ($Choice) {
        '1' { Invoke-RouterRestart }
        '2' { Invoke-RouterStartBackground }
        '3' { Invoke-RouterStop }
        '4' { Invoke-RouterHealth }
        '5' { Invoke-SetApiKeyFlow }
        '6' { Invoke-ApplyRouterConfig }
        '7' {
            Write-Host ''
            Write-Host '【功能说明】Codex 的续聊列表按会话记录的 model_provider 标签分抽屉显示，'
            Write-Host '只显示与当前激活供应商同标签的会话。本功能把历史会话的标签批量改写：'
            Write-Host '  源标签 -> 目标标签（默认 openai -> local_router），'
            Write-Host '让旧会话在当前路由配置下重新出现在续聊列表。'
            Write-Host '修改范围：'
            Write-Host '  - sessions\ 与 archived_sessions\ 下 JSONL 第一行的 session_meta.model_provider'
            Write-Host '  - state_5.sqlite 的 threads.model_provider'
            Write-Host '安全措施：只改标签、不动对话内容；修改前自动备份到'
            Write-Host 'backups\session-provider-migration-<时间戳>\；可重复执行（幂等）。'
            Write-Host '注意：需要先完全退出 Codex 桌面端/CLI，正在运行时脚本会拒绝执行。'
            Write-Host ''
            $from = Read-Host '源 provider 标签 [openai]'
            if (-not $from) { $from = 'openai' }
            $to = Read-Host '目标 provider 标签 [local_router]'
            if (-not $to) { $to = 'local_router' }
            Invoke-MigrateSessions $from $to
        }
        '8' { Enable-RouterAutostart }
        '9' { Disable-RouterAutostart }
        '10' {
            Invoke-RestoreOfficial
            Write-Host ''
            $answer = Read-Host '是否立即重启 Codex/ChatGPT 桌面端？(y/N)'
            if ($answer -match '^[yY]') {
                Restart-CodexApps
            } else {
                Write-Host '已跳过，请稍后手动完全退出并重新打开 Codex/ChatGPT 桌面端。'
            }
        }
        '0' { return $false }
        default { Write-Host '无效选项。' }
    }
    return $true
}

function Invoke-Action([string]$Name) {
    switch ($Name) {
        '' { return 'menu' }
        'menu' { return 'menu' }
        'serve' { Invoke-RouterServe }
        'start' { Invoke-RouterRestart }
        'stop' { Invoke-RouterStop }
        'restart' { Invoke-RouterRestart }
        'health' { Invoke-RouterHealth }
        'set-key' { Save-DeepSeekKey }
        'build-catalog' { Build-ModelCatalog $MultiAgent }
        'setup-codex' { Invoke-SetupCodex }
        'migrate-sessions' { Invoke-MigrateSessions 'openai' 'local_router' }
        'restore-official' { Invoke-RestoreOfficial }
        'enable-autostart' { Enable-RouterAutostart }
        'disable-autostart' { Disable-RouterAutostart }
        'install' { Copy-ProjectInstall }
        default { throw "Unknown action: $Name" }
    }
    return $null
}

$result = Invoke-Action $Action
if ($result -eq 'menu') {
    while ($true) {
        Show-Menu
        $choice = Read-Host '请输入选项'
        # EOF on redirected stdin must leave the menu instead of spinning forever.
        if ([string]::IsNullOrEmpty($choice)) { break }
        try {
            $continue = Invoke-MenuAction $choice
        } catch {
            # One failing action must not kill the menu session.
            Write-Host ''
            Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
            $continue = $true
        }
        if ($continue -eq $false) { break }
        Write-Host ''
        Read-Host '按回车返回菜单' | Out-Null
    }
}
