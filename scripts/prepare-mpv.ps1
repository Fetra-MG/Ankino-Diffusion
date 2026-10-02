$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$tmp = Join-Path $env:TEMP 'ankino-mpv'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host 'Recherche de la dernière build Windows x64 de mpv...'
$release = Invoke-RestMethod -Headers @{ 'User-Agent'='Ankino-Diffusion-Build' } -Uri 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'
$asset = $release.assets | Where-Object { $_.name -match '^mpv-x86_64-[0-9]{8}-git-[^.]+\.7z$' } | Select-Object -First 1
if (-not $asset) { throw 'Archive mpv x64 introuvable dans la dernière release.' }

$archive = Join-Path $tmp $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
& 7z x $archive "-o$tmp\extracted" -y | Out-Null
$mpv = Get-ChildItem "$tmp\extracted" -Recurse -Filter 'mpv.exe' | Select-Object -First 1
if (-not $mpv) { throw 'mpv.exe introuvable dans l’archive téléchargée.' }
Copy-Item $mpv.FullName (Join-Path $bin 'mpv-x86_64-pc-windows-msvc.exe') -Force
Write-Host 'mpv prêt pour la compilation Tauri.'
