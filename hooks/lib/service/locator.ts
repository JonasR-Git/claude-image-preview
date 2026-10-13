// Finds where Claude Code keeps this session's pasted images:
//
//   <base>/claude-<uid>/<project>/<session id>/images/<n>.<ext>
//
// <base> is CLAUDE_CODE_TMPDIR, else the OS temp directory (TMPDIR/TMP/TEMP or
// /tmp; %TEMP% on Windows, where the folder is plain `claude`: there is no
// uid). <project> is the working
// directory with every character but letters and digits turned into `-`, cut
// and hashed when long, so the folder is found by session id when the quick
// guess misses. A /clear starts a new session id, so the answer is per id.

import { join, projectKey, trimTrailing } from '../platform/paths'
import { tryRun } from './host'
import type { Host } from './host'
import type { System } from './system'

const ROOT_NAME = /^claude(-\d+)?$/
const PASTE_NAME = /^(\d+)\.([a-z0-9]+)$/
const MISS_RETRY_MS = 1500
/** How far back /image-preview status looks for paste folders of any session. */
const RECENT_PASTES_MS = 15 * 60 * 1000

export class Locator {
  private readonly found = new Map<string, string>()
  private readonly lastMiss = new Map<string, number>()
  private roots: Promise<string[]> | undefined
  private systemTemp: Promise<string | null> | undefined
  private ownRoot: Promise<string | null> | undefined

  constructor(
    private readonly host: Host,
    private readonly system: System,
    private readonly cwd: string,
  ) {}

