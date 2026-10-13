// The mod as Claude Code runs it: a session starts, the prompt box holds a
// paste, the timer reads it, and the band above the prompt draws the picture.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PNG_FIXTURES } from './fixtures/images'

const SESSION = '3f2a9c1e-5b7d-4e8a-9c21-6d0f4b8a7e13'
const IMAGES = `/tmp/claude-1000/-work/${SESSION}/images`
const PNG = PNG_FIXTURES.find(fixture => fixture.name === 'rgb8')!.data

/** A command typed at the prompt, as the engine raises it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

const BAND = {
  plugin: 'image-preview',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
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

const GALLERY = {
  plugin: 'image-preview',
  component: 'Pane',
  requestId: 'image-gallery',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'Images',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** A Linux machine with one paste stored, a prompt box whose text the test sets, and a clock it moves. */
type Run = (argv: readonly string[], files: Map<string, string>) => { exitCode: number; stdout: string } | null

function machine(on: On, draft: { text: string }, env: Record<string, string> = {}, run: Run = () => null) {
  const clock = mock.clock(on)
  mock.env(on, { TMPDIR: '/tmp', HOME: '/home/jo', ...env })
  const files = new Map<string, string>([[`${IMAGES}/1.png`, PNG]])
  const toasts: string[] = []
  const dirs = (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`))
  // On a Windows host the harness hands over /tmp/x as C:\tmp\x; the machine here is Linux.
  const posix = (path: string) => path.replace(/^[A-Za-z]:(?=\\)/, '').replaceAll('\\', '/')
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: SESSION }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const answer = run(e.argv, files) ?? { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux 6.1.0\n' : '' }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('fs.list', ($, { path: asked }) => {
    const e = { path: posix(asked) }
    const out = new Map<
      string,
      { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }
    >()
    for (const [path, data] of files) {
      if (!path.startsWith(`${e.path}/`)) continue
      const rest = path.slice(e.path.length + 1)
      const name = rest.split('/')[0]!
      out.set(name, {
        name,
        kind: rest.includes('/') ? 'dir' : 'file',
        size: data.length,
        mtimeMs: 1000,
        isLink: false,
      })
    }
    return out.size === 0 && !dirs(e.path) ? { deny: 'ENOENT' } : { value: [...out.values()] }
  })
  on('fs.stat', ($, { path: asked }) => {
    const e = { path: posix(asked) }
    const data = files.get(e.path)
    if (data !== undefined)
      return { value: { kind: 'file', size: (data.length * 3) / 4, mtimeMs: 1000, isLink: false } }
    return dirs(e.path) ? { value: { kind: 'dir', size: 0, mtimeMs: 1000, isLink: false } } : { deny: 'ENOENT' }
  })
  on('fs.read', ($, { path: asked }) => {
    const e = { path: posix(asked) }
    const data = files.get(e.path)
    return data === undefined ? { deny: 'ENOENT' } : { value: { base64: data } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return { clock, toasts, files }
}

test('a pasted picture shows above the prompt, without another keystroke', async ($, on) => {
  const draft = { text: 'why is this misaligned [Image #1]' }
  const { clock } = machine(on, draft)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'open-0' }))?.props.label).toBe('#1 · 13×9 · PNG · 207 B')
  await ui.unmount()

  // Sending the prompt empties the box, and the band with it.
  draft.text = ''
  await clock.advance(300)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Raster' })).toBeUndefined()
})

test('the x in a tile takes its picture out of the prompt', async ($, on) => {
  const draft = { text: 'compare [Image #1] with this' }
  const { clock } = machine(on, draft)
  on('prompt.fill', ($, e) => {
    draft.text = e.text
    return { isFilled: true }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'remove-0' }))?.props.label).toBe('✕')
  await ui.press({ key: 'remove-0' })
  expect(draft.text).toBe('compare with this')
  await ui.unmount()
  await clock.advance(300)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Raster' })).toBeUndefined()
})

test('after an x the other tiles keep their size for five seconds', async ($, on) => {
  const draft = { text: '[Image #1] [Image #2] [Image #3] compare' }
  const { clock, files } = machine(on, draft)
  files.set(`${IMAGES}/2.png`, PNG)
  files.set(`${IMAGES}/3.png`, PNG)
  on('prompt.fill', ($, e) => {
    draft.text = e.text
    return { isFilled: true }
  })
  const rows = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const raster = await ui.find({ type: 'Raster' })
    await ui.unmount()
    return raster?.props.rows
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  // Three pictures share the width at 12 rows; two alone would take 17.
  expect(await rows()).toBe(12)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'remove-0' })
  await ui.unmount()
  await clock.advance(300)
  expect(await rows()).toBe(12)
  await clock.advance(5000)
  expect(await rows()).toBe(17)
})

test('a missing file is named in place of its picture', async ($, on) => {
  const { clock } = machine(on, { text: 'compare @missing.png' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'not found' })).toBeDefined()
})

test('the desktop app keeps its own previews: nothing is drawn there', async ($, on) => {
  const { clock } = machine(on, { text: '[Image #1]' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
})

test('/image-preview off hides the band, on shows it again', async ($, on) => {
  const { clock, toasts } = machine(on, { text: '[Image #1]' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  await $.command.run(typed('image-preview', 'off'))
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ type: 'Raster' })).toBeUndefined()
  await hidden.unmount()
  await $.command.run(typed('image-preview', 'on'))
  const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown.find({ type: 'Raster' })).toBeDefined()
  expect(toasts).toEqual(['Thumbnails hidden for this session', 'Thumbnails shown'])
})

test('/image-preview status reports the platform and where pastes are kept', async ($, on) => {
  const { clock } = machine(on, { text: '[Image #1]' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  const answer = await $.command.run(typed('image-preview', 'status'))
  expect(answer.text).toMatch(/platform: linux/)
  expect(answer.text).toMatch(new RegExp(`pasted images: ${IMAGES} \\(1\\.png\\)`))
  expect(answer.text).toMatch(/Claude Code: 2\.1\.296/)
  expect(answer.text).toMatch(/in the prompt: #1 ready/)
})

test('the gallery shows every picture of the session and steps through them', async ($, on) => {
  const draft = { text: '[Image #1] @/work/b.png' }
  const { clock, files } = machine(on, draft)
  files.set('/work/b.png', PNG)
  let opened = ''
  on('ui.open', ($, e) => {
    opened = e.id
    return { value: { isPlaced: true } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  await $.command.run(typed('images', ''))
  expect(opened).toBe('image-gallery')
  const pane = await $.ui.mount({ ...GALLERY, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^2\/2$/ })).toBeDefined()
  await pane.press({ key: 'previous' })
  expect(await pane.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
  expect(await pane.find({ type: 'Raster' })).toBeDefined()
})

test('a picture whose pixels left the cache is decoded again for the gallery', async ($, on) => {
  // The gallery keeps more pictures than the pixel cache: #1 is the oldest of 41.
  const mentions = Array.from({ length: 40 }, (_, i) => `@/work/p${i}.png`)
  const { clock, files } = machine(on, { text: `[Image #1] ${mentions.join(' ')}` })
  for (let i = 0; i < 40; i++) files.set(`/work/p${i}.png`, PNG)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(300)
  await $.command.run(typed('images', '#1'))
  const pane = await $.ui.mount({ ...GALLERY, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^1\/41$/ })).toBeDefined()
  await clock.advance(10)
  expect(await pane.find({ type: 'Raster' })).toBeDefined()
})

