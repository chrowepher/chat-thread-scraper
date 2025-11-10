param(
    [int]$Port = 9222,
    [string]$ProfileName = "RemoteDebug"
)

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
)

$chromePath = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromePath) {
    throw "Chrome executable not found in Program Files or Program Files (x86). Update Start-ChromeDebug.ps1 with the correct path."
}

$profileDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\$ProfileName"
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

Write-Host "Closing existing Chrome processes..."
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force

$arguments = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$profileDir`""
)

Write-Host "Launching Chrome from $chromePath with profile $profileDir (port $Port)..."
Start-Process -FilePath $chromePath -ArgumentList $arguments

$versionUri = "http://127.0.0.1:$Port/json/version"
$maxAttempts = 10
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        $version = Invoke-RestMethod -Uri $versionUri -UseBasicParsing -TimeoutSec 2
        Write-Host "DevTools endpoint is ready at $versionUri"
        Write-Host ("Browser: {0}" -f $version.Browser)
        Write-Host ("WebSocket: {0}" -f $version.webSocketDebuggerUrl)
        return
    } catch {
        Start-Sleep -Seconds 1
    }
}

Write-Warning "Chrome launched, but nothing responded at $versionUri after $maxAttempts seconds. Check firewall/port usage and try again."
