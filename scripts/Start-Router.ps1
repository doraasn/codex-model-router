param(
    [string]$SecretPath = (Join-Path $PSScriptRoot '..\secrets\deepseek-key.txt')
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop

if (-not (Test-Path -LiteralPath $SecretPath)) {
    throw "DeepSeek key file not found: $SecretPath. Run scripts\Set-DeepSeekKey.ps1 first."
}

$plainKey = [IO.File]::ReadAllText($SecretPath, [Text.Encoding]::UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "DeepSeek key file is empty: $SecretPath"
}

try {
    $env:DEEPSEEK_API_KEY = $plainKey
    & $nodeCommand.Source (Join-Path $projectDirectory 'src\server.mjs')
} finally {
    Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
    $plainKey = $null
}
