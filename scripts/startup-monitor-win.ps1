$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "start-chrome-win.ps1")
Set-Location -LiteralPath $root
npm start
