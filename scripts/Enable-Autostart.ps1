$ErrorActionPreference = 'Stop'

$routerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startScript = Join-Path $PSScriptRoot 'Start-Background.ps1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entryName = 'CodexModelRouter'

if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Router startup script not found: $startScript"
}

# 使用当前 Windows 用户的登录启动项，保证路由能读取同一用户保存的 DeepSeek Key。
New-Item -Path $runKey -Force | Out-Null
$command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
Set-ItemProperty -Path $runKey -Name $entryName -Value $command -Type String

# 立即启动一次；现有启动器具备幂等检查，不会创建重复实例。
& $startScript

$health = Invoke-WebRequest `
    -Uri 'http://127.0.0.1:4010/healthz' `
    -Method Get `
    -TimeoutSec 10 `
    -UseBasicParsing

if ($health.StatusCode -ne 200) {
    throw "Autostart was registered, but router health check failed: HTTP $($health.StatusCode)"
}

Write-Host ''
Write-Host 'Codex model router autostart is enabled.' -ForegroundColor Green
Write-Host 'Router is healthy: http://127.0.0.1:4010'
Write-Host "Startup entry: $entryName"

