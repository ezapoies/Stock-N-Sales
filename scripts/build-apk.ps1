$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$androidProject = Join-Path $projectRoot "android"
$sdkDirectory = $env:ANDROID_HOME
if (-not $sdkDirectory) {
    $sdkDirectory = $env:ANDROID_SDK_ROOT
}
if (-not $sdkDirectory) {
    $sdkDirectory = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
if (Test-Path $sdkDirectory) {
    $env:ANDROID_HOME = $sdkDirectory
    $env:ANDROID_SDK_ROOT = $sdkDirectory
}

$javaExecutable = $null
if ($env:JAVA_HOME) {
    $configuredJava = Join-Path $env:JAVA_HOME "bin\java.exe"
    if (Test-Path $configuredJava) {
        $javaExecutable = $configuredJava
    }
}

if (-not $javaExecutable) {
    foreach ($jdkRoot in @(
        (Join-Path $env:LOCALAPPDATA "Programs\Eclipse Adoptium"),
        "C:\Program Files\Eclipse Adoptium",
        "C:\Program Files\Java"
    )) {
        if (-not (Test-Path $jdkRoot)) {
            continue
        }
        $jdkDirectory = Get-ChildItem $jdkRoot -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($jdkDirectory) {
            $candidate = Join-Path $jdkDirectory.FullName "bin\java.exe"
            if (Test-Path $candidate) {
                $javaExecutable = $candidate
                break
            }
        }
    }
}

if (-not $javaExecutable) {
    $javaExecutable = (Get-Command "java.exe" -ErrorAction SilentlyContinue).Source
}

if (-not $javaExecutable -or -not (Test-Path $javaExecutable)) {
    throw "Java was not found. Install JDK 17 and set JAVA_HOME to its installation folder."
}

$javaHome = Split-Path (Split-Path $javaExecutable -Parent) -Parent
$env:JAVA_HOME = $javaHome
$env:Path = "$(Join-Path $javaHome 'bin');$env:Path"
$javaVersionOutput = (& $env:ComSpec /c ('"{0}" -version 2>&1' -f $javaExecutable) | Out-String)
if ($javaVersionOutput -match 'version "(\d+)(?:\.(\d+))?') {
    $javaMajorVersion = [int]$Matches[1]
    if ($javaMajorVersion -eq 1) {
        $javaMajorVersion = [int]$Matches[2]
    }
} else {
    throw "Could not detect the Java version from $javaExecutable."
}
if ($javaMajorVersion -ne 21) {
    throw "This Capacitor Android project requires JDK 21. Gradle would use Java $javaMajorVersion at $javaExecutable. Set JAVA_HOME to a JDK 21 installation."
}
Write-Output "Building with Java $javaMajorVersion at $javaExecutable"
if (-not $sdkDirectory -or -not (Test-Path (Join-Path $sdkDirectory "platforms\android-35\android.jar"))) {
    throw "Install Android SDK Platform 35 and set ANDROID_HOME or ANDROID_SDK_ROOT."
}
if (-not (Test-Path (Join-Path $sdkDirectory "build-tools\35.0.0"))) {
    throw "Install Android SDK Build-Tools 35.0.0 in the configured Android SDK."
}

Push-Location $projectRoot
try {
    npm run android:sync
    if ($LASTEXITCODE -ne 0) {
        throw "Capacitor asset sync failed with exit code $LASTEXITCODE."
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $PSScriptRoot "generate-android-icons.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Android app icon generation failed with exit code $LASTEXITCODE."
    }

    Push-Location $androidProject
    try {
        & .\gradlew.bat --stop
        if ($LASTEXITCODE -ne 0) {
            throw "Could not stop existing Gradle daemons with exit code $LASTEXITCODE."
        }

        & .\gradlew.bat assembleDebug
        if ($LASTEXITCODE -ne 0) {
            throw "Android build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    $apkPath = Join-Path $androidProject "app\build\outputs\apk\debug\app-debug.apk"
    if (-not (Test-Path $apkPath)) {
        throw "Gradle completed but the debug APK was not found at $apkPath."
    }
    Write-Output "APK created: $apkPath"
} finally {
    Pop-Location
}
