param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile([IO.Path]::GetFullPath($Source))
$bitmap = [System.Drawing.Bitmap]::new($sourceImage, 256, 256)
$stream = [IO.MemoryStream]::new()
try {
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $stream.ToArray()
  $output = [IO.File]::Create([IO.Path]::GetFullPath($Destination))
  $writer = [IO.BinaryWriter]::new($output)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
  } finally { $writer.Dispose() }
} finally { $stream.Dispose(); $bitmap.Dispose(); $sourceImage.Dispose() }
