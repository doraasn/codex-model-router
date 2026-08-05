param(
    [string]$TargetDirectory = 'C:\Projects\codex-model-router'
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$targetParent = Split-Path -Parent $TargetDirectory

if (Test-Path -LiteralPath $TargetDirectory) {
    throw "Target already exists; refusing to overwrite it: $TargetDirectory"
}

New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
Copy-Item -LiteralPath $sourceDirectory -Destination $TargetDirectory -Recurse

$nodeCommand = Get-Command node.exe -ErrorAction Stop
& $nodeCommand.Source (Join-Path $TargetDirectory 'scripts\build-model-catalog.mjs')
if ($LASTEXITCODE -ne 0) {
    throw 'The project was copied, but model catalog generation failed.'
}

Write-Host "Installed project: $TargetDirectory"
Write-Host 'Next: run scripts\Set-DeepSeekKey.ps1, then start-router.bat from the installed project.'
