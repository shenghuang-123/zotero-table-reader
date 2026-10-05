# Zotero CSV Reader packager
# 用法：右键“使用 PowerShell 运行”，或
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = $PSScriptRoot
$src = Join-Path $root "Zotero-CsvReader"
$xpi = Join-Path $root "csvreader@zotero.local.xpi"

if (-not (Test-Path $src)) {
	Write-Host ("Source folder not found: " + $src)
	Read-Host "Press Enter to close"
	exit 1
}
if (Test-Path $xpi) { Remove-Item $xpi -Force }

$zip = [System.IO.Compression.ZipFile]::Open($xpi, [System.IO.Compression.ZipArchiveMode]::Create)
try {
	Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
		$rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
			$zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal
		) | Out-Null
	}
}
finally {
	$zip.Dispose()
}

Write-Host ("Done: " + $xpi + " (" + (Get-Item $xpi).Length + " bytes)")
Write-Host "Install it in Zotero: Tools - Plugins - gear - Install Plugin From File"
Read-Host "Press Enter to close"