/** xclip on X11 with a PNG on the clipboard; saving it puts the file on the fake disk. */
const clipboardWithPicture: Run = (argv, files) => {
  if (argv[0] === 'sh' && argv[2]!.startsWith('for tool')) return { exitCode: 0, stdout: 'xclip\n' }
  if (argv[0] === 'xclip') return { exitCode: 0, stdout: 'TARGETS\nimage/png\n' }
  if (argv[0] === 'sh' && argv.includes('image/png')) {
    files.set(argv.at(-1)!, PNG)
    return { exitCode: 0, stdout: '' }
  }
  return null
}

test('@clipboard sent as typed becomes the picture on the clipboard', async ($, on) => {
  machine(on, { text: '' }, { DISPLAY: ':0' }, clipboardWithPicture)
  let sent = ''
  on('prompt.submit', ($, e) => {
    sent = e.text
    return { text: e.text }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'what is wrong here @clipboard', origin: { kind: 'composer' }, wait: false })
  expect(sent).toMatch(
    /^what is wrong here @\/home\/jo\/\.cache\/claude-image-preview\/[^ ]+\/clipboard-\d{8}-\d{6}-\d{3}\.png$/,
  )
})

test('@clipboard with no picture on the clipboard keeps the prompt and says why', async ($, on) => {
  machine(on, { text: '' }, { DISPLAY: ':0' }, argv =>
    argv[0] === 'xclip'
      ? { exitCode: 0, stdout: 'TARGETS\nUTF8_STRING\n' }
      : argv[0] === 'sh'
        ? { exitCode: 0, stdout: 'xclip\n' }
        : null,
  )
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const result = await $.prompt.submit({ text: '@clipboard explain', origin: { kind: 'composer' }, wait: false })
  expect('drop' in result ? result.drop : '').toMatch(/no picture on the clipboard/)
})
