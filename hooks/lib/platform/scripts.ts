// The commands the mod runs on each system: read the clipboard, put a picture
// on it, convert a format the built-in decoders do not read, open a file.
//
// Every command is an argument vector, never a shell line built from a path.
// PowerShell scripts travel as -EncodedCommand (UTF-16LE, base64) with paths
// embedded as single-quoted literals; POSIX helpers use `sh -c` with the paths
// as positional arguments.

import { toBase64 } from '../codec/base64'
import type { ImageFormat } from '../codec/sniff'

export type Argv = string[]

/**
 * A PowerShell single-quoted string literal. PowerShell also ends such a string
 * at the typographic quotes U+2018 to U+201B, so those are doubled as well.
 */
export function psString(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, '$&$&')}'`
}

/** UTF-16LE base64, the form -EncodedCommand takes. */
export function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return toBase64(bytes)
}

/** `powershell` on Windows, `powershell.exe` through WSL interop. */
export function powershell(executable: string, script: string, sta = false): Argv {
  const argv = [executable, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  if (sta) argv.push('-Sta')
  argv.push('-EncodedCommand', encodePowerShell(`$ProgressPreference = 'SilentlyContinue'\n${script}`))
  return argv
}

const IMAGE_EXTENSIONS_PS =
  "'.png','.jpg','.jpeg','.jpe','.jfif','.gif','.webp','.bmp','.dib','.tif','.tiff','.heic','.heif','.avif','.ico'"

/**
 * Reads pictures from the Windows clipboard. Copied image files win over
 * pixels; pixels are saved as PNG to `target`, the PNG format first so alpha
 * survives, then the bitmap. Prints one JSON line: {"files":[...]}.
 */
export function windowsClipboardRead(target: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = ${psString(target)}
$files = New-Object System.Collections.Generic.List[string]
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  foreach ($file in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
    if (@(${IMAGE_EXTENSIONS_PS}) -contains [System.IO.Path]::GetExtension($file).ToLowerInvariant()) { $files.Add($file) }
  }
}
if ($files.Count -eq 0) {
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
  $data = [System.Windows.Forms.Clipboard]::GetDataObject()
  $png = $null
  if ($data -ne $null -and $data.GetDataPresent('PNG')) { $png = $data.GetData('PNG') }
  if ($png -is [System.IO.MemoryStream]) {
    [System.IO.File]::WriteAllBytes($target, $png.ToArray())
    $files.Add($target)
  } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    $image.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $image.Dispose()
    $files.Add($target)
  }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ('{"files":' + (ConvertTo-Json -Compress -InputObject @($files.ToArray())) + '}')
`
}

/** Puts a picture on the Windows clipboard as a bitmap, as PNG (keeping alpha) and as the file. */
export function windowsClipboardWrite(path: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = ${psString(path)}
$bytes = [System.IO.File]::ReadAllBytes($path)
$stream = New-Object System.IO.MemoryStream(,$bytes)
$image = [System.Drawing.Image]::FromStream($stream)
$data = New-Object System.Windows.Forms.DataObject
$data.SetImage($image)
if ([System.IO.Path]::GetExtension($path).ToLowerInvariant() -eq '.png') {
  $data.SetData('PNG', (New-Object System.IO.MemoryStream(,$bytes)))
}
$list = New-Object System.Collections.Specialized.StringCollection
[void]$list.Add($path)
$data.SetFileDropList($list)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
Write-Output 'ok'
`
}

/**
 * Converts any picture Windows Imaging Component reads (WebP, HEIC, TIFF, ICO,
 * JPEG XR, ... with the codecs installed) to a PNG no larger than `maxSide`.
 * Prints {"width":w,"height":h}, the source's size.
 */
