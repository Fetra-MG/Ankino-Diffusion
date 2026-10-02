$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$tmp = Join-Path $env:TEMP 'ankino-mpv'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host 'Searching for the latest Windows x64 mpv build...'

$headers = @{ 'User-Agent' = 'Ankino-Diffusion-Build' }
$release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'

$asset = $release.assets |
  Where-Object { $_.name -match '^mpv-x86_64-[0-9]{8}-git-[^.]+\.7z$' } |
  Select-Object -First 1

if (-not $asset) {
  throw 'Could not find an mpv x64 archive in the latest release.'
}

$archivePath = Join-Path $tmp $asset.name
$extractPath = Join-Path $tmp 'extracted'

Write-Host ('Downloading ' + $asset.name)
Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $archivePath

& 7z x $archivePath "-o$extractPath" -y | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw '7-Zip failed to extract the mpv archive.'
}

$mpv = Get-ChildItem $extractPath -Recurse -Filter 'mpv.exe' | Select-Object -First 1
if (-not $mpv) {
  throw 'mpv.exe was not found after extraction.'
}

$target = Join-Path $bin 'mpv-x86_64-pc-windows-msvc.exe'
Copy-Item $mpv.FullName $target -Force

if (-not (Test-Path $target)) {
  throw 'The mpv sidecar was not copied to the expected Tauri path.'
}

Write-Host ('mpv sidecar ready: ' + $target)
