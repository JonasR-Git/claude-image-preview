// Which operating system the session runs on, from the environment alone.
// The hooks runtime has no `process.platform`; the variables below are set by
// each system itself, and `uname` settles the rest when it can run.

import type { PathStyle } from './paths'

export type Platform = 'windows' | 'wsl' | 'macos' | 'linux'

/** The environment variables the mod reads, by name. */
export type Env = Readonly<Partial<Record<EnvName, string>>>

export type EnvName =
  | 'OS'
  | 'WSL_DISTRO_NAME'
  | 'WSL_INTEROP'
  | 'TMPDIR'
  | 'TMP'
  | 'TEMP'
  | 'CLAUDE_CODE_TMPDIR'
  | 'LOCALAPPDATA'
  | 'HOME'
  | 'XDG_CACHE_HOME'
  | 'USERPROFILE'
  | 'TERM'
  | 'TERM_PROGRAM'
  | 'TMUX'
  | 'STY'
  | 'KITTY_WINDOW_ID'
  | 'GHOSTTY_RESOURCES_DIR'
  | 'WEZTERM_PANE'
  | 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES'
  | 'CLAUDE_CODE_SESSION_KIND'
  | 'WAYLAND_DISPLAY'
  | 'DISPLAY'
  | 'SSH_CONNECTION'
  | 'IMAGE_PREVIEW_RENDERER'

/** A first guess from the environment; `uname -s` refines it on POSIX systems. */
export function guessPlatform(env: Env, uname?: string): Platform {
  if (env.OS === 'Windows_NT') return 'windows'
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return 'wsl'
  const kernel = (uname ?? '').trim().toLowerCase()
  if (kernel === 'darwin') return 'macos'
  if (kernel.includes('microsoft')) return 'wsl'
  if (kernel === 'linux') return 'linux'
  if (env.HOME?.startsWith('/Users/') || env.TMPDIR?.startsWith('/var/folders/')) return 'macos'
  return 'linux'
}

export function pathStyle(platform: Platform): PathStyle {
  return platform === 'windows' ? 'windows' : 'posix'
}

export function homeDirectory(env: Env, platform: Platform): string | undefined {
  return platform === 'windows' ? (env.USERPROFILE ?? env.HOME) : env.HOME
}

/**
 * Whether Claude Code is likely to draw `Image` as a real picture here. It
 * decides by the terminal's name and turns pictures off in tmux, screen and
 * background sessions. Only a first guess: the mod confirms it with a probe.
 */
export function likelyDrawsPictures(env: Env): boolean {
  if (env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES) return true
  if (env.TMUX || env.STY || env.CLAUDE_CODE_SESSION_KIND === 'bg') return false
  return (
    Boolean(env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) ||
    /kitty|ghostty/i.test(env.TERM ?? '') ||
    /^ghostty$/i.test(env.TERM_PROGRAM ?? '')
  )
}
