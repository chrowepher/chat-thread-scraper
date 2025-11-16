param(
    [string]$StartScriptPath = (Join-Path $PSScriptRoot '..\Start-ChromeDebug.ps1')
)

if (-not (Test-Path $StartScriptPath)) {
    throw "Unable to find Start-ChromeDebug.ps1 at $StartScriptPath"
}

function Read-YesNo {
    param(
        [string]$Prompt,
        [bool]$Default = $true
    )

    $suffix = if ($Default) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $response = Read-Host "$Prompt $suffix";
        if ([string]::IsNullOrWhiteSpace($response)) {
            return $Default
        }
        switch ($response.ToLower()) {
            'y' { return $true }
            'yes' { return $true }
            'n' { return $false }
            'no' { return $false }
            default { Write-Host 'Please answer y or n.' -ForegroundColor Yellow }
        }
    }
}

function Read-Value {
    param(
        [string]$Prompt,
        [string]$Default = ''
    )

    $message = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
    $value = Read-Host $message
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }
    return $value
}

$port = [int](Read-Value -Prompt 'Remote debugging port' -Default '9222')
$host = Read-Value -Prompt 'DevTools host' -Default '127.0.0.1'
$profileName = Read-Value -Prompt 'Chrome profile name' -Default 'RemoteDebug'
$launchChrome = Read-YesNo -Prompt 'Launch Chrome before running?' -Default $true
$runScraper = Read-YesNo -Prompt 'Run the scraper this session?' -Default $true
$useLegacy = Read-YesNo -Prompt 'Use legacy scrape/merge workflow?' -Default $false

$skipChrome = -not $launchChrome
$skipScraper = -not $runScraper

$startArgs = @('-Port', $port, '-DevToolsHost', $host, '-ProfileName', $profileName)
if ($skipChrome) { $startArgs += '-SkipChrome' }
if ($skipScraper) { $startArgs += '-SkipScraper' }

if ($useLegacy) {
    $startArgs += '-LegacyWorkflow'
    $runMerge = Read-YesNo -Prompt 'Run merge after legacy scrape?' -Default $true
    if ($runMerge) { $startArgs += '-RunMerge' }

    $scrapeFolder = Read-Value -Prompt 'Bookmark folder to scrape' -Default 'Digital Nomad'
    $scrapeOutput = Read-Value -Prompt 'Legacy snapshot output path' -Default 'snapshots/digital-nomad.json'
    $mergeNote = Read-Value -Prompt 'Merge note path' -Default 'notes/digital-nomad.md'
    $mergeTasks = Read-Value -Prompt 'Merge tasks path' -Default 'snapshots/digital-nomad-tasks.json'
    $branchLimit = Read-Value -Prompt 'Merge branch limit' -Default '5'

    $scraperArgs = @('--bookmark-folder', $scrapeFolder, '--output', $scrapeOutput, '--pretty')
    if (Read-YesNo -Prompt 'Enable verbose legacy scraper logging?' -Default $true) {
        $scraperArgs = @('--verbose') + $scraperArgs
    }
    $mergeArgs = @('--input', $scrapeOutput, '--note-path', $mergeNote, '--tasks-path', $mergeTasks, '--branch-limit', $branchLimit)

    $startArgs += '-ScraperArgs'
    $startArgs += $scraperArgs

    if ($runMerge) {
        $startArgs += '-MergeArgs'
        $startArgs += $mergeArgs
    }
} else {
    $bookmarkFolder = Read-Value -Prompt 'Bookmark folder to scrape' -Default 'Digital Nomad'
    $snapshotPath = Read-Value -Prompt 'Snapshot output path' -Default 'snapshots/digital-nomad.json'
    $notePath = Read-Value -Prompt 'Merge note path' -Default 'notes/digital-nomad.md'
    $tasksPath = Read-Value -Prompt 'Merge tasks path' -Default 'snapshots/digital-nomad-tasks.json'
    $branchLimit = Read-Value -Prompt 'Merge branch limit' -Default '5'
    $mergeHtml = Read-Value -Prompt 'Merge HTML report path' -Default 'dist/autopilot-merge.html'

    $autopilotArgs = @(
        '--bookmark-folder', $bookmarkFolder,
        '--snapshot', $snapshotPath,
        '--merge-note', $notePath,
        '--merge-tasks', $tasksPath,
        '--merge-branch-limit', $branchLimit
    )

    if (Read-YesNo -Prompt 'Keep Chrome tabs open afterwards?' -Default $false) {
        $autopilotArgs += '--keep-tabs'
    }

    $maxTabs = Read-Value -Prompt 'Max concurrent tabs (blank for default)' -Default ''
    if ($maxTabs) { $autopilotArgs += @('--max-concurrent-tabs', $maxTabs) }

    $convTimeout = Read-Value -Prompt 'Conversation timeout ms (blank for default)' -Default ''
    if ($convTimeout) { $autopilotArgs += @('--conversation-timeout', $convTimeout) }

    $hydrateIterations = Read-Value -Prompt 'Hydrate iterations (blank for default)' -Default ''
    if ($hydrateIterations) { $autopilotArgs += @('--hydrate-iterations', $hydrateIterations) }

    $hydrateDelay = Read-Value -Prompt 'Hydrate delay ms (blank for default)' -Default ''
    if ($hydrateDelay) { $autopilotArgs += @('--hydrate-delay', $hydrateDelay) }

    if (Read-YesNo -Prompt 'Open HTML report when done?' -Default $true) {
        $autopilotArgs += '--open-merge-html'
    } else {
        $startArgs += '-DisableHtmlPreview'
    }

    $startArgs += '-MergeHtmlReport'
    $startArgs += $mergeHtml
    $startArgs += '-AutopilotArgs'
    $startArgs += $autopilotArgs
}

Write-Host 'Assembled command:' -ForegroundColor Cyan
Write-Host "Start-ChromeDebug.ps1 $($startArgs -join ' ')" -ForegroundColor DarkGray
if (-not (Read-YesNo -Prompt 'Run now?' -Default $true)) {
    Write-Host 'Command cancelled by user.' -ForegroundColor Yellow
    exit 1
}

& $StartScriptPath @startArgs
exit $LASTEXITCODE
