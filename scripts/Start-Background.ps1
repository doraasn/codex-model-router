$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logsDirectory = Join-Path $projectDirectory 'logs'
$runtimeDirectory = Join-Path $projectDirectory 'runtime'
$stdoutPath = Join-Path $logsDirectory 'router.out.log'
$stderrPath = Join-Path $logsDirectory 'router.err.log'
$startScript = Join-Path $projectDirectory 'scripts\Start-Router.ps1'

New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4010/healthz' -TimeoutSec 1
    if ($health.status -eq 'ok') {
        Write-Host 'Router is already healthy on http://127.0.0.1:4010'
        exit 0
    }
} catch {
    # Expected when the router is not running.
}

$process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript) `
    -WorkingDirectory $projectDirectory `
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
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4010/healthz' -TimeoutSec 1
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
    throw "Router did not become healthy.`n$diagnostic"
}

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4010 -State Listen
Write-Host "Router is healthy. launcher_pid=$($process.Id) node_pid=$($listener.OwningProcess)"
