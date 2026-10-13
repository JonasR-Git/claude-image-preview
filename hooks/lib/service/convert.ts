// Converts what the built-in decoders cannot read (HEIC, AVIF, TIFF, ICO, a
// file over the read limit, ...) to a small PNG with a tool the system has:
// Windows Imaging Component through PowerShell, `sips` on macOS, ImageMagick,
// libvips, dwebp or ffmpeg elsewhere.

import {
  linuxConverters,
  lastJson,
  macConvert,
  macSize,
  parseMacSize,
  powershell,
  windowsConvert,
} from '../platform/scripts'
import { dirname, join } from '../platform/paths'
import type { PathStyle } from '../platform/paths'
import type { ImageFormat } from '../codec/sniff'
import { tryRun } from './host'
import type { Host } from './host'
import type { System } from './system'

export type Converted = { ok: true; width?: number; height?: number } | { ok: false; reason: string }

async function produced(host: Host, path: string): Promise<boolean> {
  const stat = await host.stat(path)
  return stat !== null && stat.kind === 'file' && stat.size > 0
}

async function viaPowerShell(system: System, source: string, target: string, maxSide: number): Promise<Converted> {
  const shell = system.powershell
  if (shell === null) return { ok: false, reason: 'PowerShell is not available' }
  let from = source
  let to = target
  if (system.platform === 'wsl') {
    const windowsSource = await system.toWindowsPath(source)
    const windowsTarget = await system.toWindowsPath(target)
    if (windowsSource === null || windowsTarget === null)
      return { ok: false, reason: 'wslpath could not map the paths' }
    from = windowsSource
    to = windowsTarget
  }
  const result = await tryRun(system.host, powershell(shell, windowsConvert(from, to, maxSide)), { timeoutMs: 30000 })
  if (result === null) return { ok: false, reason: 'PowerShell did not start or timed out' }
  if (result.exitCode !== 0 || !(await produced(system.host, target))) {
    const why = result.stderr.trim().split(/\r?\n/)[0] ?? ''
    return {
      ok: false,
      reason: why === '' ? 'Windows has no codec for this format' : `Windows could not convert it: ${why}`,
    }
  }
  const size = lastJson<{ width: number; height: number }>(result.stdout)
  return { ok: true, width: size?.width, height: size?.height }
}

/** Makes the folder `path` goes in: `$.fs.write` creates folders as needed, the tools do not. */
export async function ensureFolderOf(host: Host, style: PathStyle, path: string): Promise<void> {
  try {
    await host.writeText(join(style, dirname(path), '.image-preview'), '')
  } catch {
    // The tool reports the real problem.
  }
}

/**
 * Writes a PNG of `source`, no larger than `maxSide`, to `target`. `format` is
 * what the file's first bytes said or, past the read limit, its extension: a
 * converter is never handed a file nothing marks as a picture.
 */
export async function convertToPng(
  system: System,
  source: string,
  target: string,
  maxSide: number,
  format: ImageFormat,
): Promise<Converted> {
  const host = system.host
  await ensureFolderOf(host, system.style, target)
  switch (system.platform) {
    case 'windows':
      return viaPowerShell(system, source, target, maxSide)
    case 'macos': {
      const result = await tryRun(host, macConvert(source, target, maxSide), { timeoutMs: 30000 })
      if (result === null || result.exitCode !== 0 || !(await produced(host, target))) {
        return { ok: false, reason: 'sips could not convert it' }
      }
      const size = await tryRun(host, macSize(source), { timeoutMs: 10000 })
      const dims = size === null ? null : parseMacSize(size.stdout)
      return { ok: true, width: dims?.width, height: dims?.height }
    }
    default: {
      const tools = await system.tools()
      for (const argv of linuxConverters(tools, source, target, maxSide, format)) {
        const result = await tryRun(host, argv, { timeoutMs: 30000 })
        if (result !== null && result.exitCode === 0 && (await produced(host, target))) return { ok: true }
      }
      if (system.platform === 'wsl') return viaPowerShell(system, source, target, maxSide)
      return { ok: false, reason: 'no converter found: install ImageMagick, libvips or ffmpeg' }
    }
  }
}
