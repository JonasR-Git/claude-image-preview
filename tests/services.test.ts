import { describe, expect, test } from 'claude-code/testing'

import { fromBase64 } from '../hooks/lib/codec/base64'
import { readClipboard } from '../hooks/lib/service/clipboard'
import { Locator } from '../hooks/lib/service/locator'
import { PictureStore } from '../hooks/lib/service/pictures'
import { System } from '../hooks/lib/service/system'
import { fakeHost, ok } from './fake-host'
import { PILLOW_FIXTURES, PNG_FIXTURES } from './fixtures/images'

const PNG = fromBase64(PNG_FIXTURES.find(fixture => fixture.name === 'rgb8')!.data)
const JPEG = fromBase64(PILLOW_FIXTURES.find(fixture => fixture.name === 'jpeg-baseline-420')!.data)
const SESSION = '3f2a9c1e-5b7d-4e8a-9c21-6d0f4b8a7e13'

function store(host: ReturnType<typeof fakeHost>, system: System, cwd: string) {
  const locator = new Locator(host, system, cwd)
  return {
    locator,
    pictures: new PictureStore(host, system, locator, cwd, () => locator.workDir(SESSION), {
      thumbSide: 64,
      maxEntries: 8,
    }),
  }
}

describe('where Claude Code keeps pastes', () => {
  test('Windows: %TEMP%\\claude, with a space in the user name', async () => {
    const temp = 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp'
    const images = `${temp}\\claude\\C--work-app\\${SESSION}\\images`
    const host = fakeHost({ [`${images}\\1.png`]: { bytes: PNG } })
    const system = System.known(host, { OS: 'Windows_NT', TEMP: temp }, 'windows')
    const { locator, pictures } = store(host, system, 'C:\\work\\app')
    expect(await locator.pastedImage(SESSION, 1)).toBe(`${images}\\1.png`)
    const item = await pictures.describe({ kind: 'paste', id: 1, start: 0, end: 10 }, SESSION)
    expect([item.status, item.format, item.width, item.height]).toEqual(['ready', 'PNG', 13, 9])
    // No process was needed to find or decode it.
    expect(host.runs).toEqual([])
  })

  test('macOS: $TMPDIR, and a long project path found by session id', async () => {
    const root = '/var/folders/xy/abc/T/claude-501'
    const images = `${root}/-Users-jo-work-very-long-path-cut-and-hashed-1a2b3c/${SESSION}/images`
    const host = fakeHost({
      [`${root}/-Users-jo-other/another-session/images/1.png`]: { bytes: PNG },
      [`${images}/1.jpg`]: { bytes: JPEG },
    })
    const system = System.known(host, { TMPDIR: '/var/folders/xy/abc/T/', HOME: '/Users/jo' }, 'macos')
    const { pictures } = store(host, system, '/Users/jo/work/very/long/path')
    const item = await pictures.describe({ kind: 'paste', id: 1, start: 0, end: 10 }, SESSION)
    expect([item.status, item.format, item.path]).toEqual(['ready', 'JPEG', `${images}/1.jpg`])
  })

  test('the temp folder itself is never listed when the claude folder is where expected', async () => {
    const temp = 'C:\\Users\\jo\\AppData\\Local\\Temp'
    const images = `${temp}\\claude\\C--work\\${SESSION}\\images`
    const host = fakeHost({ [`${images}\\1.png`]: { bytes: PNG } })
    const listed: string[] = []
    const list = host.list
    host.list = async path => {
      listed.push(path)
      return list(path)
    }
    const { locator } = store(host, System.known(host, { OS: 'Windows_NT', TEMP: temp }, 'windows'), 'C:\\work')
    expect(await locator.pastedImage(SESSION, 1)).toBe(`${images}\\1.png`)
    expect(listed).toEqual([images])
  })

  test('Windows: with no temp folder in the environment, the system is asked', async () => {
    const temp = 'C:\\Users\\jo\\AppData\\Local\\Temp'
    const images = `${temp}\\claude\\C--work\\${SESSION}\\images`
    const host = fakeHost({ [`${images}\\1.png`]: { bytes: PNG } }, argv =>
      argv[0] === 'powershell' ? ok(`${temp}\\\r\n`) : null,
    )
    const { locator } = store(host, System.known(host, { OS: 'Windows_NT' }, 'windows'), 'C:\\work')
    expect(await locator.pastedImage(SESSION, 1)).toBe(`${images}\\1.png`)
  })

  test('the search report names the paste folders of other sessions', async () => {
    const root = '/tmp/claude-1000'
    const host = fakeHost({
      [`${root}/-work/another-session/images/1.png`]: { bytes: PNG, mtimeMs: 1_760_000_000_000 },
    })
    host.stat = async path =>
      path.endsWith('/images') ? { kind: 'dir', size: 0, mtimeMs: 1_760_000_000_000 - 60_000 } : null
    const { locator } = store(host, System.known(host, { TMPDIR: '/tmp' }, 'linux'), '/work')
    const report = await locator.report(SESSION)
    expect(report).toContain(`claude folders: ${root}`)
    expect(report).toContain('pasted images: no folder for this session yet')
    expect(report).toContain(`pastes of other sessions, last 15 minutes: ${root}/-work/another-session/images`)
  })

  test('a resumed session: the newest file of a number wins', async () => {
    const images = `/tmp/claude-1000/-work/${SESSION}/images`
    const host = fakeHost({
      [`${images}/3.jpg`]: { bytes: JPEG, mtimeMs: 1000 },
      [`${images}/3.png`]: { bytes: PNG, mtimeMs: 5000 },
      [`${images}/3.png.tmp.123`]: { bytes: PNG, mtimeMs: 9000 },
    })
    const system = System.known(host, { CLAUDE_CODE_TMPDIR: '/tmp' }, 'linux')
    const { locator } = store(host, system, '/work')
    expect(await locator.pastedImage(SESSION, 3)).toBe(`${images}/3.png`)
  })
})

