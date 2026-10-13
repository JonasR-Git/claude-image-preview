// The Windows overlay: the state the helper reads, when it is started, and
// when it gives up. The helper itself (overlay.cs) needs a real console and is
// tried by hand; this checks what the mod hands it.

import { describe, expect, test } from 'claude-code/testing'

import { overlayState, windowsOverlay } from '../hooks/lib/platform/overlay'
import { PictureOverlay } from '../hooks/lib/service/overlay'
import { System } from '../hooks/lib/service/system'
import { fakeHost } from './fake-host'

const DIR = 'C:\\Users\\Jo Doe\\AppData\\Local\\claude-image-preview\\s1'
const CACHE = 'C:\\Users\\Jo Doe\\AppData\\Local\\claude-image-preview'
const SOURCE = 'C:\\plugins\\image-preview\\hooks\\lib\\platform\\overlay.cs'
const TILE = { columns: 113, rows: 30, above: 1, below: 1, path: 'C:\\Users\\Jo Doe\\Pictures\\shot 1.png' }

/** An overlay whose helper runs until `finish` is called with its exit code. */
function overlayOn(platform: 'windows' | 'linux' = 'windows') {
  const host = fakeHost({})
  const system = System.known(host, platform === 'windows' ? { OS: 'Windows_NT' } : {}, platform)
  const spawned: (readonly string[])[] = []
  let finish: (code: number | null) => void = () => undefined
  const spawn = (argv: readonly string[]) => {
    spawned.push(argv)
    return new Promise<number | null>(resolve => {
      finish = resolve
    })
  }
  const overlay = new PictureOverlay(host, system, SOURCE, async () => ({ dir: DIR, cache: CACHE }), spawn)
  return { host, overlay, spawned, finish: (code: number | null) => finish(code) }
}

/** Lets the promise callbacks queued so far run: the end of a helper is noted after a clock read. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('overlay', () => {
  test('writes one tab-separated line per tile and leaves out paths that would break a line', () => {
    expect(overlayState([TILE, { ...TILE, path: 'C:\\a\tb.png' }])).toBe(
      '113\t30\t1\t1\tC:\\Users\\Jo Doe\\Pictures\\shot 1.png\n',
    )
    // No tiles is a lone newline: an empty file is one caught mid-write.
    expect(overlayState([])).toBe('\n')
  })

  test('starts with the session, before the first picture, and only once', async () => {
    const { host, overlay, spawned } = overlayOn()
    overlay.start()
    await overlay.settled()
    expect(spawned.length).toBe(1)
    expect(host.written.get(`${DIR}\\overlay.tsv`)).toBe('\n')
    const argv = spawned[0]!
    expect([argv[0], argv.includes('-Sta')]).toEqual(['powershell', true])
    overlay.show([TILE])
    overlay.show([TILE])
    await overlay.settled()
    expect(spawned.length).toBe(1)
    expect(host.written.get(`${DIR}\\overlay.tsv`)).toBe(overlayState([TILE]))
    expect(await overlay.describe()).toBe(`running (log: ${DIR}\\overlay.log)`)
    // Sending the prompt empties the band: the pictures go, the helper stays.
    overlay.show([])
    await overlay.settled()
    expect(host.written.get(`${DIR}\\overlay.tsv`)).toBe('\n')
  })

  test('gives up for good in a terminal it cannot place pictures in, and starts again after a crash', async () => {
    const unsupported = overlayOn()
    unsupported.overlay.start()
    await unsupported.overlay.settled()
    unsupported.finish(3)
    await settle()
    expect(await unsupported.overlay.describe()).toBe(
      `off: a terminal it cannot place pictures in (see the log) (log: ${DIR}\\overlay.log)`,
    )
    unsupported.overlay.show([TILE])
    await unsupported.overlay.settled()
    expect(unsupported.spawned.length).toBe(1)

    const crashed = overlayOn()
    crashed.overlay.show([TILE])
    await crashed.overlay.settled()
    crashed.finish(1)
    await settle()
    crashed.overlay.show([TILE])
    await crashed.overlay.settled()
    expect(crashed.spawned.length).toBe(2)
  })

  test('does nothing off Windows', async () => {
    const { host, overlay, spawned } = overlayOn('linux')
    overlay.start()
    overlay.show([TILE])
    await overlay.settled()
    expect([spawned.length, host.written.size]).toEqual([0, 0])
    expect(await overlay.describe()).toBe('not on Windows')
  })

  test('compiles the helper once per version, into a cache folder of the user', () => {
    const script = windowsOverlay(SOURCE, `${DIR}\\overlay.tsv`, CACHE)
    expect(script.includes(`$source = '${SOURCE}'`)).toBe(true)
    expect(script.includes(`$cache = '${CACHE}'`)).toBe(true)
    expect(script.includes('Get-FileHash')).toBe(true)
    // The compiler itself, which takes a path with brackets; a failure is logged and ends it for good.
    expect(script.includes('CompileAssemblyFromSource')).toBe(true)
    expect(script.includes('exit 4')).toBe(true)
    // Nothing may reach the console the helper attaches to.
    expect(/Write-(Host|Output)/.test(script)).toBe(false)
  })
})
