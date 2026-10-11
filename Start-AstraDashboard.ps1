# One-time setup and subsequent desktop launch. Does not accept target URLs or commands.
$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$dashboardPort = 4312
$runnerPort = 4313
try {
    $listing = & wsl.exe --list --quiet 2>&1
    if ($LASTEXITCODE -ne 0) { throw "WSL cannot be accessed: $listing" }
    $distros = @($listing | ForEach-Object { ([string]$_).Replace([char]0, '').Trim() } | Where-Object { $_ -and $_ -notmatch '^docker-desktop' })
    if ($distros.Count -eq 0) { throw 'No usable WSL distribution was found. Install/configure WSL2 once before using this launcher.' }
    $distro = $distros[0]
    if ($distros.Count -gt 1) {
        for ($i = 0; $i -lt $distros.Count; $i++) { Write-Host "$($i + 1). $($distros[$i])" }
        $selection = 0
        if (-not [int]::TryParse((Read-Host 'Choose WSL distribution number'), [ref]$selection) -or $selection -lt 1 -or $selection -gt $distros.Count) { throw 'Invalid distribution selection.' }
        $distro = $distros[$selection - 1]
    }
    $linuxRepo = (& wsl.exe --distribution $distro --exec wslpath -u $repoRoot 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxRepo.StartsWith('/')) { throw 'WSL path conversion failed.' }
    $controlRoot = Join-Path $repoRoot '.astra-dashboard'
    New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null
    $tokenFile = Join-Path $controlRoot 'runner-token'
    if (-not (Test-Path -LiteralPath $tokenFile)) {
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        [System.IO.File]::WriteAllText($tokenFile, $token)
    }
    $linuxToken = (& wsl.exe --distribution $distro --exec wslpath -u $tokenFile 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Runner token path conversion failed.' }
    $setupOutput = & wsl.exe --distribution $distro --exec bash "$linuxRepo/apps/dashboard/scripts/setup-runner.sh" $linuxRepo $linuxToken $runnerPort
    $setupOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Runner setup failed. See the specific environment check above.' }
    $descriptor = @($setupOutput | Where-Object { ([string]$_).StartsWith('ASTRA_RUNNER_DESCRIPTOR=') }) | Select-Object -Last 1
    if (-not $descriptor) { throw 'Runner did not report its actual Linux path.' }
    $runtimePaths = ([string]$descriptor).Substring('ASTRA_RUNNER_DESCRIPTOR='.Length) | ConvertFrom-Json
    if (-not $runtimePaths.source.StartsWith('/') -or $runtimePaths.source.Contains('"')) { throw 'Runner reported an unsafe path.' }
    $token = [System.IO.File]::ReadAllText($tokenFile).Trim()
    $runnerUrl = "http://127.0.0.1:$runnerPort"
    $readiness = $null
    try { $readiness = Invoke-RestMethod "$runnerUrl/api/control/capabilities" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 8 } catch { }
    if (-not $readiness) {
        if ($distro.Contains('"')) { throw 'Unsafe distribution name.' }
        # Keep a Windows WSL client alive while the Linux runner executes in the foreground.
        Start-Process -FilePath 'wsl.exe' -ArgumentList @('--distribution', '"' + $distro + '"', '--exec', 'bash', '"' + $runtimePaths.source + '/apps/dashboard/scripts/start-runner.sh"', [string]$runnerPort) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $controlRoot 'runner.log') -RedirectStandardError (Join-Path $controlRoot 'runner-error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 20 -and -not $readiness; $attempt++) {
            try { $readiness = Invoke-RestMethod "$runnerUrl/api/control/capabilities" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 8 } catch { Start-Sleep -Milliseconds 500 }
        }
    }
    if (-not $readiness) { throw 'The authenticated runner is unreachable. Check .astra-dashboard/runner-error.log and WSL localhost forwarding.' }
    if ($readiness.data.runtime -ne 'linux') { throw 'Runner did not confirm a Linux runtime. Check WSL localhost forwarding.' }
    @{ url = $runnerUrl; tokenFile = $tokenFile } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $controlRoot 'runner-connection.json')
    $entry = Join-Path $repoRoot 'apps/dashboard/dist/server/index.js'
    if (-not (Test-Path -LiteralPath $entry)) {
        Push-Location $repoRoot
        try { & pnpm.cmd dashboard:build; if ($LASTEXITCODE -ne 0) { throw 'Windows Dashboard build failed.' } } finally { Pop-Location }
    }
    $url = "http://127.0.0.1:$dashboardPort"
    $pidFile = Join-Path $controlRoot 'desktop-process.json'
    if (Test-Path -LiteralPath $pidFile) {
        $owned = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $previous = Get-Process -Id $owned.id -ErrorAction SilentlyContinue
        if ($previous -and $previous.StartTime.ToUniversalTime().ToString('o') -eq $owned.started -and $previous.Path -eq $owned.executable) { Stop-Process -Id $previous.Id }
    }
    if (Get-NetTCPConnection -State Listen -LocalPort $dashboardPort -ErrorAction SilentlyContinue) { throw "Port $dashboardPort is already in use by a process this launcher does not own. Close that Dashboard once and launch again." }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $env:ASTRA_DASHBOARD_PORT = [string]$dashboardPort
    $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $controlRoot 'desktop.log') -RedirectStandardError (Join-Path $controlRoot 'desktop-error.log') -PassThru
    @{ id = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o'); executable = $nodePath } | ConvertTo-Json | Set-Content -LiteralPath $pidFile
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { Invoke-RestMethod "$url/api/control/capabilities" -TimeoutSec 2 | Out-Null; Start-Process $url; exit 0 } catch { Start-Sleep -Milliseconds 500 }
    }
    throw 'Dashboard did not become reachable. Inspect .astra-dashboard/desktop-error.log.'
} catch { Write-Host ('Dashboard setup failed: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
