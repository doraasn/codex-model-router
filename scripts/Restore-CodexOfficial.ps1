param(
    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [string]$ConfigPath = '',
    [string]$BackupDirectory = '',
    [switch]$DryRun,
    [switch]$SkipSessionMigration
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $CodexHome 'config.toml'
}
if (-not $BackupDirectory) {
    $BackupDirectory = Join-Path $projectDirectory 'backups'
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

# Remove the simple local_router table written by Setup-Codex.ps1.
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
    throw 'Generated config does not select the built-in openai provider.'
}
if ($officialTop -match '(?m)^(model|model_catalog_json)\s*=') {
    throw 'Generated config still contains router-managed model settings.'
}
if ($officialConfig -match '(?m)^\[model_providers\.local_router\]\s*$') {
    throw 'Generated config still contains [model_providers.local_router].'
}

$normalizedCurrent = $configText.Replace("`r`n", "`n")
$configNeedsUpdate = $normalizedCurrent -cne $officialConfig

if ($DryRun) {
    Write-Host "[dry-run] Codex config target: $ConfigPath"
    Write-Host "[dry-run] Config update required: $configNeedsUpdate"
    Write-Host '[dry-run] Resulting config:'
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
        $nodeCommand = Get-Command node.exe -ErrorAction Stop
        $migrationScript = Join-Path $projectDirectory 'scripts\migrate-sessions.mjs'
        $migrationArguments = @(
            $migrationScript
            '--codex-home'
            $CodexHome
            '--from'
            'local_router'
            '--to'
            'openai'
            '--backup-directory'
            $BackupDirectory
        )
        if ($DryRun) {
            $migrationArguments += '--dry-run'
        }
        $nodeExecutable = $nodeCommand.Source
        & $nodeExecutable @migrationArguments
        if ($LASTEXITCODE -ne 0) {
            throw 'Session provider migration failed. The Codex config was not changed.'
        }
    } else {
        Write-Host 'No Codex session database found; session migration was skipped.'
    }
} else {
    Write-Host 'Session migration was skipped by request.'
}

if ($DryRun) {
    Write-Host 'dry-run complete; no config file was changed.'
    return
}

if ($configNeedsUpdate) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backupPath = Join-Path $BackupDirectory "config.toml.official-restore.$stamp.bak"
    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
    [IO.File]::WriteAllText($ConfigPath, $officialConfig, [Text.UTF8Encoding]::new($false))
    Write-Host "Backed up previous config to: $backupPath"
    Write-Host "Updated: $ConfigPath"
} else {
    Write-Host "Codex already uses the built-in openai provider: $ConfigPath"
}

Write-Host 'Official Codex configuration is active after Codex is fully restarted.'
Write-Host 'The router process and its Windows autostart entry were not changed.'
