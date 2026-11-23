# Net Traffic on the BUSY Bar: installs everything on Windows.
#
#   irm https://raw.githubusercontent.com/mrlunev/busybar-net-traffic/main/install.ps1 | iex
#
# 1. Node.js, if missing or older than 20 (winget, else the official installer; Windows asks to allow it).
# 2. The traffic meter, into %USERPROFILE%\.busy-net-traffic.
# 3. Setup: finds the bar on the USB cable, opens port 8792 in the firewall (Windows asks to allow it), starts the
#    traffic meter and adds it to the login items, installs the app on the bar and pairs the two.
#
# Works in Windows PowerShell 5.1, which every Windows 10 and 11 has. Everything sits in a function called on the
# last line, so a half-downloaded script does nothing.

function Install-BusyNetTraffic {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # GitHub and nodejs.org take TLS 1.2 and newer; older Windows 10 builds do not offer it by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # BUSYBAR_SOURCE: a local copy of the repository instead of GitHub, for testing before it is published.
  $Repo = if ($env:BUSYBAR_SOURCE) { $env:BUSYBAR_SOURCE } else { 'mrlunev/busybar-net-traffic' }
  $NodeLine = 'latest-v24.x'

  function Say($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
  function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; throw 'busybar-setup-failed' }

  # A new install puts Node on the PATH of new windows only; this window reads it again.
  function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }

  function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    return [int](& node -p "process.versions.node.split('.')[0]") -ge 20
  }

  function Install-Node {
    Say 'Installing Node.js. If Windows asks to allow changes, click Yes.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      # --source winget: with the Microsoft Store source unreachable, winget otherwise refuses to pick a package.
      winget install --exact --id OpenJS.NodeJS.LTS --source winget --silent --accept-source-agreements --accept-package-agreements | Out-Host
      Update-Path
    }
    if (Test-Node) { return }
    # No winget, or it failed: the official installer from nodejs.org.
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/SHASUMS256.txt").Content
    $name = ($sums -split "`n" | Where-Object { $_ -match 'x64\.msi$' } | Select-Object -First 1).Split(' ')[-1].Trim()
    $msi = Join-Path $env:TEMP $name
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/$name" -OutFile $msi
    Start-Process msiexec -ArgumentList "/i `"$msi`" /qn" -Verb RunAs -Wait
    Update-Path
  }

  if (-not (Test-Node)) { Install-Node }
  if (-not (Test-Node)) { Fail 'Node.js 20 or newer is needed, and it is still missing. Install it from https://nodejs.org and run this again.' }

  # A traffic meter left running from an earlier install lets go of its files first.
  try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 'http://127.0.0.1:8792/quit' | Out-Null } catch { }

  if (Test-Path $Repo) {
    $dir = $Repo
  } else {
    Say 'Downloading...'
    $dir = Join-Path $env:USERPROFILE '.busy-net-traffic'
    $zip = Join-Path $env:TEMP 'busy-net-traffic.zip'
    Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/main" -OutFile $zip
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    Expand-Archive $zip -DestinationPath $dir
  }
  $daemon = Get-ChildItem $dir -Recurse -Filter traffic-meter.mjs | Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object -First 1 | ForEach-Object FullName
  if (-not $daemon) { Fail 'The download has no traffic meter in it.' }

  Say 'Setting up the bar...'
  & node $daemon setup
}

try { Install-BusyNetTraffic } catch { if ("$_" -ne 'busybar-setup-failed') { Write-Host "$_" -ForegroundColor Red } }
