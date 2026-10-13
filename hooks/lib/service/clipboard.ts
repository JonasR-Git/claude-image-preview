// The system clipboard, both ways: pictures out of it (pixels, or copied image
// files) and a picture into it, so it can be pasted into a chat or a document
// without saving it first.

import { looksLikeImagePath } from '../codec/sniff'
import type { ImageFormat } from '../codec/sniff'
import { join } from '../platform/paths'
import {
  LINUX_IMAGE_TYPES,
  MIME,
  filesFromUriList,
  lastJson,
  linuxCopy,
  linuxListTypes,
  linuxReadText,
  linuxSave,
  macClipboardRead,
  macClipboardWrite,
  powershell,
  windowsClipboardRead,
  windowsClipboardWrite,
} from '../platform/scripts'
import type { LinuxClipboard } from '../platform/scripts'
import { convertToPng } from './convert'
import { tryRun } from './host'
import type { System } from './system'

export type ClipboardRead = { files: string[]; reason?: string }

/** A file name for a capture, unique within the session. */
function captureName(now: number, extension: string): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-')
  return `clipboard-${stamp}-${(now % 1000).toString().padStart(3, '0')}.${extension}`
}

async function linuxClipboard(system: System): Promise<LinuxClipboard | null> {
  const tools = await system.tools()
  if (system.env.WAYLAND_DISPLAY && tools.has('wl-paste')) return 'wayland'
  if (system.env.DISPLAY && tools.has('xclip')) return 'x11'
  if (tools.has('wl-paste')) return 'wayland'
  if (tools.has('xclip')) return 'x11'
  return null
}

async function readWindows(system: System, workDir: string, now: number): Promise<ClipboardRead> {
  const shell = system.powershell!
  let target = join(system.style, workDir, captureName(now, 'png'))
  if (system.platform === 'wsl') {
    // PowerShell writes to Windows' own temp folder; Linux reads it through /mnt.
    const temp = await system.windowsTemp()
    if (temp === null) return { files: [], reason: 'powershell.exe is not reachable from WSL' }
    target = `${temp}\\claude-image-preview\\${captureName(now, 'png')}`
  }
  const result = await tryRun(system.host, powershell(shell, windowsClipboardRead(target), true), { timeoutMs: 20000 })
  if (result === null) return { files: [], reason: 'PowerShell did not start or timed out' }
  const parsed = lastJson<{ files: string[] }>(result.stdout)
  if (parsed === null)
    return { files: [], reason: result.stderr.trim().split(/\r?\n/)[0] || 'the clipboard could not be read' }
  if (system.platform !== 'wsl') return { files: parsed.files }
  const files: string[] = []
  for (const file of parsed.files) {
    const local = await system.fromWindowsPath(file)
    if (local !== null) files.push(local)
  }
  return { files }
}

async function readMac(system: System, workDir: string, now: number): Promise<ClipboardRead> {
  const target = join('posix', workDir, captureName(now, 'png'))
  const result = await tryRun(system.host, macClipboardRead(target), { timeoutMs: 20000 })
  if (result === null) return { files: [], reason: 'osascript did not start or timed out' }
  const parsed = lastJson<{ files: string[] }>(result.stdout)
  if (parsed === null)
    return { files: [], reason: result.stderr.trim().split(/\r?\n/)[0] || 'the clipboard could not be read' }
  return { files: parsed.files }
}

