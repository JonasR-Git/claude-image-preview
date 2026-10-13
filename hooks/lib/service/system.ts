// Facts about the machine, learned once per session and only when needed:
// the platform, which helper tools exist, and how WSL maps Windows paths.

import { guessPlatform, homeDirectory, pathStyle } from '../platform/os'
import type { Env, Platform } from '../platform/os'
import type { PathStyle } from '../platform/paths'
import { windowsToWsl } from '../platform/paths'
import { LINUX_TOOLS, WINDOWS_TEMP, powershell, whichTools } from '../platform/scripts'
import { tryRun } from './host'
import type { Host } from './host'

export class System {
  private toolsFound: Promise<ReadonlySet<string>> | undefined
  private windowsTempDir: Promise<string | null> | undefined

  private constructor(
    readonly host: Host,
    readonly env: Env,
    readonly platform: Platform,
  ) {}

  /** Settles the platform: the environment, then `uname -s` where it is not Windows. */
  static async detect(host: Host, env: Env): Promise<System> {
    let platform = guessPlatform(env)
    if (platform !== 'windows') {
      const uname = await tryRun(host, ['uname', '-sr'], { timeoutMs: 3000 })
      if (uname !== null && uname.exitCode === 0) platform = guessPlatform(env, uname.stdout.split(' ')[0])
      if (platform === 'linux' && uname !== null && /microsoft/i.test(uname.stdout)) platform = 'wsl'
    }
    return new System(host, env, platform)
  }

  /** For tests and callers that already know. */
  static known(host: Host, env: Env, platform: Platform): System {
    return new System(host, env, platform)
  }

  get style(): PathStyle {
    return pathStyle(this.platform)
  }

  get home(): string | undefined {
    return homeDirectory(this.env, this.platform)
  }

  /** The PowerShell executable for this platform, or null where there is none. */
  get powershell(): string | null {
    if (this.platform === 'windows') return 'powershell'
    if (this.platform === 'wsl') return 'powershell.exe'
    return null
  }

  /** Helper tools on PATH (POSIX only; Windows ships what the mod needs). */
  tools(): Promise<ReadonlySet<string>> {
    if (this.toolsFound === undefined) {
      this.toolsFound =
        this.platform === 'windows'
          ? Promise.resolve(new Set<string>())
          : tryRun(this.host, whichTools(LINUX_TOOLS), { timeoutMs: 5000 }).then(
              result =>
                new Set(
                  (result?.stdout ?? '')
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean),
                ),
            )
    }
    return this.toolsFound
  }

  /** WSL: a Linux path as Windows sees it (`\\wsl.localhost\...` or `C:\...`). */
  async toWindowsPath(path: string): Promise<string | null> {
    const result = await tryRun(this.host, ['wslpath', '-w', path], { timeoutMs: 5000 })
    return result !== null && result.exitCode === 0 ? result.stdout.trim() : null
  }

  /** WSL: a Windows path as Linux sees it, through `wslpath` or the /mnt drives. */
  async fromWindowsPath(path: string): Promise<string | null> {
    const result = await tryRun(this.host, ['wslpath', '-u', path], { timeoutMs: 5000 })
    if (result !== null && result.exitCode === 0 && result.stdout.trim() !== '') return result.stdout.trim()
    return windowsToWsl(path)
  }

  /** WSL: Windows' temp directory, as a Windows path. */
  windowsTemp(): Promise<string | null> {
    if (this.windowsTempDir === undefined) {
      const shell = this.powershell
      this.windowsTempDir =
        shell === null
          ? Promise.resolve(null)
          : tryRun(this.host, powershell(shell, WINDOWS_TEMP), { timeoutMs: 15000 }).then(result => {
              const line = result?.stdout.trim().split(/\r?\n/).pop()?.trim()
              return result?.exitCode === 0 && line ? line.replace(/\\+$/, '') : null
            })
    }
    return this.windowsTempDir
  }
}