export function windowsConvert(source: string, target: string, maxSide: number): string {
  return `
Add-Type -AssemblyName PresentationCore
$source = ${psString(source)}
$target = ${psString(target)}
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
$stream = [System.IO.File]::OpenRead($source)
try {
  $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $frame = $decoder.Frames[0]
  $scale = [Math]::Min(1.0, ${maxSide} / [Math]::Max($frame.PixelWidth, $frame.PixelHeight))
  $picture = $frame
  if ($scale -lt 1.0) {
    $picture = New-Object System.Windows.Media.Imaging.TransformedBitmap($frame, (New-Object System.Windows.Media.ScaleTransform($scale, $scale)))
  }
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($picture))
  $out = [System.IO.File]::Create($target)
  try { $encoder.Save($out) } finally { $out.Dispose() }
  Write-Output ('{"width":' + $frame.PixelWidth + ',"height":' + $frame.PixelHeight + '}')
} finally { $stream.Dispose() }
`
}

/** The Windows temp directory, as PowerShell sees it (used from WSL). */
export const WINDOWS_TEMP = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ([System.IO.Path]::GetTempPath())`

/**
 * macOS: reads copied files, else PNG or TIFF pixels (saved as PNG to argv[0]),
 * with JavaScript for Automation. Prints {"files":[...]}.
 */
export const MAC_CLIPBOARD_READ = `ObjC.import('AppKit')
function run(argv) {
  const target = argv[0]
  const board = $.NSPasteboard.generalPasteboard
  const files = []
  const urls = board.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }))
  if (urls && !urls.isNil()) {
    for (let i = 0; i < urls.count; i++) files.push(urls.objectAtIndex(i).path.js)
  }
  if (files.length === 0) {
    let data = board.dataForType('public.png')
    if (data.isNil()) {
      const tiff = board.dataForType('public.tiff')
      if (!tiff.isNil()) {
        const rep = $.NSBitmapImageRep.imageRepWithData(tiff)
        if (!rep.isNil()) data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
      }
    }
    if (!data.isNil()) {
      $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(target).stringByDeletingLastPathComponent, true, $(), $())
      if (data.writeToFileAtomically(target, true)) files.push(target)
    }
  }
  return JSON.stringify({ files })
}`

/** macOS: puts the picture at argv[0] on the clipboard (any format NSImage reads). */
export const MAC_CLIPBOARD_WRITE = `ObjC.import('AppKit')
function run(argv) {
  const image = $.NSImage.alloc.initWithContentsOfFile(argv[0])
  if (image.isNil()) return 'unreadable'
  const board = $.NSPasteboard.generalPasteboard
  board.clearContents
  board.writeObjects($([image]))
  return 'ok'
}`

export function macClipboardRead(target: string): Argv {
  return ['osascript', '-l', 'JavaScript', '-e', MAC_CLIPBOARD_READ, target]
}

export function macClipboardWrite(path: string): Argv {
  return ['osascript', '-l', 'JavaScript', '-e', MAC_CLIPBOARD_WRITE, path]
}

export function macConvert(source: string, target: string, maxSide: number): Argv {
  return ['sips', '-s', 'format', 'png', '-Z', String(maxSide), source, '--out', target]
}

export function macSize(source: string): Argv {
  return ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', source]
}

/** Parses `sips -g pixelWidth -g pixelHeight` output. */
export function parseMacSize(stdout: string): { width: number; height: number } | null {
  const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1]
  const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1]
  return width && height ? { width: Number(width), height: Number(height) } : null
}

/** The MIME type a clipboard tool offers a format under. */
export const MIME: Partial<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
}

/** Picture types a Linux clipboard may offer, best first, with the extension to save them under. */
export const LINUX_IMAGE_TYPES: readonly (readonly [string, string])[] = [
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['image/x-bmp', 'bmp'],
  ['image/tiff', 'tiff'],
  ['image/avif', 'avif'],
]

export type LinuxClipboard = 'wayland' | 'x11'

export function linuxListTypes(kind: LinuxClipboard): Argv {
  return kind === 'wayland' ? ['wl-paste', '--list-types'] : ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o']
}

export function linuxReadText(kind: LinuxClipboard, type: string): Argv {
  return kind === 'wayland'
    ? ['wl-paste', '--no-newline', '--type', type]
    : ['xclip', '-selection', 'clipboard', '-t', type, '-o']
}

/** Saves the clipboard's `type` data to a file: needs a shell for the redirect, so the values ride as arguments. */
export function linuxSave(kind: LinuxClipboard, type: string, target: string): Argv {
  const command =
    kind === 'wayland'
      ? 'mkdir -p "$(dirname "$2")" && wl-paste --type "$1" > "$2"'
      : 'mkdir -p "$(dirname "$2")" && xclip -selection clipboard -t "$1" -o > "$2"'
  return ['sh', '-c', command, 'image-preview', type, target]
}

/** Offers a file on the clipboard as `type`; the tool keeps serving it in the background. */
export function linuxCopy(kind: LinuxClipboard, type: string, path: string): Argv {
  const command =
    kind === 'wayland'
      ? 'wl-copy --type "$1" < "$2" > /dev/null 2>&1 &'
      : 'xclip -selection clipboard -t "$1" -i "$2" > /dev/null 2>&1 &'
  return ['sh', '-c', command, 'image-preview', type, path]
}

/** Which helper tools exist, one name per line. */
export const LINUX_TOOLS = [
  'wl-paste',
  'wl-copy',
  'xclip',
  'magick',
  'convert',
  'vipsthumbnail',
  'ffmpeg',
  'dwebp',
  'xdg-open',
  'wslview',
  'powershell.exe',
  'wslpath',
]

export function whichTools(names: readonly string[]): Argv {
  return [
    'sh',
    '-c',
    'for tool in "$@"; do command -v "$tool" > /dev/null 2>&1 && echo "$tool"; done',
    'image-preview',
    ...names,
  ]
}

/** The converters tried on Linux, in order, for a tool that exists. */
/** ImageMagick's name for each format: named, it reads the file as that and nothing else. */
const MAGICK_CODER: Partial<Record<ImageFormat, string>> = {
  png: 'png',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  tiff: 'tiff',
  heic: 'heic',
  avif: 'avif',
  ico: 'ico',
}

/**
 * The converters to try, best first. ImageMagick gets the format named, so a
 * file that only claims to be a picture never reaches its script-like coders
 * (MVG, MSL, text); ffmpeg reads local files only, never a playlist's URLs.
 */
export function linuxConverters(
  tools: ReadonlySet<string>,
  source: string,
  target: string,
  maxSide: number,
  format: ImageFormat,
): Argv[] {
  const box = `${maxSide}x${maxSide}>`
  const out: Argv[] = []
  const coder = MAGICK_CODER[format]
  for (const magick of ['magick', 'convert']) {
    if (tools.has(magick) && coder !== undefined)
      out.push([magick, `${coder}:${source}[0]`, '-auto-orient', '-thumbnail', box, `png:${target}`])
  }
  if (tools.has('vipsthumbnail')) out.push(['vipsthumbnail', source, '--size', `${maxSide}x${maxSide}>`, '-o', target])
  if (tools.has('dwebp') && format === 'webp') out.push(['dwebp', source, '-o', target])
  if (tools.has('ffmpeg')) {
    out.push([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file',
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
      target,
    ])
  }
  return out
}

/** Opens a file with its default application, detached. */
export function openCommand(
  platform: 'windows' | 'wsl' | 'macos' | 'linux',
  path: string,
  tools: ReadonlySet<string>,
): Argv {
  switch (platform) {
    case 'windows':
      return ['explorer.exe', path]
    case 'macos':
      return ['open', path]
    case 'wsl':
      if (tools.has('wslview')) return ['wslview', path]
      return ['explorer.exe', path]
    default:
      return ['sh', '-c', 'xdg-open "$1" > /dev/null 2>&1 &', 'image-preview', path]
  }
}

/** Parses the last JSON object line a helper printed; null when none parses. */
export function lastJson<T>(stdout: string): T | null {
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!) as T
    } catch {
      // keep looking
    }
  }
  return null
}

/** Decodes file:// URIs from a text/uri-list or GNOME copied-files payload. */
export function filesFromUriList(text: string): string[] {
  const files: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('file://')) continue
    try {
      const url = new URL(line)
      files.push(decodeURIComponent(url.pathname))
    } catch {
      // skip what does not parse
    }
  }
  return files
}
