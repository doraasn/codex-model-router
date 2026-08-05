$ErrorActionPreference = 'Stop'
$response = Invoke-RestMethod -Uri 'http://127.0.0.1:4010/healthz' -Method Get -TimeoutSec 5
if ($response.status -ne 'ok') {
    throw 'Router health check returned an unexpected response.'
}
Write-Host 'Router health check passed.'
