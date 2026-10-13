// An in-memory machine for service tests: files by path in either separator
// style, and programs answered by a function the test supplies.

import type { DirEntry, FileStat, Host, RunOptions, RunResult } from '../hooks/lib/service/host'
import { READ_LIMIT } from '../hooks/lib/service/host'

export type FakeFile = { bytes: Uint8Array; mtimeMs?: number }

export type FakeHost = Host & {
  files: Map<string, FakeFile>
  runs: string[][]
  written: Map<string, string>
}

export function fakeHost(
  files: Record<string, FakeFile>,
  run: (argv: readonly string[], options?: RunOptions) => RunResult | null = () => null,
): FakeHost {
  const map = new Map(Object.entries(files))
  const separatorOf = (path: string) => (path.includes('\\') && !path.startsWith('/') ? '\\' : '/')
  const trim = (path: string) => path.replace(/[\\/]+$/, '')
  const isDir = (path: string) => {
    const prefix = trim(path) + separatorOf(path)
    for (const key of map.keys()) if (key.startsWith(prefix)) return true
    return false
  }
  const host: FakeHost = {
    files: map,
    runs: [],
    written: new Map(),
    readBytes: async path => {
      const file = map.get(path)
      if (file === undefined) throw new Error(`ENOENT: ${path}`)
      if (file.bytes.length > READ_LIMIT) throw new Error('over 4 MiB')
      return file.bytes
    },
    stat: async (path): Promise<FileStat | null> => {
      const file = map.get(path)
      if (file !== undefined) return { kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs ?? 1000 }
      return isDir(path) ? { kind: 'dir', size: 0, mtimeMs: 1000 } : null
    },
    list: async (path): Promise<DirEntry[]> => {
      const base = trim(path)
      const separator = separatorOf(path)
      const names = new Map<string, DirEntry>()
      for (const [key, file] of map) {
        if (!key.startsWith(base + separator)) continue
        const rest = key.slice(base.length + 1)
        const cut = rest.search(/[\\/]/)
        const name = cut < 0 ? rest : rest.slice(0, cut)
        if (cut < 0) names.set(name, { name, kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs ?? 1000 })
        else if (!names.has(name)) names.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0 })
      }
      return [...names.values()]
    },
    writeText: async (path, text) => {
      host.written.set(path, text)
    },
    run: async (argv, options) => {
      host.runs.push([...argv])
      const result = run(argv, options)
      if (result === null) throw new Error(`${argv[0]}: not found`)
      return result
    },
    now: async () => 1_760_000_000_000,
    debug: () => undefined,
  }
  return host
}

export const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