  /** Temp directories Claude Code may use, most likely first. */
  bases(): string[] {
    const env = this.system.env
    const style = this.system.style
    const candidates =
      this.system.platform === 'windows'
        ? [
            env.CLAUDE_CODE_TMPDIR,
            env.TEMP,
            env.TMP,
            env.LOCALAPPDATA === undefined ? undefined : join(style, env.LOCALAPPDATA, 'Temp'),
            env.USERPROFILE === undefined ? undefined : join(style, env.USERPROFILE, 'AppData', 'Local', 'Temp'),
          ]
        : [env.CLAUDE_CODE_TMPDIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp']
    const seen = new Set<string>()
    const out: string[] = []
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === '') continue
      const base = trimTrailing(candidate)
      if (!seen.has(base)) {
        seen.add(base)
        out.push(base)
      }
    }
    return out
  }

  /**
   * The temp directory as the system reports it, asked once and only when the
   * environment led nowhere: Windows through PowerShell, macOS through getconf.
   */
  private askSystemTemp(): Promise<string | null> {
    if (this.systemTemp === undefined) {
      const platform = this.system.platform
      this.systemTemp =
        platform === 'windows'
          ? this.system.windowsTemp()
          : platform === 'macos'
            ? tryRun(this.host, ['getconf', 'DARWIN_USER_TEMP_DIR'], { timeoutMs: 3000 }).then(result =>
                result !== null && result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null,
              )
            : Promise.resolve(null)
    }
    return this.systemTemp
  }

  /**
   * The name Claude Code gives its folder: `claude-<uid>`, plain `claude` on
   * Windows. The uid comes from `id -u`, asked once.
   */
  private rootName(): Promise<string | null> {
    if (this.ownRoot === undefined) {
      this.ownRoot =
        this.system.platform === 'windows'
          ? Promise.resolve('claude')
          : tryRun(this.host, ['id', '-u'], { timeoutMs: 3000 }).then(result => {
              const uid = result?.exitCode === 0 ? result.stdout.trim() : ''
              return /^\d+$/.test(uid) ? `claude-${uid}` : null
            })
    }
    return this.ownRoot
  }

  /**
   * Every `claude-<uid>` (or `claude`) folder under the candidate bases. Claude Code's own
   * name is looked up directly: a temp folder can hold tens of thousands of
   * entries (Windows' often does), too many to list on every miss. Listing is
   * the fallback only when the uid is unknown: a `claude-<uid>` of another
   * account is none of this session's business.
   */
  private claudeRoots(): Promise<string[]> {
    if (this.roots === undefined) {
      this.roots = (async () => {
        const style = this.system.style
        const name = await this.rootName()
        const asked = async () => {
          const temp = await this.askSystemTemp()
          return temp === null ? [] : [trimTrailing(temp)]
        }
        const direct = async (bases: readonly string[]) => {
          const out: string[] = []
          for (const base of bases) {
            const root = name === null ? null : join(style, base, name)
            if (root !== null && (await this.host.stat(root))?.kind === 'dir') out.push(root)
          }
          return out
        }
        const listed = async (bases: readonly string[]) => {
          const out: string[] = []
          for (const base of bases) {
            for (const entry of await this.host.list(base)) {
              if (entry.kind === 'dir' && ROOT_NAME.test(entry.name)) out.push(join(style, base, entry.name))
            }
          }
          return out
        }
        const bases = this.bases()
        let roots = await direct(bases)
        if (roots.length === 0 && name === null) roots = await listed(bases)
        if (roots.length === 0) {
          const more = (await asked()).filter(base => !bases.includes(base))
          roots = await direct(more)
          if (roots.length === 0 && name === null) roots = await listed(more)
        }
        return [...new Set(roots)]
      })()
    }
    return this.roots
  }

  /** `<root>/<project>/<session>` for this session, or null while Claude Code has made none. */
  async sessionDir(sessionId: string): Promise<string | null> {
    const known = this.found.get(sessionId)
    if (known !== undefined) return known
    const now = await this.host.now()
    const missedAt = this.lastMiss.get(sessionId)
    if (missedAt !== undefined && now - missedAt < MISS_RETRY_MS) return null

    const style = this.system.style
    let roots = await this.claudeRoots()
    if (roots.length === 0) {
      // Claude Code may have created its root after the first look.
      this.roots = undefined
      roots = await this.claudeRoots()
    }
    const key = projectKey(this.cwd)
    for (const root of roots) {
      const guess = join(style, root, key, sessionId)
      if ((await this.host.stat(guess))?.kind === 'dir') return this.remember(sessionId, guess)
    }
    for (const root of roots) {
      for (const entry of await this.host.list(root)) {
        if (entry.kind !== 'dir') continue
        const candidate = join(style, root, entry.name, sessionId)
        if ((await this.host.stat(candidate))?.kind === 'dir') return this.remember(sessionId, candidate)
      }
    }
    this.lastMiss.set(sessionId, now)
    return null
  }

  private remember(sessionId: string, dir: string): string {
    this.found.set(sessionId, dir)
    return dir
  }

  /**
   * The file Claude Code stored `[Image #id]` in, or null when it is not there
   * (yet). A resumed session numbers its pastes from 1 again, so an older
   * `3.jpg` can sit beside the `3.webp` just pasted: the newest one is it.
   */
  async pastedImage(sessionId: string, id: number): Promise<string | null> {
    const session = await this.sessionDir(sessionId)
    if (session === null) return null
    const images = join(this.system.style, session, 'images')
    let newest: { name: string; mtimeMs: number } | null = null
    for (const entry of await this.host.list(images)) {
      const match = PASTE_NAME.exec(entry.name)
      if (entry.kind !== 'file' || match === null || Number(match[1]) !== id) continue
      if (newest === null || entry.mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs: entry.mtimeMs }
    }
    return newest === null ? null : join(this.system.style, images, newest.name)
  }

  /**
   * What the search for pastes found, for /image-preview status: the
   * `claude-<uid>` folders, this session's folder, and, when that is missing,
   * the paste folders any session wrote to lately.
   */
  async report(sessionId: string): Promise<string[]> {
    const style = this.system.style
    this.roots = undefined
    const roots = await this.claudeRoots()
    const asked = await this.systemTemp
    const lines = [
      `temp folders searched: ${[...this.bases(), ...(asked ? [asked] : [])].join(', ')}`,
      `claude folders: ${roots.length === 0 ? 'none found' : roots.join(', ')}`,
      `session: ${sessionId}`,
    ]
    this.lastMiss.delete(sessionId)
    const session = await this.sessionDir(sessionId)
    if (session !== null) {
      const images = join(style, session, 'images')
      const names = (await this.host.list(images)).filter(entry => PASTE_NAME.test(entry.name)).map(entry => entry.name)
      lines.push(`pasted images: ${images}${names.length === 0 ? ' (empty)' : ` (${names.sort().join(', ')})`}`)
      return lines
    }
    lines.push('pasted images: no folder for this session yet')
    const now = await this.host.now()
    const recent: string[] = []
    for (const root of roots) {
      for (const project of await this.host.list(root)) {
        if (project.kind !== 'dir') continue
        for (const other of await this.host.list(join(style, root, project.name))) {
          if (other.kind !== 'dir') continue
          const images = join(style, root, project.name, other.name, 'images')
          const stat = await this.host.stat(images)
          if (stat !== null && stat.kind === 'dir' && now - stat.mtimeMs < RECENT_PASTES_MS) recent.push(images)
        }
      }
    }
    lines.push(
      `pastes of other sessions, last 15 minutes: ${recent.length === 0 ? 'none' : recent.slice(0, 5).join(', ')}`,
    )
    return lines
  }

  /** A folder of the mod's own for clipboard captures and converted thumbnails. */
  async workDir(sessionId: string): Promise<string> {
    return join(this.system.style, await this.workRoot(), sessionId)
  }

  /**
   * The parent of every session's work folder, which also holds the compiled
   * overlay helper. It lives in the user's own cache folder, never in a temp
   * folder other accounts can write to: what is cached there gets loaded and run.
   */
  async workRoot(): Promise<string> {
    const env = this.system.env
    const style = this.system.style
    const name = 'claude-image-preview'
    switch (this.system.platform) {
      case 'windows': {
        const local =
          env.LOCALAPPDATA ??
          (env.USERPROFILE === undefined ? undefined : join(style, env.USERPROFILE, 'AppData', 'Local'))
        if (local !== undefined && local !== '') return join(style, local, name)
        break
      }
      case 'macos':
        if (env.HOME !== undefined && env.HOME !== '') return join(style, env.HOME, 'Library', 'Caches', name)
        break
      default:
        if (env.XDG_CACHE_HOME?.startsWith('/')) return join(style, env.XDG_CACHE_HOME, name)
        if (env.HOME !== undefined && env.HOME !== '') return join(style, env.HOME, '.cache', name)
    }
    // No home: Claude Code's own folder, made for this user alone.
    const own = await this.rootName()
    return join(style, this.bases()[0] ?? '/tmp', own ?? 'claude', 'image-preview')
  }
}
