import { describe, expect, test } from 'claude-code/testing'

import {
  encodePowerShell,
  filesFromUriList,
  lastJson,
  linuxConverters,
  linuxSave,
  psString,
} from '../hooks/lib/platform/scripts'
import { guessPlatform, likelyDrawsPictures } from '../hooks/lib/platform/os'
import {
  basename,
  dirname,
  expandHome,
  join,
  msysToWindows,
  projectKey,
  resolve,
  windowsToWsl,
} from '../hooks/lib/platform/paths'
import {
  droppedAsMentions,
  droppedPaths,
  insertionFor,
  mentionFor,
  parseDraft,
  withoutRef,
} from '../hooks/lib/prompt/draft'
import { parseSettings } from '../hooks/lib/service/settings'
import { captureLabel } from '../hooks/lib/service/pictures'
import { PreviewSession } from '../hooks/lib/service/session'
import { fitText, humanBytes, labelFor } from '../hooks/lib/view/labels'
import { HeldHeight, cellsFor, fitCells, layoutRow } from '../hooks/lib/view/layout'
import { DEFAULT_COLOR, halfBlockCells } from '../hooks/lib/view/raster'
import { fromBase64 } from '../hooks/lib/codec/base64'
import type { PreviewItem } from '../types'

describe('draft', () => {
  test('finds pastes and image mentions in order, each once', () => {
    const refs = parseDraft('see [Image #2] and @shots/a.png, then [Image #1] [Image #2] @"my pics/b c.JPG" @notes.md')
    expect(refs.map(ref => (ref.kind === 'paste' ? `#${ref.id}` : ref.path))).toEqual([
      '#2',
      'shots/a.png',
      '#1',
      'my pics/b c.JPG',
    ])
  })

  test('finds absolute image paths a terminal typed for a dropped file', () => {
    const paths = (text: string) => parseDraft(text).map(ref => (ref.kind === 'mention' ? ref.path : ref.id))
    // Git Bash (mintty) quotes a name with spaces in single quotes, as a POSIX path.
    expect(paths("look '/c/Users/jo/Pictures/Screenshots/Screenshot 2026-10-13 082442.png' please")).toEqual([
      '/c/Users/jo/Pictures/Screenshots/Screenshot 2026-10-13 082442.png',
    ])
    // Punctuation after a bare path is not part of it.
    const comma = parseDraft('see /c/a.png, then')[0]!
    expect([comma.start, comma.end]).toEqual([4, 12])
    expect(paths('/c/Users/jo/shot.png and C:\\Users\\jo\\b.jpg, "C:\\Users\\Jo Doe\\c d.webp"')).toEqual([
      '/c/Users/jo/shot.png',
      'C:\\Users\\jo\\b.jpg',
      'C:\\Users\\Jo Doe\\c d.webp',
    ])
    // Relative paths, other files and @ mentions are not dropped paths.
    expect(paths('shots/a.png /etc/hosts https://x.org/a.png')).toEqual([])
    const quoted = parseDraft('@"C:\\Users\\Jo Doe\\shot one.png"')
    expect(quoted).toEqual([{ kind: 'mention', path: 'C:\\Users\\Jo Doe\\shot one.png', start: 0, end: 31 }])
  })

  test('ignores look-alikes', () => {
    expect(parseDraft('[Image 1] [image #3] mail@example.png x@y')).toEqual([])
  })

  test('takes one reference out without leaving a double space', () => {
    const cut = (text: string) => withoutRef(text, parseDraft(text)[0]!)
    expect(cut('compare [Image #1] with this')).toBe('compare with this')
    expect(cut('[Image #1] why')).toBe('why')
    expect(cut('why [Image #1]')).toBe('why')
    expect(cut('look @"C:\\Users\\Jo Doe\\a.png" here')).toBe('look here')
  })

  test('tells a paste of dropped files from other text', () => {
    const paths = (text: string) => droppedPaths(text)?.map(ref => ref.path) ?? null
    // Git Bash (mintty) types each dropped file as a quoted POSIX path.
    expect(paths("'/c/Users/jo/Pictures/Screenshot 1.png' ")).toEqual(['/c/Users/jo/Pictures/Screenshot 1.png'])
    expect(paths("'/c/a b.png' /c/b.jpg")).toEqual(['/c/a b.png', '/c/b.jpg'])
    // Words around them, mentions and other files are no drop.
    expect(paths("look at '/c/a.png'")).toBe(null)
    expect(paths('@/c/a.png')).toBe(null)
    expect(paths('/c/notes.txt')).toBe(null)
    // The same file dropped twice is still a drop.
    expect(paths("'/c/a.png' '/c/a.png'")).toEqual(['/c/a.png', '/c/a.png'])
  })

  test('turns dropped Git Bash paths into mentions of the Windows files', async () => {
    const there = new Set(['C:\\Users\\Jo Doe\\a.png', 'C:\\b.jpg'])
    const isFile = async (path: string) => there.has(path)
    const rewrite = (pasted: string, before = '', after = '') => droppedAsMentions(pasted, before, after, isFile)
    expect(await rewrite("'/c/Users/Jo Doe/a.png' ")).toBe('@"C:\\Users\\Jo Doe\\a.png" ')
    expect(await rewrite("'/c/b.jpg' '/c/b.jpg'")).toBe('@C:\\b.jpg @C:\\b.jpg')
    // Apart from a word on either side; an @ typed first becomes the mention's.
    expect(await rewrite('/c/b.jpg', 'x', 'y')).toBe(' @C:\\b.jpg ')
    expect(await rewrite('/c/b.jpg', '@')).toBe('C:\\b.jpg')
    // A file that is not there, or other text, is left as it was pasted.
    expect(await rewrite('/c/gone.png')).toBe(null)
    expect(await rewrite('see /c/b.jpg')).toBe(null)
  })

  test('leaves punctuation after a mention in the text', () => {
    const cut = (text: string) => withoutRef(text, parseDraft(text)[0]!)
    expect(cut('compare @a.png, then')).toBe('compare , then')
    expect(parseDraft('@a.png#L2.')).toEqual([{ kind: 'mention', path: 'a.png', start: 0, end: 9 }])
  })

  test('strips a line range from a mention', () => {
    expect(parseDraft('@diagram.webp#L1-2')).toEqual([{ kind: 'mention', path: 'diagram.webp', start: 0, end: 18 }])
  })

  test('quotes paths with spaces and pads insertions', () => {
    expect(mentionFor('/tmp/a.png')).toBe('@/tmp/a.png')
    expect(mentionFor('C:\\Users\\Jo Doe\\a.png')).toBe('@"C:\\Users\\Jo Doe\\a.png"')
    expect(insertionFor('look', 4, '@a.png')).toBe(' @a.png ')
    expect(insertionFor('look  here', 5, '@a.png')).toBe('@a.png')
    expect(insertionFor('', 0, '@a.png')).toBe('@a.png ')
  })
})

