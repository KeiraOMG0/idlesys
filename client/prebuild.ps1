# Read version from server/config.json
$utf8 = [System.Text.UTF8Encoding]::new($false)
$configPath = Join-Path $PSScriptRoot '..\server\config.json'
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$version = $config.version
if (-not $version) { Write-Error "No version in config.json"; exit 1 }
Write-Host "Building IDLE.SYS v$version"

# Sync version into package.json (regex replace to avoid ConvertTo-Json mangling formatting)
$pkgPath = Join-Path $PSScriptRoot 'package.json'
$pkg = [System.IO.File]::ReadAllText($pkgPath, $utf8)
$pkg = $pkg -replace '"version":\s*"[^"]*"', "`"version`": `"$version`""
[System.IO.File]::WriteAllText($pkgPath, $pkg, $utf8)

# Inject version into renderer.js
$rendererPath = Join-Path $PSScriptRoot 'renderer.js'
$renderer = [System.IO.File]::ReadAllText($rendererPath, $utf8)
$renderer = $renderer -replace "let CURRENT_VERSION = '[^']*'", "let CURRENT_VERSION = '$version'"
[System.IO.File]::WriteAllText($rendererPath, $renderer, $utf8)

# Clean dist and temp update cache
Start-Sleep -Seconds 30
if (Test-Path '../dist') { Remove-Item '../dist' -Recurse -Force }
$tmp = "$env:LOCALAPPDATA\Temp\idle-sys-update"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
