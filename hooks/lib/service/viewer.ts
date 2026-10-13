// Opens a picture in the system's default viewer.

import { openCommand } from '../platform/scripts'
import { tryRun } from './host'
import type { System } from './system'

export async function openInViewer(system: System, path: string): Promise<{ ok: boolean; reason?: string }> {
  const tools = await system.tools()
  let target = path
  if (system.platform === 'wsl' && !tools.has('wslview')) {
    const windowsPath = await system.toWindowsPath(path)
    if (windowsPath === null) return { ok: false, reason: 'wslpath could not map the path' }
    target = windowsPath
  }
  if (system.platform === 'linux' && !tools.has('xdg-open')) return { ok: false, reason: 'xdg-open is not installed' }
  const result = await tryRun(system.host, openCommand(system.platform, target, tools), { timeoutMs: 15000 })
  // explorer.exe exits 1 even when it opened the file.
  if (result === null) return { ok: false, reason: 'the viewer did not start' }
  if (result.exitCode !== 0 && system.platform !== 'windows' && !(system.platform === 'wsl' && !tools.has('wslview'))) {
    return { ok: false, reason: result.stderr.trim().split(/\r?\n/)[0] || `exit code ${result.exitCode}` }
  }
  return { ok: true }
}
