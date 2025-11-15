param(
    [int]$Port = 9222,
    [string]$DevToolsHost = "127.0.0.1",
    [string]$ProfileName = "RemoteDebug",
    [switch]$SkipChrome,
    [switch]$LegacyWorkflow,
    [string[]]$AutopilotArgs = @(
        '--bookmark-folder', 'Digital Nomad',
        '--snapshot', 'snapshots/digital-nomad.json',
        '--merge-note', 'notes/digital-nomad.md',
        '--merge-tasks', 'snapshots/digital-nomad-tasks.json',
        '--merge-branch-limit', '5'
    ),
    [string]$MergeHtmlReport = 'dist/autopilot-merge.html',
    [switch]$DisableHtmlPreview,
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

if (-not $SkipChrome -and -not $SkipScraper) {
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

    Stop-ChromeProcesses -ProfileDir $profileDir -Port $Port

    $arguments = @(
        "--remote-debugging-port=$Port",
        "--remote-debugging-address=$DevToolsHost",
        "--user-data-dir=`"$profileDir`""
    )

    Write-Host "Launching Chrome from $chromePath with profile $profileDir (host $DevToolsHost, port $Port)..."
    Start-Process -FilePath $chromePath -ArgumentList $arguments

    $versionUri = "http://${DevToolsHost}:$Port/json/version"
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
    if ($SkipChrome) {
        Write-Host "Skipping Chrome launch (per -SkipChrome)."
    } elseif ($SkipScraper) {
        Write-Host "Skipping Chrome launch (per -SkipScraper)."
    } else {
        Write-Host "Skipping Chrome launch."
    }
}

function Stop-ChromeProcesses {
    param(
        [string]$ProfileDir,
        [int]$Port
    )

    $profileMarker = if ([string]::IsNullOrWhiteSpace($ProfileDir)) { $null } else { $ProfileDir.ToLowerInvariant() }
    $portMarker = if ($Port -gt 0) { ("--remote-debugging-port=" + $Port).ToLowerInvariant() } else { $null }

    Write-Host "Closing Chrome processes attached to the remote-debugging profile (if any)..."

    try {
        $chromeProcesses = Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop
    } catch {
        Write-Warning "Unable to enumerate Chrome processes for cleanup: $_"
        return
    }

    if (-not $chromeProcesses) {
        Write-Host "No running Chrome instances detected."
        return
    }

    $terminated = 0
    foreach ($proc in $chromeProcesses) {
        $cmdLine = $proc.CommandLine
        if (-not $cmdLine) {
            continue
        }
        $cmdLower = $cmdLine.ToLowerInvariant()
        $matchesProfile = $false
        $matchesPort = $false
        if ($profileMarker -and $cmdLower.Contains($profileMarker)) {
            $matchesProfile = $true
        }
        if ($portMarker -and $cmdLower.Contains($portMarker)) {
            $matchesPort = $true
        }
        if (-not ($matchesProfile -or $matchesPort)) {
            continue
        }

        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            $terminated += 1
        } catch {
            Write-Warning ("Failed to terminate chrome.exe (PID {0}): {1}" -f $proc.ProcessId, $_.Exception.Message)
        }
    }

    if ($terminated -eq 0) {
        Write-Host "No Chrome windows tied to the debugging session were running."
    } else {
        Write-Host ("Terminated {0} Chrome process(es) using the debugging profile/port." -f $terminated)
    }

    if ($terminated -eq 0 -and -not $profileMarker -and -not $portMarker) {
        Write-Warning "Skipped Chrome shutdown because profile/port markers were unavailable."
    }
}

function Resolve-NpmExecutable {
    $npmExecutable = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmExecutable) {
        $npmExecutable = Get-Command npm -ErrorAction SilentlyContinue
    }
    if (-not $npmExecutable) {
        throw 'npm was not found in PATH. Install Node.js (which provides npm) or specify the full path manually.'
    }
    return $npmExecutable
}

function ConvertTo-CommandLine {
    param(
        [string[]]$Arguments
    )

    if (-not $Arguments -or $Arguments.Count -eq 0) {
        return ''
    }

    return ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') {
            '"' + ($_.Replace('"', '""')) + '"'
        } else {
            $_
        }
    }) -join ' '
}

function Invoke-ProcessWithProgress {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$Activity = 'Running command',
        [string]$Status = 'Working',
        [int]$UpdateIntervalMilliseconds = 300
    )

    $commandLine = ConvertTo-CommandLine -Arguments $ArgumentList
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $commandLine
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $false
    $startInfo.RedirectStandardError = $false
    $startInfo.CreateNoWindow = $false

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process) {
        throw "Failed to start process $FilePath."
    }

    $spinner = @('|', '/', '-', '\')
    $spinIndex = 0
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    while (-not $process.HasExited) {
        $elapsed = $stopwatch.Elapsed.ToString('hh\:mm\:ss')
        $statusText = "$Status · elapsed $elapsed ${spinner[$spinIndex]}"
        Write-Progress -Activity $Activity -Status $statusText -PercentComplete -1
        $spinIndex = ($spinIndex + 1) % $spinner.Length
        Start-Sleep -Milliseconds $UpdateIntervalMilliseconds
    }

    $stopwatch.Stop()
    $process.WaitForExit()
    Write-Progress -Activity $Activity -Completed -Status ("Completed in {0}" -f $stopwatch.Elapsed.ToString('hh\:mm\:ss'))
    return $process.ExitCode
}

if (-not $LegacyWorkflow) {
    $npmExecutable = Resolve-NpmExecutable
    $npmArguments = @('start', '--', 'autopilot')
    $providedAutopilotArgs = @()
    if ($AutopilotArgs) {
        $providedAutopilotArgs = $AutopilotArgs
    }
    if (-not ($providedAutopilotArgs -contains '--host')) {
        $npmArguments += @('--host', $DevToolsHost)
    }
    if (-not ($providedAutopilotArgs -contains '--port')) {
        $npmArguments += @('--port', $Port.ToString())
    }
    if ($SkipScraper -and -not ($providedAutopilotArgs -contains '--skip-scrape')) {
        $npmArguments += '--skip-scrape'
    }
    $autopilotHtmlReportPath = $null
    for ($i = 0; $i -lt $providedAutopilotArgs.Count; $i++) {
        if ($providedAutopilotArgs[$i] -eq '--merge-html-report' -and $i -lt ($providedAutopilotArgs.Count - 1)) {
            $autopilotHtmlReportPath = $providedAutopilotArgs[$i + 1]
            break
        }
    }
    if (-not $autopilotHtmlReportPath -and $MergeHtmlReport) {
        $autopilotHtmlReportPath = $MergeHtmlReport
        $npmArguments += @('--merge-html-report', $autopilotHtmlReportPath)
    }
    $hasOpenHtmlFlag = $providedAutopilotArgs -contains '--open-merge-html'
    if (-not $DisableHtmlPreview -and $autopilotHtmlReportPath -and -not $hasOpenHtmlFlag) {
        $npmArguments += '--open-merge-html'
    }
    if ($providedAutopilotArgs.Count -gt 0) {
        $npmArguments += $providedAutopilotArgs
    }

    Write-Host "Launching chat-thread-merger autopilot via npm $($npmArguments -join ' ')..."
    $npmExit = Invoke-ProcessWithProgress -FilePath $npmExecutable.Path -ArgumentList $npmArguments -Activity 'chat-thread-merger autopilot' -Status 'Autopilot in progress'
    if ($npmExit -ne 0) {
        throw "npm start autopilot exited with code $npmExit."
    }
    return
}

if ($LegacyWorkflow -and $SkipScraper) {
    Write-Host "Skipping scraper run (per -SkipScraper)."
}

if ($LegacyWorkflow -and $SkipScraper -and -not $RunMerge) {
    return
}

$legacyNpmExecutable = $null
if (-not $SkipScraper -or $RunMerge) {
    $legacyNpmExecutable = Resolve-NpmExecutable
}

if (-not $SkipScraper) {
    $npmArguments = @('start')
    if ($ScraperArgs -and $ScraperArgs.Count -gt 0) {
        $npmArguments += '--'
        $npmArguments += $ScraperArgs
    }

    Write-Host "Launching chat-thread-scraper via npm $($npmArguments -join ' ')..."
    $npmExit = Invoke-ProcessWithProgress -FilePath $legacyNpmExecutable.Path -ArgumentList $npmArguments -Activity 'chat-thread-scraper' -Status 'Scraping threads'
    if ($npmExit -ne 0) {
        throw "npm start exited with code $npmExit."
    }
}

if ($RunMerge) {
    $mergeArguments = @('run', 'merge')
    if ($MergeArgs -and $MergeArgs.Count -gt 0) {
        $mergeArguments += '--'
        $mergeArguments += $MergeArgs
    }

    Write-Host "Launching chat-thread-merger via npm $($mergeArguments -join ' ')..."
    $mergeExit = Invoke-ProcessWithProgress -FilePath $legacyNpmExecutable.Path -ArgumentList $mergeArguments -Activity 'chat-thread-merger merge' -Status 'Merging snapshot'
    if ($mergeExit -ne 0) {
        throw "npm run merge exited with code $mergeExit."
    }
}
