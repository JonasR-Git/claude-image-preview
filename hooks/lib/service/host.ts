// What the services need from Claude Code, as plain functions. The hooks
// module builds one from `$` (only it may call `$`), and tests build fakes, so
// everything under lib/ stays free of the mods API and runs in a unit test.

export type FileKind = 'file' | 'dir' | 'other'

export type FileStat = { kind: FileKind; size: number; mtimeMs: number }

export type DirEntry = { name: string; kind: FileKind; size: number; mtimeMs: number }

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type RunOptions = { timeoutMs?: number; stdin?: string; cwd?: string }

export type Host = {
  /** A file's bytes; rejects when missing or over the 4 MiB read limit. */
  readBytes(path: string): Promise<Uint8Array>
  /** What a path is, or null when nothing is there. */
  stat(path: string): Promise<FileStat | null>
  /** A directory's entries; empty when it cannot be listed. */
  list(path: string): Promise<DirEntry[]>
  /** Writes text, creating directories as needed. */
  writeText(path: string, text: string): Promise<void>
  /** Runs a program by argument vector; rejects only when it cannot start or times out. */
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  /** Milliseconds since the epoch. */
  now(): Promise<number>
  /** A line for the debug log. */
  debug(text: string): void
}

/** The largest file `$.fs.read` hands over. */
export const READ_LIMIT = 4 * 1024 * 1024

/** Runs `argv` and resolves its result, or null when it could not start or timed out. */
export async function tryRun(host: Host, argv: readonly string[], options?: RunOptions): Promise<RunResult | null> {
  try {
    return await host.run(argv, options)
  } catch {
    return null
  }
}
