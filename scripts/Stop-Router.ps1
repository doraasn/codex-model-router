$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFilePath = Join-Path $projectDirectory 'runtime\router.pid'

$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4010 -State Listen -ErrorAction SilentlyContinue
$stopped = @()
foreach ($listener in $listeners) {
    try {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
        $stopped += $listener.OwningProcess
    } catch {
        Write-Warning "Could not stop process $($listener.OwningProcess): $($_.Exception.Message)"
    }
}

# Fallback: stop the recorded launcher only if it is really this project's PowerShell wrapper.
if (Test-Path -LiteralPath $pidFilePath) {
    $launcherPid = 0
    $pidText = (Get-Content -LiteralPath $pidFilePath -Raw).Trim()
    if ([int]::TryParse($pidText, [ref]$launcherPid)) {
        $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $launcherPid" -ErrorAction SilentlyContinue
        if ($launcher -and $launcher.Name -eq 'powershell.exe' -and $launcher.CommandLine -like '*codex-model-router*Start-Router.ps1*') {
            try {
                Stop-Process -Id $launcherPid -Force -ErrorAction Stop
                $stopped += $launcherPid
            } catch {
                Write-Warning "Could not stop launcher process ${launcherPid}: $($_.Exception.Message)"
            }
        }
    }
    Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
}

if ($stopped.Count -gt 0) {
    Write-Host "Stopped router process(es): $($stopped -join ', ')"
} else {
    Write-Host 'No running router found on 127.0.0.1:4010.'
}
