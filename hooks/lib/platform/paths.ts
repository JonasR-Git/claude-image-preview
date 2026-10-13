// Path handling for both separator styles. The hooks runtime has no `path`
// module, and one session can meet both styles: Windows paths in a WSL
// clipboard, POSIX paths in Git Bash.

export type PathStyle = 'posix' | 'windows'

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
}

/** A share (`\\host\share`, `//host/share`) or a device path: nothing to open by itself. */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

export function isAbsolute(path: string, style: PathStyle): boolean {
  return style === 'windows'
    ? isWindowsPath(path) || path.startsWith('\\') || path.startsWith('/')
    : path.startsWith('/')
}

export function separator(style: PathStyle): string {
  return style === 'windows' ? '\\' : '/'
}

/** Joins path parts with the style's separator, without doubling separators. */
export function join(style: PathStyle, ...parts: string[]): string {
  const sep = separator(style)
  return parts
    .filter(part => part !== '')
    .map((part, i) => {
      let piece = part
      if (i > 0) piece = piece.replace(/^[\\/]+/, '')
      if (i < parts.length - 1) piece = piece.replace(/[\\/]+$/, '')
      return piece
    })
    .join(sep)
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return '.'
  if (cut === 0) return trimmed[0]!
  return trimmed.slice(0, cut)
}

/** Drops a trailing separator, keeping a root (`/`, `C:\`) whole. */
export function trimTrailing(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path) || path === '/' || path === '\\') return path
  return path.replace(/[\\/]+$/, '')
}

/** Resolves `.` and `..` segments and joins `path` onto `base` when relative. */
export function resolve(base: string, path: string, style: PathStyle): string {
  const absolute = isAbsolute(path, style) ? path : join(style, base, path)
  const sep = separator(style)
  const isUnc = absolute.startsWith('\\\\')
  const drive = /^[A-Za-z]:/.exec(absolute)?.[0] ?? ''
  const rest = absolute.slice(isUnc ? 2 : drive.length)
  const out: string[] = []
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  if (isUnc) return '\\\\' + out.join('\\')
  if (style === 'windows' && drive !== '') return `${drive}\\${out.join('\\')}`
  return sep + out.join(sep)
}

/** Expands a leading `~` to the home directory. */
export function expandHome(path: string, home: string | undefined, style: PathStyle): string {
  if (home === undefined || !(path === '~' || path.startsWith('~/') || path.startsWith('~\\'))) return path
  return join(style, home, path.slice(2))
}

/** The Windows path behind a Git Bash or Cygwin one (`/c/Users/a`, `/cygdrive/c/Users/a`); null for others. */
export function msysToWindows(path: string): string | null {
  const match = /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/.exec(path)
  if (match === null) return null
  return `${match[1]!.toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`
}

/** A WSL view of a Windows path (`C:\Users\a` -> `/mnt/c/Users/a`); null for UNC paths. */
export function windowsToWsl(path: string, mountRoot = '/mnt'): string | null {
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
  if (match === null) return null
  return `${mountRoot}/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`.replace(/\/+$/, '')
}

/**
 * The folder name Claude Code gives a project under its temp directory: the
 * working directory with every character but letters and digits made `-`.
 */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
