param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\autopilot-presets.json'),
    [string]$PresetName,
    [switch]$ListOnly,
    [switch]$DryRun
)

if (-not (Test-Path $ConfigPath)) {
    throw "Preset config not found at $ConfigPath."
}

$json = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
$presets = $json.presets
if (-not $presets) {
    throw 'No presets defined in the config file.'
}

if ($ListOnly) {
    $presets | ForEach-Object {
        "{0}: {1}" -f $_.name, $_.description
    }
    return
}

function Select-PresetInteractive {
    param([array]$PresetList)

    Write-Host 'Available presets:'
    for ($i = 0; $i -lt $PresetList.Count; $i++) {
        $preset = $PresetList[$i]
        Write-Host ("[{0}] {1}" -f ($i + 1), $preset.name)
        if ($preset.description) {
            Write-Host ("     " + $preset.description)
        }
    }
    do {
        $inputValue = Read-Host 'Enter preset number'
        $parsedValue = 0
        $valid = [int]::TryParse($inputValue, [ref]$parsedValue)
    } while (-not $valid -or $parsedValue -lt 1 -or $parsedValue -gt $PresetList.Count)

    return $PresetList[$parsedValue - 1]
}

$preset = $null
if ($PresetName) {
    $preset = $presets | Where-Object { $_.name -eq $PresetName }
    if (-not $preset) {
        throw "Preset '$PresetName' not found."
    }
} else {
    $preset = Select-PresetInteractive -PresetList $presets
}

$startScript = Join-Path $PSScriptRoot '..\Start-ChromeDebug.ps1'
if (-not (Test-Path $startScript)) {
    throw "Unable to locate Start-ChromeDebug.ps1 at $startScript"
}

$startArgs = @()
function Add-ScalarArg {
    param([string]$Name, $Value)
    if ($null -ne $Value -and $Value -ne '') {
        $script:startArgs += "-$Name"
        $script:startArgs += $Value
    }
}

function Add-SwitchArg {
    param([string]$Name, [bool]$Enabled)
    if ($Enabled) {
        $script:startArgs += "-$Name"
    }
}

function Add-ArrayArg {
    param([string]$Name, $Values)
    if ($Values -and $Values.Count -gt 0) {
        $script:startArgs += "-$Name"
        $script:startArgs += $Values
    }
}

$autopilotArgList = @()
if ($preset.autopilotArgs) {
    $autopilotArgList = @($preset.autopilotArgs)
}

function Test-AutopilotFlag {
    param([string]$Flag)
    for ($index = 0; $index -lt $script:autopilotArgList.Count; $index++) {
        if ($script:autopilotArgList[$index] -eq $Flag) {
            return $true
        }
    }
    return $false
}

function Add-AutopilotOption {
    param(
        [string]$Flag,
        [string]$Value,
        [switch]$IsSwitch
    )
    if ($IsSwitch) {
        if (-not (Test-AutopilotFlag -Flag $Flag)) {
            $script:autopilotArgList += $Flag
        }
        return
    }
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    if (-not (Test-AutopilotFlag -Flag $Flag)) {
        $script:autopilotArgList += $Flag
        $script:autopilotArgList += $Value
    }
}

Add-AutopilotOption -Flag '--success-criteria' -Value $preset.successCriteriaPath
Add-AutopilotOption -Flag '--final-bundle-path' -Value $preset.finalBundlePath
Add-AutopilotOption -Flag '--audit-output-dir' -Value $preset.auditOutputDir
Add-AutopilotOption -Flag '--audit-model' -Value $preset.auditModel
Add-AutopilotOption -Flag '--qa-model' -Value $preset.qaModel
Add-AutopilotOption -Flag '--skip-audit' -IsSwitch:$([bool]$preset.skipAudit)
Add-AutopilotOption -Flag '--skip-qa' -IsSwitch:$([bool]$preset.skipQa)
Add-AutopilotOption -Flag '--revision-model' -Value $preset.revisionModel
Add-AutopilotOption -Flag '--skip-revisions' -IsSwitch:$([bool]$preset.skipRevisions)

Add-ScalarArg -Name 'Port' -Value $preset.port
Add-ScalarArg -Name 'DevToolsHost' -Value $preset.host
Add-ScalarArg -Name 'ProfileName' -Value $preset.profileName
Add-ScalarArg -Name 'MergeHtmlReport' -Value $preset.mergeHtmlReport
Add-SwitchArg -Name 'LegacyWorkflow' -Enabled ([bool]$preset.legacyWorkflow)
Add-SwitchArg -Name 'SkipChrome' -Enabled ([bool]$preset.skipChrome)
Add-SwitchArg -Name 'SkipScraper' -Enabled ([bool]$preset.skipScraper)
Add-SwitchArg -Name 'RunMerge' -Enabled ([bool]$preset.runMerge)
Add-SwitchArg -Name 'DisableHtmlPreview' -Enabled ([bool]$preset.disableHtmlPreview)
Add-ArrayArg -Name 'AutopilotArgs' -Values $autopilotArgList
Add-ArrayArg -Name 'ScraperArgs' -Values $preset.scraperArgs
Add-ArrayArg -Name 'MergeArgs' -Values $preset.mergeArgs

Write-Host "Running Start-ChromeDebug.ps1 with preset '$($preset.name)'..." -ForegroundColor Cyan
Write-Host ("Arguments: {0}" -f ($startArgs -join ' ')) -ForegroundColor DarkGray

if ($DryRun) {
    Write-Host 'Dry run mode enabled; command not executed.' -ForegroundColor Yellow
    return
}

& $startScript @startArgs
exit $LASTEXITCODE
