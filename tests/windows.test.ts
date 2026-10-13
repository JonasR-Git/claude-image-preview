// The mod on Windows, as Claude Code runs it there: backslash paths, %TEMP%
// with a space in the user name, no `uname`, and a picture dragged in.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PNG_FIXTURES } from './fixtures/images'

const SESSION = '3f2a9c1e-5b7d-4e8a-9c21-6d0f4b8a7e13'
const TEMP = 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp'
const CWD = 'C:\\Projects\\shop'
const IMAGES = `${TEMP}\\claude\\C--Projects-shop\\${SESSION}\\images`
const PNG = PNG_FIXTURES.find(fixture => fixture.name === 'rgb8')!.data

const BAND = {
  plugin: 'image-preview',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

/** A Windows machine whose disk holds `files`; directories exist where files do. */
function windows(on: On, draft: { text: string }, files: Map<string, string>) {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', TEMP, TMP: TEMP, USERPROFILE: 'C:\\Users\\Jo Doe', SystemRoot: 'C:\\Windows' })
  // The harness resolves every path against its own working folder first.
  const real = (path: string) => path.replace(/^\/.*?\/(?=[A-Za-z]:\\)/, '')
  const lower = (path: string) => path.toLowerCase()
  const isDir = (path: string) => [...files.keys()].some(file => lower(file).startsWith(`${lower(path)}\\`))
  on('session.start', () => ({ cwd: CWD }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ deny: 'not found' }))
  // The overlay helper: a terminal it cannot place pictures in, here.
  on('process.spawn', async function* () {
    return { value: { code: 3, signal: null } }
  })
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('fs.list', ($, { path: asked }) => {
    const path = real(asked)
    const out = new Map<
      string,
      { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }
    >()
    for (const [file, data] of files) {
      if (!lower(file).startsWith(`${lower(path)}\\`)) continue
      const rest = file.slice(path.length + 1)
      const name = rest.split('\\')[0]!
      out.set(name, {
        name,
        kind: rest.includes('\\') ? 'dir' : 'file',
        size: data.length,
        mtimeMs: 1000,
        isLink: false,
      })
    }
    return out.size === 0 && !isDir(path) ? { deny: 'ENOENT' } : { value: [...out.values()] }
  })
  on('fs.stat', ($, e) => {
    const data = files.get(real(e.path))
    if (data !== undefined)
      return { value: { kind: 'file', size: (data.length * 3) / 4, mtimeMs: 1000, isLink: false } }
    return isDir(real(e.path)) ? { value: { kind: 'dir', size: 0, mtimeMs: 1000, isLink: false } } : { deny: 'ENOENT' }
  })
  on('fs.read', ($, e) => {
    const data = files.get(real(e.path))
    return data === undefined ? { deny: 'ENOENT' } : { value: { base64: data } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return clock
}

test('Windows: a picture dragged in shows as [Image #1]', async ($, on) => {
  const files = new Map([[`${IMAGES}\\1.png`, PNG]])
  const clock = windows(on, { text: 'what is wrong here [Image #1]' }, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await clock.advance(300)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'open-0' }))?.props.label).toBe('#1 · 13×9 · PNG · 207 B')
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('Windows: a picture dropped into Git Bash, typed as a quoted POSIX path', async ($, on) => {
  const files = new Map([['C:\\Users\\Jo Doe\\Pictures\\Screenshots\\Screenshot 1.png', PNG]])
  const clock = windows(on, { text: "look '/c/Users/Jo Doe/Pictures/Screenshots/Screenshot 1.png'" }, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await clock.advance(300)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('Windows: a dragged path Claude Code leaves as a mention', async ($, on) => {
  const files = new Map([['C:\\Users\\Jo Doe\\Desktop\\shot one.png', PNG]])
  const clock = windows(on, { text: 'look @"C:\\Users\\Jo Doe\\Desktop\\shot one.png"' }, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await clock.advance(300)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})