describe('pictures', () => {
  test('mentions resolve against the working directory and home', async () => {
    const host = fakeHost({ '/work/shots/a.png': { bytes: PNG }, '/home/jo/b.jpg': { bytes: JPEG } })
    const system = System.known(host, { HOME: '/home/jo' }, 'linux')
    const { pictures } = store(host, system, '/work')
    const relative = await pictures.describe({ kind: 'mention', path: 'shots/a.png', start: 0, end: 1 }, SESSION)
    const home = await pictures.describe({ kind: 'mention', path: '~/b.jpg', start: 0, end: 1 }, SESSION)
    const missing = await pictures.describe({ kind: 'mention', path: 'nope.png', start: 0, end: 1 }, SESSION)
    expect([relative.status, relative.label, home.status, missing.status]).toEqual([
      'ready',
      'a.png',
      'ready',
      'missing',
    ])
  })

  test('decodes a file once per content', async () => {
    const host = fakeHost({ '/work/a.png': { bytes: PNG } })
    const system = System.known(host, {}, 'linux')
    const { pictures } = store(host, system, '/work')
    const first = await pictures.describeFile('/work/a.png', 'mention')
    let reads = 0
    const readBytes = host.readBytes
    host.readBytes = async path => {
      reads++
      return readBytes(path)
    }
    expect(await pictures.describeFile('/work/a.png', 'mention')).toBe(first)
    expect(reads).toBe(0)
    host.files.set('/work/a.png', { bytes: JPEG, mtimeMs: 2000 })
    const changed = await pictures.describeFile('/work/a.png', 'mention')
    expect([changed.format, changed.revision === first.revision]).toEqual(['JPEG', false])
  })

  test('a format with no decoder and no converter says what to install', async () => {
    const heic = new Uint8Array(32)
    heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
    const host = fakeHost({ '/work/a.heic': { bytes: heic } }, argv => (argv[0] === 'sh' ? ok('') : null))
    const system = System.known(host, {}, 'linux')
    const { pictures } = store(host, system, '/work')
    const item = await pictures.describeFile('/work/a.heic', 'mention')
    expect(item.status).toBe('unsupported')
    expect(item.reason).toMatch(/HEIC: no converter found/)
  })
})

describe('clipboard', () => {
  test('Windows: PowerShell in STA mode, the script encoded, files from its JSON', async () => {
    const host = fakeHost({}, argv =>
      argv[0] === 'powershell' ? ok('{"files":["C:\\\\Users\\\\jo\\\\shot.png"]}\r\n') : null,
    )
    const system = System.known(host, { OS: 'Windows_NT', TEMP: 'C:\\Temp' }, 'windows')
    const read = await readClipboard(system, 'C:\\Temp\\claude\\image-preview\\s')
    expect(read.files).toEqual(['C:\\Users\\jo\\shot.png'])
    const argv = host.runs[0]!
    expect(argv.includes('-Sta')).toBe(true)
    expect(argv.includes('-EncodedCommand')).toBe(true)
  })

  test('WSL: Windows paths come back as Linux paths', async () => {
    const host = fakeHost({}, argv => {
      if (argv[0] !== 'powershell.exe')
        return argv[0] === 'wslpath' ? ok(`/mnt/c/Users/jo/AppData/Local/Temp/x.png\n`) : null
      const bytes = fromBase64(argv.at(-1)!)
      let script = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) script += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
      return script.includes('GetTempPath')
        ? ok('C:\\Users\\jo\\AppData\\Local\\Temp\\\r\n')
        : ok('{"files":["C:\\\\x.png"]}')
    })
    const system = System.known(host, { WSL_DISTRO_NAME: 'Ubuntu' }, 'wsl')
    const read = await readClipboard(system, '/tmp/claude-1000/image-preview/s')
    expect(read.files).toEqual(['/mnt/c/Users/jo/AppData/Local/Temp/x.png'])
  })

  test('Linux X11: the best picture type is saved through xclip', async () => {
    const saved = '/tmp/claude-1000/image-preview/s'
    const host = fakeHost({}, argv => {
      if (argv[0] === 'sh' && argv[2]!.startsWith('for tool')) return ok('xclip\n')
      if (argv[0] === 'xclip') return ok('TARGETS\ntext/plain\nimage/jpeg\nimage/png\n')
      if (argv[0] === 'sh' && argv.includes('image/png')) {
        host.files.set(argv.at(-1)!, { bytes: PNG })
        return ok()
      }
      return null
    })
    const system = System.known(host, { DISPLAY: ':0' }, 'linux')
    const read = await readClipboard(system, saved)
    expect(read.files.length).toBe(1)
    expect(read.files[0]!.startsWith(`${saved}/clipboard-`)).toBe(true)
    expect(read.files[0]!.endsWith('.png')).toBe(true)
  })

  test('Linux without a clipboard tool says which to install', async () => {
    const host = fakeHost({}, argv => (argv[0] === 'sh' ? ok('') : null))
    const read = await readClipboard(System.known(host, {}, 'linux'), '/tmp/x')
    expect(read.files).toEqual([])
    expect(read.reason).toMatch(/wl-clipboard|xclip/)
  })
})
