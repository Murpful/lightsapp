# Opens LightsApp, starting the server first if it is not already up.
#
# Safe to run at any time, including while a service is on: if the server is
# already running it is left completely alone and only the browser is opened.
# Nothing here ever touches a lighting controller.

$ErrorActionPreference = 'Stop'
$port = 8420
$url  = "http://127.0.0.1:$port/"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

function Test-Alive {
    try {
        $null = Invoke-WebRequest -Uri "${url}api/bootstrap" -TimeoutSec 2 -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

if (Test-Alive) {
    Write-Host 'LightsApp is already running - opening it.'
    Start-Process $url
    exit 0
}

Write-Host 'Starting LightsApp...'
& wscript.exe (Join-Path $root 'run-hidden.vbs')

# Node plus reading the preset cache takes a few seconds on a cold machine.
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if (Test-Alive) {
        Write-Host 'Started - opening it.'
        Start-Process $url
        exit 0
    }
}

# Could not start: show the offline page, which explains what to do rather than
# leaving the operator with the browser's own "cannot connect" screen.
Write-Warning 'LightsApp did not start within 45 seconds.'
Start-Process (Join-Path $root 'offline.html')
exit 1