describe('layout', () => {
  test('keeps the shape of a picture in cells', () => {
    expect(cellsFor({ width: 640, height: 360 }, 6, 48)).toEqual({ columns: 21, rows: 6 })
    // Very wide: capped, fewer rows. Very tall: a minimum width.
    expect(cellsFor({ width: 4000, height: 400 }, 6, 48)).toEqual({ columns: 48, rows: 2 })
    expect(cellsFor({ width: 100, height: 2000 }, 6, 48)).toEqual({ columns: 6, rows: 6 })
  })

  test('shrinks tiles until the row fits, then counts the rest', () => {
    const square = { width: 500, height: 500 }
    const options = { maxRows: 20, maxColumns: 120, preferredRows: 6, textRows: 1 }
    expect(layoutRow([square], options).tiles).toEqual([{ columns: 12, rows: 6 }])
    // 3 x (10 + 2) + 2 gaps = 38 columns at five rows.
    expect(layoutRow([square, square, square], { ...options, maxColumns: 40 }).tiles[0]).toEqual({
      columns: 10,
      rows: 5,
    })
    const crowded = layoutRow(Array(12).fill(square), { ...options, maxColumns: 40 })
    expect(crowded.hidden).toBe(12 - crowded.tiles.length)
    expect(crowded.tiles.length > 0).toBe(true)
    // A screenshot alone takes the whole width at the default height.
    const screenshot = { width: 1920, height: 1080 }
    expect(layoutRow([screenshot], { maxRows: 40, maxColumns: 115, preferredRows: 32, textRows: 1 }).tiles).toEqual([
      { columns: 113, rows: 32 },
    ])
    // No room for even one row of picture.
    expect(layoutRow([square], { ...options, maxRows: 3 }).tiles).toEqual([])
  })

  test('keeps the height of the tiles for a while after a picture is taken out', () => {
    const held = new HeldHeight(5000)
    // Four pictures drawn at 8 rows in 100 columns; nothing held yet.
    expect(held.limit(4, 100, 0)).toBe(null)
    held.drawn(4, 8, 100)
    // One taken out: the rest stay at 8 rows, again after a second removal.
    expect(held.limit(3, 100, 1000)).toBe(8)
    held.drawn(3, 8, 100)
    expect(held.limit(2, 100, 3000)).toBe(8)
    held.drawn(2, 8, 100)
    // Five seconds after the last removal they take the room there is.
    expect(held.isOver(7999)).toBe(false)
    expect(held.isOver(8000)).toBe(true)
    expect(held.limit(2, 100, 8000)).toBe(null)
    // A new width lets go at once; so does an empty band.
    held.drawn(2, 12, 100)
    expect(held.limit(1, 100, 9000)).toBe(12)
    expect(held.limit(1, 80, 9100)).toBe(null)
    held.reset()
    expect(held.limit(1, 80, 9200)).toBe(null)
  })

  test('fits a box without losing the shape', () => {
    expect(fitCells({ width: 1920, height: 1080 }, { columns: 80, rows: 40 })).toEqual({ columns: 80, rows: 23 })
    expect(fitCells({ width: 1920, height: 1080 }, { columns: 40, rows: 40 })).toEqual({ columns: 40, rows: 11 })
  })
})

