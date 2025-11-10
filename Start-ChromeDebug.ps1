param(
    [int]$Port = 9222,
    [string]$ProfileName = "RemoteDebug",
    [switch]$SkipChrome,
    [string[]]$ScraperArgs = @(
        '--verbose',
        '--bookmark-folder', 'Digital Nomad',
        '--output', 'snapshots/digital-nomad.json',
        '--pretty'
    ),
    [switch]$SkipScraper,
    [switch]$RunMerge,
    [string[]]$MergeArgs = @(
        '--input', 'snapshots/digital-nomad.json',
        '--note-path', 'notes/digital-nomad.md',
        '--tasks-path', 'snapshots/digital-nomad-tasks.json',
        '--branch-limit', '5'
    )
)

if (-not $SkipChrome) {
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
    $version = $null
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            $version = Invoke-RestMethod -Uri $versionUri -UseBasicParsing -TimeoutSec 2
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $version) {
        Write-Warning "Chrome launched, but nothing responded at $versionUri after $maxAttempts seconds. Check firewall/port usage and try again."
        return
    }

    Write-Host "DevTools endpoint is ready at $versionUri"
    Write-Host ("Browser: {0}" -f $version.Browser)
    Write-Host ("WebSocket: {0}" -f $version.webSocketDebuggerUrl)
} else {
    Write-Host "Skipping Chrome launch (per -SkipChrome)."
}

if (-not $SkipScraper) {
    $npmExecutable = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmExecutable) {
        $npmExecutable = Get-Command npm -ErrorAction SilentlyContinue
    }
    if (-not $npmExecutable) {
        throw 'npm was not found in PATH. Install Node.js (which provides npm) or specify the full path manually.'
    }

    $npmArguments = @('start')
    if ($ScraperArgs -and $ScraperArgs.Count -gt 0) {
        $npmArguments += '--'
        $npmArguments += $ScraperArgs
    }

    Write-Host "Launching chat-thread-scraper via npm $($npmArguments -join ' ')..."
    & $npmExecutable.Path @npmArguments
    $npmExit = $LASTEXITCODE
    if ($npmExit -ne 0) {
        throw "npm start exited with code $npmExit."
    }
} else {
    Write-Host "Skipping scraper run (per -SkipScraper)."
    $npmExecutable = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmExecutable) {
        $npmExecutable = Get-Command npm -ErrorAction SilentlyContinue
    }
    if (-not $npmExecutable) {
        throw 'npm was not found in PATH. Install Node.js (which provides npm) or specify the full path manually.'
    }
}

if ($RunMerge) {
    $mergeArguments = @('run', 'merge')
    if ($MergeArgs -and $MergeArgs.Count -gt 0) {
        $mergeArguments += '--'
        $mergeArguments += $MergeArgs
    }

    Write-Host "Launching chat-thread-merger via npm $($mergeArguments -join ' ')..."
    & $npmExecutable.Path @mergeArguments
    $mergeExit = $LASTEXITCODE
    if ($mergeExit -ne 0) {
        throw "npm run merge exited with code $mergeExit."
    }
}
