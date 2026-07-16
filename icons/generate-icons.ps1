# Regenerates the app icon set from the official Tacillon logo.
# Source: C:\LT\Tacillo_logo_only.png (founder-provided, 2026-07-14).
# Output: icon-192.png (favicon + apple-touch), icon-512.png,
#         icon-maskable-512.png (logo shrunk into Android's 80% safe zone,
#         padded with the logo's own background color).
# Uses built-in Windows drawing (GDI+), no external software required.

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPath = 'C:\LT\Tacillo_logo_only.png'
if (-not (Test-Path $srcPath)) { throw "Logo source not found: $srcPath" }

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$bg = $src.GetPixel(2, 2)   # pad with the logo's own background color
$side = [Math]::Min($src.Width, $src.Height)
$cropX = [int](($src.Width - $side) / 2)
$cropY = [int](($src.Height - $side) / 2)

function New-Icon([int]$size, [double]$logoScale, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear($script:bg)
  $target = [int]($size * $logoScale)
  $off = [int](($size - $target) / 2)
  $destRect = New-Object System.Drawing.Rectangle($off, $off, $target, $target)
  $srcRect = New-Object System.Drawing.Rectangle($script:cropX, $script:cropY, $script:side, $script:side)
  $g.DrawImage($script:src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $out = Join-Path $here $name
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $out ($size x $size)"
}

New-Icon 192 1.0 'icon-192.png'
New-Icon 512 1.0 'icon-512.png'
# Full-bleed for maskable too: the logo art carries its own margin around the
# mark, and padding with a flat color leaves a visible seam against the logo's
# textured background. Android's circle/squircle masks keep the mark visible.
New-Icon 512 1.0 'icon-maskable-512.png'
$src.Dispose()
