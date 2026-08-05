param(
    [string]$SecretPath = (Join-Path $PSScriptRoot '..\secrets\deepseek-key.txt')
)

$ErrorActionPreference = 'Stop'
$secretDirectory = Split-Path -Parent $SecretPath
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null

$plainKey = Read-Host 'Enter a NEW DeepSeek API key'
if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw 'No key entered.'
}
[IO.File]::WriteAllText($SecretPath, $plainKey.Trim(), [Text.UTF8Encoding]::new($false))
Write-Host "Key saved in plain text: $SecretPath"
Write-Host 'Keep this file private; secrets\ is ignored by Git.'
