# Checks licence + archive size of a Sketchfab model, and optionally downloads it into <OutRoot>\<slug>\ (default: NOAHS EXPERIMENT\safari animals).
# The API token is read from the machine-level SKETCHFAB_API_TOKEN, only ever sent to api.sketchfab.com,
# never printed and never written to disk.
#
#   .\fetch-model.ps1 -Uid <uid> -Slug sardine             # report licence + size only
#   .\fetch-model.ps1 -Uid <uid> -Slug sardine -Download   # fetch and unzip
param([Parameter(Mandatory)][string]$Uid, [Parameter(Mandatory)][string]$Slug, [switch]$Download,
      [string]$OutRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'models\raw'))
$ErrorActionPreference = 'Stop'

$token = [Environment]::GetEnvironmentVariable('SKETCHFAB_API_TOKEN', 'Machine')
if (-not $token) { throw 'Machine-level SKETCHFAB_API_TOKEN is not set.' }

$meta = Invoke-RestMethod "https://api.sketchfab.com/v3/models/$Uid"
if ($meta.license.slug -notin @('cc0', 'by')) { throw "Licence is '$($meta.license.label)' - not CC0/CC-BY, refusing." }

$dl = Invoke-RestMethod "https://api.sketchfab.com/v3/models/$Uid/download" -Headers @{ Authorization = "Token $token" }
$g = $dl.gltf
[pscustomobject]@{
  slug = $Slug; name = $meta.name; author = $meta.user.username; licence = $meta.license.label
  faces = $meta.faceCount; zipMB = [math]::Round($g.size / 1MB, 1); page = $meta.viewerUrl
}
if (-not $Download) { return }

$dest = Join-Path $OutRoot $Slug
New-Item -ItemType Directory -Force $dest | Out-Null
$zip = Join-Path $env:TEMP "sketchfab-$Uid.zip"
Invoke-WebRequest $g.url -OutFile $zip -UseBasicParsing   # signed URL, no token header
Expand-Archive $zip $dest -Force
Remove-Item $zip

@"
Model:   $($meta.name)
Author:  $($meta.user.displayName) (@$($meta.user.username))
Source:  $($meta.viewerUrl)
Licence: $($meta.license.label)  ($($meta.license.url))
Fetched: $(Get-Date -Format 'yyyy-MM-dd HH:mm')
"@ | Out-File (Join-Path $dest 'LICENSE.txt') -Encoding utf8
Get-ChildItem $dest -Recurse -File | Select-Object FullName, Length

