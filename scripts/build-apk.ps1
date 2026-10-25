# Build an installable Android APK on this PC (no Expo account, no paid cloud build).
# (ASCII only on purpose: Windows PowerShell 5.1 misreads UTF-8 files without a BOM.)
#
# Usage (PowerShell, project root):
#   powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
#   ... -Public   key-free APK for public download (no Google key inside; maps use OpenStreetMap)
#
# The first run shows the Android SDK licence agreements for YOU to read and accept (type y),
# then downloads about 3-4 GB of SDK / NDK.
# Output: android\app\build\outputs\apk\release\app-release.apk
# Release APKs are signed with the private key in .secrets (see plugins/withReleaseSigning.js).

param([switch]$Public)

$ErrorActionPreference = 'Stop'

function Find-ApiKeyInApk([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  $Found = @()
  try {
    foreach ($E in $Zip.Entries) {
      if ($E.Length -eq 0) { continue }
      $S = $E.Open(); $M = New-Object System.IO.MemoryStream; $S.CopyTo($M); $S.Close()
      $B = $M.ToArray()
      $Text = [System.Text.Encoding]::GetEncoding(28591).GetString($B) + [System.Text.Encoding]::Unicode.GetString($B)
      if ($Text -match 'AIza[0-9A-Za-z_-]{30}') { $Found += $E.FullName }
    }
  } finally { $Zip.Dispose() }
  return ,$Found
}

$Tools = if ($env:ROUTE_TOOLS) { $env:ROUTE_TOOLS } else { Join-Path $env:USERPROFILE 'tools' }

$Node = Get-ChildItem $Tools -Directory -Filter 'node-v24*' | Select-Object -First 1
$Jdk = Get-ChildItem $Tools -Directory -Filter 'jdk-17*' | Select-Object -First 1
$Sdk = Join-Path $Tools 'android-sdk'
if (-not $Node -or -not $Jdk -or -not (Test-Path "$Sdk\cmdline-tools\latest\bin\sdkmanager.bat")) {
  throw "Node 24 / JDK 17 / Android cmdline-tools not found in $Tools (see docs/DEVELOPMENT.md, 'Build APK')"
}

$env:PATH = "$($Node.FullName);$($Jdk.FullName)\bin;$Sdk\platform-tools;$env:PATH"
$env:JAVA_HOME = $Jdk.FullName
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
# cmdline-tools 23+ replaced sdkmanager with the "android" CLI. Its first run shows the Android SDK
# Terms (https://developer.android.com/studio/terms); --no-metrics turns off usage-data collection.
$AndroidCli = "$Sdk\cmdline-tools\latest\bin\android.exe"

Write-Host '== 1/4 Android SDK terms: https://developer.android.com/studio/terms (installing means you accept them)'
Write-Host '== 2/4 SDK packages (versions from react-native/gradle/libs.versions.toml)'
& $AndroidCli --no-metrics "--sdk=$Sdk" sdk install platform-tools platforms/android-37.0 build-tools/37.0.0 cmake/3.31.6 ndk/27.1.12297006
if ($LASTEXITCODE -ne 0) { throw 'android sdk install failed' }

# Release builds are signed with the private key in .secrets (see plugins/withReleaseSigning.js).
$Signing = Join-Path (Split-Path $PSScriptRoot -Parent) '.secrets\release-signing.properties'
if (-not (Test-Path $Signing)) {
  throw "Private signing config not found: $Signing. Restore route-release.jks and release-signing.properties from your backup."
}

Write-Host '== 3/4 Generate native project (android/ comes from app.json; do not edit by hand)'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  if ($Public) {
    # Public build: no API key in the manifest or the JS bundle. --clean so an older manifest with a key is not reused.
    $env:ROUTE_PUBLIC_BUILD = '1'
    npx expo prebuild -p android --no-install --clean
  } else {
    Remove-Item Env:ROUTE_PUBLIC_BUILD -ErrorAction SilentlyContinue
    npx expo prebuild -p android --no-install
  }
  # CMake 3.31.6 ships ninja 1.12 (long-path aware). The default CMake 3.22.1 ninja fails on Windows
  # with "Filename longer than 260 characters" when compiling react-native-gesture-handler.
  $SdkFwd = $Sdk -replace '\\', '/'
  Set-Content -Path 'android\local.properties' -Value @("sdk.dir=$SdkFwd", "cmake.dir=$SdkFwd/cmake/3.31.6") -Encoding ascii

  Write-Host '== 4/4 Gradle release build'
  Push-Location android
  try {
    .\gradlew.bat assembleRelease --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed' }
  } finally { Pop-Location }
  $Apk = 'android\app\build\outputs\apk\release\app-release.apk'
  $Expected = ((Get-Content $Signing | Where-Object { $_ -like 'certSha1=*' }) -replace '^certSha1=', '' -replace ':', '').ToLower()
  $Certs = & "$Sdk\build-tools\37.0.0\apksigner.bat" verify --print-certs $Apk
  if (-not ($Certs -match "SHA-1 digest: $Expected")) { throw "APK is not signed with the private key (expected SHA-1 $Expected)" }
  Write-Host "Signed with private key (SHA-1 $Expected)"
  if ($Public) {
    # Prove that no Google key ended up in the APK (manifest, resources or JS bundle).
    # Read entries in memory (resource names can collide on Windows); search ASCII and UTF-16 (binary XML).
    if ((Find-ApiKeyInApk (Resolve-Path $Apk).Path).Count -gt 0) { throw 'Public APK contains a Google API key - do not publish it' }
    Write-Host 'Public build: no Google API key inside the APK'
  }
  Write-Host "Done: $((Resolve-Path $Apk).Path)"
} finally { Pop-Location }