async function readLinux(system: System, workDir: string, now: number): Promise<ClipboardRead> {
  const kind = await linuxClipboard(system)
  if (kind === null)
    return { files: [], reason: 'no clipboard tool found: install wl-clipboard (Wayland) or xclip (X11)' }
  const host = system.host
  const listed = await tryRun(host, linuxListTypes(kind), { timeoutMs: 5000 })
  if (listed === null || listed.exitCode !== 0) return { files: [], reason: 'the clipboard is empty' }
  const types = new Set(
    listed.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean),
  )

  for (const listType of ['text/uri-list', 'x-special/gnome-copied-files']) {
    if (!types.has(listType)) continue
    const text = await tryRun(host, linuxReadText(kind, listType), { timeoutMs: 5000 })
    const files = filesFromUriList(text?.stdout ?? '')
    if (files.length > 0) return { files }
  }
  const offered = LINUX_IMAGE_TYPES.find(([type]) => types.has(type))
  if (offered === undefined) return { files: [] }
  const target = join('posix', workDir, captureName(now, offered[1]))
  const saved = await tryRun(host, linuxSave(kind, offered[0], target), { timeoutMs: 15000 })
  const stat = await host.stat(target)
  if (saved === null || saved.exitCode !== 0 || stat === null || stat.size === 0) {
    return { files: [], reason: 'the clipboard picture could not be saved' }
  }
  return { files: [target] }
}

/** Saves the pictures on the clipboard (or names the copied picture files) and returns their paths. */
export async function readClipboard(system: System, workDir: string): Promise<ClipboardRead> {
  const now = await system.host.now()
  let read: ClipboardRead
  switch (system.platform) {
    case 'windows':
    case 'wsl':
      read = await readWindows(system, workDir, now)
      break
    case 'macos':
      read = await readMac(system, workDir, now)
      break
    default:
      read = await readLinux(system, workDir, now)
  }
  return { ...read, files: read.files.filter(file => looksLikeImagePath(file)) }
}

const WINDOWS_NATIVE: ReadonlySet<ImageFormat> = new Set(['png', 'jpeg', 'gif', 'bmp', 'tiff'])

/** Puts the picture at `path` on the clipboard; formats other apps may not take are sent as PNG. */
export async function copyToClipboard(
  system: System,
  path: string,
  format: ImageFormat | undefined,
  workDir: string,
): Promise<{ ok: boolean; reason?: string }> {
  const host = system.host
  const asPng = async (): Promise<string | null> => {
    const target = join(system.style, workDir, `copy-${(await host.now()).toString(36)}.png`)
    if (format === undefined || format === 'svg') return null
    const converted = await convertToPng(system, path, target, 8192, format)
    return converted.ok ? target : null
  }

  if (system.platform === 'windows' || system.platform === 'wsl') {
    let source = path
    if (format === undefined || !WINDOWS_NATIVE.has(format)) {
      const png = await asPng()
      if (png === null) return { ok: false, reason: 'Windows could not convert this format' }
      source = png
    }
    if (system.platform === 'wsl') {
      const windowsPath = await system.toWindowsPath(source)
      if (windowsPath === null) return { ok: false, reason: 'wslpath could not map the path' }
      source = windowsPath
    }
    const result = await tryRun(host, powershell(system.powershell!, windowsClipboardWrite(source), true), {
      timeoutMs: 20000,
    })
    return result !== null && result.exitCode === 0
      ? { ok: true }
      : { ok: false, reason: result?.stderr.trim().split(/\r?\n/)[0] || 'PowerShell failed' }
  }

  if (system.platform === 'macos') {
    const result = await tryRun(host, macClipboardWrite(path), { timeoutMs: 20000 })
    return result !== null && result.stdout.trim() === 'ok'
      ? { ok: true }
      : { ok: false, reason: 'macOS could not read the picture' }
  }

  const kind = await linuxClipboard(system)
  if (kind === null)
    return { ok: false, reason: 'no clipboard tool found: install wl-clipboard (Wayland) or xclip (X11)' }
  let source = path
  let type = format === undefined ? undefined : MIME[format]
  if (type !== 'image/png' && type !== 'image/jpeg') {
    // Most apps take PNG; convert when a converter exists, else offer the file as it is.
    const png = await asPng()
    if (png !== null) {
      source = png
      type = 'image/png'
    }
  }
  if (type === undefined) return { ok: false, reason: 'this format cannot be offered on the clipboard' }
  const result = await tryRun(host, linuxCopy(kind, type, source), { timeoutMs: 10000 })
  return result !== null && result.exitCode === 0 ? { ok: true } : { ok: false, reason: 'the clipboard tool failed' }
}
