$ErrorActionPreference = "Stop"

$dashboardUrl = "https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1779096162299&list_end_date=1779096162299"
$cdpVersionUrl = "http://127.0.0.1:9222/json/version"

try {
  Invoke-RestMethod -Uri $cdpVersionUrl -TimeoutSec 1 | Out-Null
  Write-Host "Dedicated Chrome is already running on port 9222."
  exit 0
} catch {
  # Start a dedicated Chrome below.
}

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Cannot find Google Chrome. Please install Chrome first."
}

$profileDir = Join-Path $env:USERPROFILE ".gmvmax-chrome-win"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Write-Host "Starting Chrome with remote debugging..."
Write-Host "Chrome: $chrome"
Write-Host "Profile: $profileDir"

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check",
  $dashboardUrl
)

for ($i = 0; $i -lt 45; $i++) {
  try {
    Invoke-RestMethod -Uri $cdpVersionUrl -TimeoutSec 1 | Out-Null
    Write-Host "Dedicated Chrome is ready on port 9222."
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}

throw "Dedicated Chrome did not open port 9222. Please start scripts\start-chrome-win.bat manually."
