$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot "android\app\src\main\res"
$logoPath = Join-Path $projectRoot "Logo.png"

if (-not (Test-Path $logoPath)) {
    throw "Stock N Sales logo was not found."
}

Add-Type -AssemblyName System.Drawing
$logo = [System.Drawing.Image]::FromFile($logoPath)
$densitySizes = @{
    "mdpi" = @{ Launcher = 48; Foreground = 108 }
    "hdpi" = @{ Launcher = 72; Foreground = 162 }
    "xhdpi" = @{ Launcher = 96; Foreground = 216 }
    "xxhdpi" = @{ Launcher = 144; Foreground = 324 }
    "xxxhdpi" = @{ Launcher = 192; Foreground = 432 }
}

try {
    foreach ($density in $densitySizes.Keys) {
        $directory = Join-Path $resourceRoot "mipmap-$density"
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        foreach ($type in @("Launcher", "Foreground")) {
            $size = $densitySizes[$density][$type]
            $image = New-Object System.Drawing.Bitmap($size, $size)
            $graphics = [System.Drawing.Graphics]::FromImage($image)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            if ($type -eq "Launcher") {
                $graphics.Clear([System.Drawing.Color]::FromArgb(7, 26, 44))
                $padding = [int]($size * 0.12)
            } else {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $padding = [int]($size * 0.22)
            }
            $scale = [Math]::Min(
                ($size - $padding * 2) / $logo.Width,
                ($size - $padding * 2) / $logo.Height
            )
            $width = [int]($logo.Width * $scale)
            $height = [int]($logo.Height * $scale)
            $x = [int](($size - $width) / 2)
            $y = [int](($size - $height) / 2)
            $graphics.DrawImage($logo, $x, $y, $width, $height)
            $fileName = if ($type -eq "Launcher") { "ic_launcher.png" } else { "ic_launcher_foreground.png" }
            $image.Save(
                (Join-Path $directory $fileName),
                [System.Drawing.Imaging.ImageFormat]::Png
            )
            if ($type -eq "Launcher") {
                $image.Save(
                    (Join-Path $directory "ic_launcher_round.png"),
                    [System.Drawing.Imaging.ImageFormat]::Png
                )
            }
            $graphics.Dispose()
            $image.Dispose()
        }
    }
} finally {
    $logo.Dispose()
}