describe('raster', () => {
  test('draws two pixels per cell and leaves transparency to the terminal', () => {
    // 1x2 picture: red over transparent.
    const bitmap = { width: 1, height: 2, data: Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0) }
    const words = new Uint32Array(fromBase64(halfBlockCells(bitmap, 1, 1)).slice().buffer)
    expect(Array.from(words)).toEqual([0x2580, 0xff0000, DEFAULT_COLOR])
  })
})

describe('labels', () => {
  const item: PreviewItem = {
    key: 'paste:1',
    label: '#1',
    source: 'paste',
    path: '/tmp/1.png',
    status: 'ready',
    format: 'PNG',
    width: 1920,
    height: 1080,
    bytes: 245_000,
    revision: 'r',
  }
  test('drops the least important facts first', () => {
    expect(labelFor(item, 40)).toBe('#1 · 1920×1080 · PNG · 239 KB')
    expect(labelFor(item, 20)).toBe('#1 · 1920×1080 · PNG')
    expect(labelFor(item, 5)).toBe('#1')
    expect(fitText('screenshot.png', 8)).toBe('screens…')
    // Wide characters take two cells each.
    expect(fitText('スクリーンショット.png', 8)).toBe('スクリ…')
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  test('names clipboard captures by their time', () => {
    expect(captureLabel('clipboard-20261012-212428-549.png')).toBe('clipboard 21:24:28')
    expect(captureLabel('shot.png')).toBe(null)
  })
})

describe('paths', () => {
  test('join, split and resolve in both styles', () => {
    expect(join('windows', 'C:\\Temp\\', 'claude', 'x')).toBe('C:\\Temp\\claude\\x')
    expect(msysToWindows('/c/Users/Jo Doe/a.png')).toBe('C:\\Users\\Jo Doe\\a.png')
    expect(msysToWindows('/cygdrive/d/x.png')).toBe('D:\\x.png')
    expect(msysToWindows('/home/jo/a.png')).toBe(null)
    expect(join('posix', '/tmp/', '/claude-501/')).toBe('/tmp/claude-501/')
    expect(resolve('/work/app', '../shots/./a.png', 'posix')).toBe('/work/shots/a.png')
    expect(resolve('C:\\work', 'shots\\a.png', 'windows')).toBe('C:\\work\\shots\\a.png')
    expect(basename('C:\\a\\b.png')).toBe('b.png')
    expect(dirname('/a/b/c.png')).toBe('/a/b')
    expect(expandHome('~/a.png', '/home/jo', 'posix')).toBe('/home/jo/a.png')
    expect(windowsToWsl('C:\\Users\\jo\\a.png')).toBe('/mnt/c/Users/jo/a.png')
  })

  test('names project folders as Claude Code does', () => {
    expect(projectKey('/Users/jo/my app')).toBe('-Users-jo-my-app')
    expect(projectKey('C:\\Users\\jo\\app')).toBe('C--Users-jo-app')
  })
})

describe('platform', () => {
  test('tells systems apart', () => {
    expect(guessPlatform({ OS: 'Windows_NT' })).toBe('windows')
    expect(guessPlatform({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe('wsl')
    expect(guessPlatform({}, 'Darwin')).toBe('macos')
    expect(guessPlatform({ HOME: '/home/jo' }, 'Linux')).toBe('linux')
  })

  test('guesses where pictures draw', () => {
    expect(likelyDrawsPictures({ TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(likelyDrawsPictures({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux' })).toBe(false)
    expect(likelyDrawsPictures({ TERM: 'xterm-256color' })).toBe(false)
    expect(likelyDrawsPictures({ CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', TMUX: 'x' })).toBe(true)
  })

  test('quotes for PowerShell and encodes its scripts', () => {
    expect(psString("it's")).toBe("'it''s'")
    // PowerShell also closes a quoted string at a typographic quote.
    expect(psString('a\u2019; calc; \u2018')).toBe("'a\u2019\u2019; calc; \u2018\u2018'")
    // "a" in UTF-16LE is 61 00.
    expect(encodePowerShell('a')).toBe('YQA=')
  })

  test('keeps paths out of shell code', () => {
    const argv = linuxSave('x11', 'image/png', '/tmp/a b;rm -rf ~.png')
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv[2]!.includes('a b')).toBe(false)
    expect(argv.at(-1)).toBe('/tmp/a b;rm -rf ~.png')
    const converters = linuxConverters(new Set(['magick', 'ffmpeg']), '/in.heic', '/out.png', 512, 'heic')
    expect(converters.map(command => command[0])).toEqual(['magick', 'ffmpeg'])
    // The format is named for ImageMagick; ffmpeg reads local files only.
    expect(converters[0]![1]).toBe('heic:/in.heic[0]')
    expect(converters[1]!.join(' ').includes('-protocol_whitelist file -i /in.heic')).toBe(true)
  })

  test('reads helper output', () => {
    expect(lastJson<{ files: string[] }>('noise\r\n{"files":["C:\\\\a.png"]}\r\n')).toEqual({ files: ['C:\\a.png'] })
    expect(filesFromUriList('copy\nfile:///home/jo/My%20Pics/a.png\nfile:///tmp/b.jpg\n')).toEqual([
      '/home/jo/My Pics/a.png',
      '/tmp/b.jpg',
    ])
  })
})

describe('settings', () => {
  test('reads options with defaults and the environment override', () => {
    expect(parseSettings({}, {})).toEqual({
      renderer: 'auto',
      tileRows: 32,
      readPreviews: true,
      overlay: true,
    })
    expect(parseSettings({ renderer: 'blocks', tile_rows: 99 }, {}).tileRows).toBe(32)
    // Options of earlier versions are ignored.
    expect(parseSettings({ labels: false, backdrop: 'checker' }, {})).toEqual(parseSettings({}, {}))
    expect(parseSettings({ overlay: false }, {}).overlay).toBe(false)
    expect(parseSettings({ renderer: 'blocks' }, { IMAGE_PREVIEW_RENDERER: 'image' }).renderer).toBe('pictures')
  })
})

describe('gallery', () => {
  const item = (key: string, revision = 'a'): PreviewItem => ({
    key,
    label: key,
    source: 'paste',
    path: `/tmp/${key}`,
    status: 'ready',
    revision,
  })
  test('adds new pictures last and moves changed ones', () => {
    expect(PreviewSession.mergeGallery([item('a')], [item('a')])).toBe(null)
    expect(PreviewSession.mergeGallery([item('a'), item('b')], [item('a', 'b')])!.map(i => i.key)).toEqual(['b', 'a'])
    expect(PreviewSession.mergeGallery([], [{ ...item('c'), status: 'missing' }])).toBe(null)
  })
})
