param(
    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [string]$ConfigPath = '',
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $CodexHome 'config.toml'
}
$snippetPath = Join-Path $projectDirectory 'config\codex-config-snippet.toml'
$backupsDirectory = Join-Path $projectDirectory 'backups'
$expectedCatalogPath = ($projectDirectory.Replace('\', '/') + '/config/models.json')

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
    Write-Host "Codex is already configured for local_router: $ConfigPath"
    Write-Host 'Run with -Force to re-apply the snippet anyway.'
    return
}

# Extract the three top-level keys and the local_router section from the snippet.
$topKeys = [regex]::Matches($snippetText, '(?m)^(model|model_provider|model_catalog_json)\s*=.*$') |
    ForEach-Object { $_.Value }
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

# Remove any existing local_router section from the table area (section lines have no brackets).
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
    Write-Host "[dry-run] Would write the following to $ConfigPath :"
    Write-Host '---'
    Write-Host $merged
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupsDirectory "config.toml.$stamp.bak"
New-Item -ItemType Directory -Path $backupsDirectory -Force | Out-Null
Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
[IO.File]::WriteAllText($ConfigPath, $merged, [Text.UTF8Encoding]::new($false))

Write-Host "Backed up previous config to: $backupPath"
Write-Host "Updated: $ConfigPath"
Write-Host 'Fully quit and restart Codex desktop so the model list refreshes.'
