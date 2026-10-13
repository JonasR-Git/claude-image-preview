// Real pictures over the colored blocks on Windows. The helper (overlay.cs,
// beside this file) is compiled once per version into the work root and run
// through PowerShell; this module builds that run and the state it reads.

import { psString } from './scripts'

/** One tile drawn as blocks: its picture's cells, the rows of the tile above and below the picture, the file. */
export type OverlayTile = { columns: number; rows: number; above: number; below: number; path: string }

/** Why the helper ended on its own: no console among its ancestors, or a terminal it cannot place pictures in. */
export const OVERLAY_NO_CONSOLE = 2
export const OVERLAY_UNSUPPORTED = 3
/** The helper did not compile or load; overlay.log says why. */
export const OVERLAY_BROKEN = 4

/** The assemblies the helper uses besides System and System.Core. */
const ASSEMBLIES = [
  'System.Windows.Forms',
  'System.Drawing',
  'PresentationCore',
  'WindowsBase',
  'System.Xaml',
  'UIAutomationClient',
  'UIAutomationTypes',
]

/**
 * The state file: one tab-separated line per tile, a lone newline for none, so
 * an empty file is one caught mid-write. A path that would break a line is left out.
 */
export function overlayState(tiles: readonly OverlayTile[]): string {
  const lines = tiles
    .filter(tile => !/[\t\r\n]/.test(tile.path))
    .map(tile => `${tile.columns}\t${tile.rows}\t${tile.above}\t${tile.below}\t${tile.path}\n`)
  return lines.length === 0 ? '\n' : lines.join('')
}

/**
 * Runs the helper on `state`. The compiled helper is kept in `cache`, a folder
 * of the user's own, under the hash of its source, so only the first start of a
 * version pays for the compiler; a start racing another compiles to a file of
 * its own, and helpers of older versions are cleared then. The compiler is
 * called directly: Add-Type cannot write to a path with brackets in it. What
 * fails before the helper runs goes to overlay.log beside `state`.
 */
export function windowsOverlay(source: string, state: string, cache: string): string {
  return `
$ErrorActionPreference = 'Stop'
$source = ${psString(source)}
$cache = ${psString(cache)}
$state = ${psString(state)}
try {
  $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0, 16)
  $dll = [System.IO.Path]::Combine($cache, "overlay-$hash.dll")
  if (-not [System.IO.File]::Exists($dll)) {
    [System.IO.Directory]::CreateDirectory($cache) | Out-Null
    foreach ($old in [System.IO.Directory]::GetFiles($cache, 'overlay-*')) {
      if ([System.IO.File]::GetLastWriteTimeUtc($old) -lt [DateTime]::UtcNow.AddHours(-1)) {
        try { [System.IO.File]::Delete($old) } catch { }
      }
    }
    $partial = "$dll.$PID.tmp"
    $references = @('System.dll', 'System.Core.dll') + @(${ASSEMBLIES.map(name => psString(name)).join(', ')} | ForEach-Object { [System.Reflection.Assembly]::LoadWithPartialName($_).Location })
    $options = New-Object System.CodeDom.Compiler.CompilerParameters (, [string[]]$references)
    $options.OutputAssembly = $partial
    $options.CompilerOptions = '/target:library /optimize'
    $built = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($options, [System.IO.File]::ReadAllText($source))
    $errors = @($built.Errors | Where-Object { -not $_.IsWarning } | Select-Object -First 3 | ForEach-Object { "line $($_.Line): $($_.ErrorText)" })
    if ($errors.Count -gt 0) { throw ('the helper did not compile: ' + ($errors -join '; ')) }
    try { [System.IO.File]::Move($partial, $dll) } catch { $dll = $partial }
  }
  if (-not ('ImagePreviewOverlay' -as [type])) { Add-Type -LiteralPath $dll }
} catch {
  $log = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($state), 'overlay.log')
  try { [System.IO.File]::AppendAllText($log, (Get-Date -Format 'HH:mm:ss ') + "start failed: $_" + [Environment]::NewLine) } catch { }
  exit ${OVERLAY_BROKEN}
}
exit [ImagePreviewOverlay]::Run($state, $true)
`
}
