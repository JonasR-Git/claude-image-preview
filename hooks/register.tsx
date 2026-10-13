// image-preview: thumbnails of the pictures in your prompt, above the prompt.
//
// This is the only file that talks to Claude Code: it reads the prompt box,
// keeps what the band and the gallery draw in $.state, and answers the
// commands. Everything it calls under lib/ is plain code that receives the
// file system and processes as functions (lib/service/host.ts), so it is
// tested without a session.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, Register } from 'claude-code'

import type { PreviewItem, RendererState } from '../types'
import { fromBase64 } from './lib/codec/base64'
import { looksLikeImagePath } from './lib/codec/sniff'
import { likelyDrawsPictures } from './lib/platform/os'
import type { Env } from './lib/platform/os'
import { basename, join } from './lib/platform/paths'
import { droppedAsMentions, insertionFor, mentionFor, parseDraft, withoutRef } from './lib/prompt/draft'
import type { Host, RunOptions } from './lib/service/host'
import { PictureOverlay } from './lib/service/overlay'
import type { OverlayTile, Spawn } from './lib/service/overlay'
import { PreviewSession } from './lib/service/session'
import { DEFAULTS, parseSettings } from './lib/service/settings'
import type { Settings } from './lib/service/settings'
import { placeholderFor } from './lib/view/labels'
import { fitCells } from './lib/view/layout'
import type { Cells } from './lib/view/layout'
import { halfBlockCells, imageSource } from './lib/view/raster'
import { ROWS_ABOVE_PICTURE, ROWS_BELOW_PICTURE, band, pictureElement } from './ui/band'
import type { Picture } from './ui/band'
import { gallery } from './ui/gallery'

/** How often the prompt box is read: pasting a picture raises no edit event. */
const POLL_MS = 250
const PANE = 'image-gallery'
const CLIPBOARD_WORD = /(^|\s)@clipboard(?=\s|$)/i
const CLIPBOARD_WORDS = /(^|\s)@clipboard(?=\s|$)/gi
const GALLERY_SIDE = 768
const BAND_PICTURE_SIDE = 384

const bandItems = atom({ plugin: 'image-preview', key: 'band' } as const, [] as PreviewItem[])
const galleryItems = atom({ plugin: 'image-preview', key: 'gallery' } as const, [] as PreviewItem[])
const selectedKey = atom({ plugin: 'image-preview', key: 'selected' } as const, null as string | null)
const rendererState = atom({ plugin: 'image-preview', key: 'renderer' } as const, null as RendererState | null)
const hiddenFlag = atom({ plugin: 'image-preview', key: 'isHidden' } as const, false)

const BLOCKS: RendererState = { mode: 'blocks', isConfirmed: true, source: 'bytes' }

let session: PreviewSession | null = null
/** On Windows, the real pictures laid over the blocks in windows of their own. */
let overlay: PictureOverlay | null = null
let settings: Settings = DEFAULTS
let isTicking = false
/** The band's instance id, which `$.ui.blit` needs for the renderer probe. */
let bandRequest: string | null = null
/** A picture drawn in the band, used to ask the terminal whether pictures show. */
let probe: { key: string; source: ImageSource; attempts: number } | null = null
const rasterCache = new Map<string, string>()
/** Pictures being decoded again, by key. */
const restoring = new Set<string>()
/** The file each Read call named, by tool_use_id, for the thumbnail under its result. */
const readPaths = new Map<string, string>()

function createHost($: EngineInterface): Host {
  return {
    readBytes: async path => fromBase64((await $.fs.read(path, { as: 'bytes' })).base64),
    stat: async path => {
      try {
        const stat = await $.fs.stat(path)
        return { kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return null
      }
    },
    list: async path => {
      try {
        const entries = await $.fs.list(path)
        return entries.map(entry => ({ name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs }))
      } catch {
        return []
      }
    },
    writeText: (path, text) => $.fs.write(path, text),
    run: (argv, options?: RunOptions) => {
      const init: { timeoutMs?: number; stdin?: string; cwd?: string } = {}
      if (options?.timeoutMs !== undefined) init.timeoutMs = options.timeoutMs
      if (options?.stdin !== undefined) init.stdin = options.stdin
      if (options?.cwd !== undefined) init.cwd = options.cwd
      return $.process.run(argv, init)
    },
    now: () => $.clock.now(),
    debug: text => $.ui.log(text, { to: 'debug' }),
  }
}

/** Runs a long-lived helper; the stream is its life, so it is read to the end. */
function spawner($: EngineInterface): Spawn {
  return async argv => {
    try {
      const stream = $.process.spawn({ argv })
      for (;;) {
        const step = await stream.next()
        if (step.done === true) return step.value.code
      }
    } catch {
      return null
    }
  }
}

async function readEnv($: EngineInterface): Promise<Env> {
  return {
    OS: await $.env.get('OS'),
    WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME'),
    WSL_INTEROP: await $.env.get('WSL_INTEROP'),
    TMPDIR: await $.env.get('TMPDIR'),
    TMP: await $.env.get('TMP'),
    TEMP: await $.env.get('TEMP'),
    CLAUDE_CODE_TMPDIR: await $.env.get('CLAUDE_CODE_TMPDIR'),
    LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
    HOME: await $.env.get('HOME'),
    XDG_CACHE_HOME: await $.env.get('XDG_CACHE_HOME'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TMUX: await $.env.get('TMUX'),
    STY: await $.env.get('STY'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
    CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
    WAYLAND_DISPLAY: await $.env.get('WAYLAND_DISPLAY'),
    DISPLAY: await $.env.get('DISPLAY'),
    SSH_CONNECTION: await $.env.get('SSH_CONNECTION'),
    IMAGE_PREVIEW_RENDERER: await $.env.get('IMAGE_PREVIEW_RENDERER'),
  }
}

/** The renderer to start with: the setting when it forces one, else a guess the probe confirms. */
function initialRenderer(env: Env, current: RendererState | null): RendererState {
  if (settings.renderer === 'blocks') return BLOCKS
  if (settings.renderer === 'pictures')
    return { mode: 'pictures', isConfirmed: true, source: current?.source ?? 'file' }
  if (current !== null) return current
  const isRemote = env.SSH_CONNECTION !== undefined
  return likelyDrawsPictures(env)
    ? { mode: 'pictures', isConfirmed: false, source: isRemote ? 'bytes' : 'file' }
    : BLOCKS
}

async function registerCommands($: EngineInterface): Promise<void> {
  // A name another plugin or a built-in holds is refused; the rest still register.
  try {
    await $.command.register({
      name: 'paste',
      description: 'Insert the picture on the clipboard (or copied picture files) into the prompt',
      immediate: true,
    })
  } catch (error) {
    $.ui.log(`/paste not registered: ${String(error)}`, { to: 'debug' })
  }
  try {
    await $.command.register({
      name: 'images',
      description: 'Browse the pictures of this session',
      argumentHint: '[#n]',
      immediate: true,
    })
  } catch (error) {
    $.ui.log(`/images not registered: ${String(error)}`, { to: 'debug' })
  }
  try {
    await $.command.register({
      name: 'image-copy',
      description: 'Copy a picture to the clipboard, ready to paste anywhere',
      argumentHint: '[#n | path]',
      immediate: true,
    })
  } catch (error) {
    $.ui.log(`/image-copy not registered: ${String(error)}`, { to: 'debug' })
  }
  try {
    await $.command.register({
      name: 'image-open',
      description: 'Open a picture in the default viewer',
      argumentHint: '[#n | path]',
      immediate: true,
    })
  } catch (error) {
    $.ui.log(`/image-open not registered: ${String(error)}`, { to: 'debug' })
  }
  try {
    await $.command.register({
      name: 'image-preview',
      description: 'Show or hide the thumbnails, pick how they are drawn, or show diagnostics',
      argumentHint: '[on | off | auto | pictures | blocks | status]',
      immediate: true,
    })
  } catch (error) {
    $.ui.log(`/image-preview not registered: ${String(error)}`, { to: 'debug' })
  }
}

/** Reads the prompt box and refreshes the band when the pictures it names changed. */
async function tick($: EngineInterface): Promise<void> {
  if (session === null || isTicking) return
  isTicking = true
  try {
    const box = await $.prompt.read()
    session.useSession(await $.session.id())
    const items = await session.refreshDraft(box.text)
    if (items !== null) {
      await update($, bandItems, () => items)
      const merged = PreviewSession.mergeGallery(await read($, galleryItems), items)
      if (merged !== null) await update($, galleryItems, () => merged)
    }
    await runProbe($)
  } catch (error) {
    $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isTicking = false
  }
}

/**
 * Claude Code does not say whether its Image element draws a picture here, but
 * `$.ui.blit` on a drawn Image refuses with the reason when it shows the alt
 * text instead: the probe follows that answer rather than guessing from names.
 */
async function runProbe($: EngineInterface): Promise<void> {
  if (probe === null || bandRequest === null) return
  const state = await read($, rendererState)
  if (state === null || state.mode !== 'pictures' || state.isConfirmed) {
    probe = null
    return
  }
  const asked = probe
  const result = await $.ui.blit({ requestId: bandRequest, key: asked.key, source: asked.source })
  // A command may have chosen meanwhile; its choice stands.
  if (probe !== asked || JSON.stringify(await read($, rendererState)) !== JSON.stringify(state)) return
  const deny = result.deny
  $.ui.log(`renderer probe: ${deny ?? 'the terminal draws pictures'}`, { to: 'debug' })
  if (deny === undefined) {
    await update($, rendererState, () => ({ ...state, isConfirmed: true }))
    probe = null
  } else if (/cannot read files/.test(deny)) {
    // Over ssh, or a terminal that cannot open local files: send the pixels.
    await update($, rendererState, () => ({ ...state, source: 'bytes' }))
    probe = null
  } else if (/draws its alt/.test(deny)) {
    await update($, rendererState, () => BLOCKS)
    probe = null
  } else if (++asked.attempts > 40) {
    // Not mounted for long, or another answer: keep what works everywhere.
    await update($, rendererState, () => BLOCKS)
    probe = null
  }
}

/**
 * Decodes a picture again whose pixels this module load no longer holds: the
 * gallery keeps more pictures than the cache, and a reload starts it empty.
 * The fresh item replaces the old one in place, which redraws its readers.
 */
function restore($: EngineInterface, item: PreviewItem): void {
  if (session === null || item.path === null || restoring.has(item.key)) return
  restoring.add(item.key)
  void session.store
    .describeFile(item.path, item.source, item.key, item.label)
    .then(async fresh => {
      const swap = (items: PreviewItem[]) => items.map(each => (each.key === fresh.key ? fresh : each))
      if (fresh.revision === item.revision) $.ui.invalidate('ui.render')
      else {
        await update($, galleryItems, swap)
        await update($, bandItems, swap)
      }
    })
    .catch(error => $.ui.log(`restoring ${item.label} failed: ${String(error)}`, { to: 'debug' }))
    .finally(() => restoring.delete(item.key))
}

/** What to draw for one picture: the real thing, half blocks, or a word. */
function pictureFor(
  $: EngineInterface,
  item: PreviewItem,
  cells: Cells,
  state: RendererState,
  key: string,
  side: number,
): Picture {
  if (session === null || item.status !== 'ready') return { kind: 'placeholder', text: placeholderFor(item) }
  const store = session.store
  const thumb = store.thumbnail(item.key, item.revision)
  if (thumb === null) {
    restore($, item)
    return { kind: 'placeholder', text: '…' }
  }
  if (state.mode === 'pictures') {
    if (state.source === 'file' && store.format(item.key) === 'png' && item.path !== null) {
      return { kind: 'image', key, source: { file: item.path, format: 'png' } }
    }
    const larger = store.largerCached(item.key, side)
    if (larger === null) {
      void store.larger(item.key, side).then(found => {
        if (found !== null) $.ui.invalidate('ui.render')
      })
    }
    return { kind: 'image', key, source: imageSource(larger ?? thumb) }
  }
  const cacheKey = `${item.key}|${item.revision}|${cells.columns}x${cells.rows}`
  let raster = rasterCache.get(cacheKey)
  if (raster === undefined) {
    raster = halfBlockCells(thumb, cells.columns, cells.rows)
    if (rasterCache.size > 200) rasterCache.clear()
    rasterCache.set(cacheKey, raster)
  }
  return { kind: 'raster', key, cells: raster }
}

async function openGallery($: EngineInterface, item: PreviewItem | null): Promise<void> {
  if (item !== null) await update($, selectedKey, () => item.key)
  await $.ui.open({ id: PANE, title: 'Images', focus: true, closeOnEscape: true })
}

/** The picture a command argument names: `#n`, a path, or (empty) the newest one. */
async function findItem($: EngineInterface, argument: string): Promise<PreviewItem | null> {
  if (session === null) return null
  const draft = await read($, bandItems)
  const seen = await read($, galleryItems)
  const text = argument
    .trim()
    .replace(/^@/, '')
    .replace(/^"(.*)"$/, '$1')
  if (text === '') return draft.at(-1) ?? seen.at(-1) ?? null
  const number = /^#?(\d+)$/.exec(text)
  if (number !== null) {
    const key = `paste:${number[1]}`
    return draft.find(item => item.key === key) ?? seen.find(item => item.key === key) ?? null
  }
  const item = await session.store.describeFile(session.store.resolvePath(text), 'mention')
  return item.status === 'missing' ? null : item
}

/** Takes `item`'s reference out of the prompt: its `[Image #n]` or its path. */
async function removeFromPrompt($: EngineInterface, item: PreviewItem): Promise<void> {
  const store = session?.store
  if (store === undefined) return
  const box = await $.prompt.read()
  const ref = parseDraft(box.text).find(found =>
    found.kind === 'paste' ? `paste:${found.id}` === item.key : store.resolvePath(found.path) === item.path,
  )
  if (ref === undefined) return
  await $.prompt.fill({ text: withoutRef(box.text, ref), mode: 'replace' })
  await tick($)
}

async function insertMentions($: EngineInterface, paths: readonly string[]): Promise<boolean> {
  const box = await $.prompt.read()
  const text = insertionFor(box.text, box.cursor, paths.map(mentionFor).join(' '))
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  return filled.isFilled
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const env = await readEnv($)
    settings = parseSettings(options as Readonly<Record<string, unknown>>, env)
    session = await PreviewSession.start(createHost($), env, e.cwd, settings)
    session.useSession(await $.session.id())
    const started = session
    overlay =
      settings.overlay && e.isInteractive && settings.renderer !== 'off'
        ? new PictureOverlay(
            started.host,
            started.system,
            join(started.system.style, $.plugin.root, 'hooks', 'lib', 'platform', 'overlay.cs'),
            async () => ({ dir: await started.workDir(), cache: await started.locator.workRoot() }),
            spawner($),
          )
        : null
    overlay?.start()
    const current = await read($, rendererState)
    const initial = initialRenderer(env, current)
    if (current === null || current.mode !== initial.mode || current.isConfirmed !== initial.isConfirmed) {
      await update($, rendererState, () => initial)
    }
    await registerCommands($)
    if (e.isInteractive && settings.renderer !== 'off') $.clock.every(POLL_MS, () => tick($))
    void session.housekeeping().catch(() => undefined)
    // A pane or band drawn while this ran (after a reload) drew without pictures.
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // A picture dropped into Git Bash arrives as its POSIX path: it goes in as an @-mention.
  on('prompt.edit', async ($, e, next) => {
    if (e.key !== undefined || e.inputText === '' || session?.system.platform !== 'windows') return next(e)
    const host = session.host
    const mentions = await droppedAsMentions(
      e.inputText,
      e.text[e.start - 1] ?? '',
      e.text[e.end] ?? '',
      async path => (await host.stat(path))?.kind === 'file',
    )
    return next(mentions === null ? e : { ...e, inputText: mentions })
  })

  // /clear, /resume and /branch start another session id and reset $.state.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    session?.reset()
    session?.useSession(await $.session.id())
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read the values first, every time: a drawing redraws when a value it read changes,
    // so a pass that returned before reading would never be drawn again.
    const items = await read($, bandItems)
    const isHidden = await read($, hiddenFlag)
    const state = (await read($, rendererState)) ?? BLOCKS
    if (e.surface !== 'terminal' || e.props.hasSurvey || session === null || settings.renderer === 'off') {
      if (e.surface === 'terminal') overlay?.show([])
      return next(e)
    }
    if (items.length === 0 || isHidden) {
      overlay?.show([])
      return next(e)
    }
    bandRequest = e.requestId
    const ui = $.ui.resolve(e)
    let firstPicture: { key: string; source: ImageSource } | null = null
    const covered: OverlayTile[] = []
    const tree = band({
      ui,
      items,
      maxRows: e.props.maxRows,
      maxColumns: e.props.bodyColumns,
      tileRows: settings.tileRows,
      picture: (item, cells, index) => {
        const picture = pictureFor($, item, cells, state, `band-${index}`, BAND_PICTURE_SIDE)
        if (picture.kind === 'image' && firstPicture === null)
          firstPicture = { key: picture.key, source: picture.source }
        if (picture.kind === 'raster' && item.path !== null)
          covered.push({
            columns: cells.columns,
            rows: cells.rows,
            above: ROWS_ABOVE_PICTURE,
            below: ROWS_BELOW_PICTURE,
            path: item.path,
          })
        return picture
      },
      onPress: item => void openGallery($, item),
      onRemove: item => void removeFromPrompt($, item),
    })
    overlay?.show(tree === null ? [] : covered)
    if (tree === null) return next(e)
    if (state.mode === 'pictures' && !state.isConfirmed && firstPicture !== null && probe === null) {
      probe = { ...(firstPicture as { key: string; source: ImageSource }), attempts: 0 }
    }
    const { Box } = ui
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {tree}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const items = await read($, galleryItems)
    const selected = await read($, selectedKey)
    const found = selected === null ? -1 : items.findIndex(item => item.key === selected)
    const index = found >= 0 ? found : items.length - 1
    const state = (await read($, rendererState)) ?? BLOCKS
    const actions = {
      select: (to: number) => {
        const target = items[Math.min(Math.max(0, to), items.length - 1)]
        if (target !== undefined) void update($, selectedKey, () => target.key)
      },
      open: (item: PreviewItem) =>
        void session
          ?.open(item)
          .then(result =>
            $.ui.toast(result.ok ? `Opened ${item.label}` : `Could not open ${item.label}: ${result.reason}`),
          ),
      copy: (item: PreviewItem) =>
        void session
          ?.copy(item)
          .then(result =>
            $.ui.toast(
              result.ok ? `${item.label} is on the clipboard` : `Could not copy ${item.label}: ${result.reason}`,
            ),
          ),
      insert: (item: PreviewItem) => {
        if (item.path === null) return
        const path = item.path
        void insertMentions($, [path]).then(async isFilled => {
          await $.ui.close({ id: PANE })
          $.ui.toast(isFilled ? `Inserted ${item.label}` : 'The prompt could not take it')
        })
      },
      copyPath: (item: PreviewItem) => {
        if (item.path === null) return
        void $.ui
          .copy({ text: item.path, surface: e.surface })
          .then(result => $.ui.toast(result.isCopied ? 'Path copied' : 'Could not copy the path'))
      },
    }
    const common = { items, index, bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows, actions }
    if (e.surface === 'terminal') {
      const terminal = $.ui.resolve(e)
      return gallery({
        ...common,
        ui: terminal,
        terminal,
        picture: (item, cells) => pictureFor($, item, cells, state, 'gallery-0', GALLERY_SIDE),
      })
    }
    return gallery({ ...common, ui: $.ui.resolve(e) })
  })

  on('command.run', { command: 'paste' }, async $ => {
    if (session === null) return { text: 'image-preview is still starting.' }
    session.useSession(await $.session.id())
    const capture = await session.clipboard({ reuse: false })
    if (capture.files.length === 0) {
      $.ui.toast(
        capture.reason === undefined ? 'There is no picture on the clipboard' : `No picture pasted: ${capture.reason}`,
      )
      return {}
    }
    const isFilled = await insertMentions($, capture.files)
    if (!isFilled) return { text: `Clipboard picture saved: ${capture.files.map(mentionFor).join(' ')}` }
    const names = capture.files.length === 1 ? basename(capture.files[0]!) : `${capture.files.length} pictures`
    $.ui.toast(`Pasted ${names}`)
    return {}
  })

  on('command.run', { command: 'images' }, async ($, e) => {
    const item = e.args.trim() === '' ? null : await findItem($, e.args)
    await openGallery($, item)
    return {}
  })

  on('command.run', { command: 'image-copy' }, async ($, e) => {
    const item = await findItem($, e.args)
    if (session === null || item === null) {
      $.ui.toast('No picture to copy: name one with #n or a path')
      return {}
    }
    const result = await session.copy(item)
    $.ui.toast(result.ok ? `${item.label} is on the clipboard` : `Could not copy ${item.label}: ${result.reason}`)
    return {}
  })

  on('command.run', { command: 'image-open' }, async ($, e) => {
    const item = await findItem($, e.args)
    if (session === null || item === null) {
      $.ui.toast('No picture to open: name one with #n or a path')
      return {}
    }
    const result = await session.open(item)
    $.ui.toast(result.ok ? `Opened ${item.label}` : `Could not open ${item.label}: ${result.reason}`)
    return {}
  })

  on('command.run', { command: 'image-preview' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'on' || word === 'off') {
      await update($, hiddenFlag, () => word === 'off')
      $.ui.toast(word === 'off' ? 'Thumbnails hidden for this session' : 'Thumbnails shown')
      return {}
    }
    if (word === 'pictures' || word === 'blocks' || word === 'auto') {
      // auto: try real pictures again and let the probe decide.
      const next: RendererState =
        word === 'blocks' ? BLOCKS : { mode: 'pictures', isConfirmed: word === 'pictures', source: 'file' }
      await update($, rendererState, () => next)
      probe = null
      $.ui.toast(
        word === 'blocks'
          ? 'Thumbnails drawn as colored blocks'
          : word === 'pictures'
            ? 'Thumbnails drawn as pictures'
            : 'Checking whether this terminal draws pictures',
      )
      return {}
    }
    if (session === null) return { text: 'image-preview is still starting.' }
    const state = (await read($, rendererState)) ?? BLOCKS
    const renderer = `${state.mode}${state.mode === 'pictures' ? ` from ${state.source}` : ''}${state.isConfirmed ? '' : ' (not confirmed yet)'}`
    const version = await $.session.version().then(
      found => found.version,
      () => 'unknown',
    )
    return { text: await session.diagnostics(renderer, version, await overlay?.describe()) }
  })

  // Pictures Claude reads land in the gallery, so /images shows what Claude saw.
  // With read_previews off the mod leaves the files Claude reads alone.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!settings.readPreviews) return next(e)
    const result = await next(e)
    const path = typeof e.file_path === 'string' ? e.file_path : ''
    if (session !== null && result.deny === undefined && !result.isError && looksLikeImagePath(path)) {
      if (e.tool_use_id !== undefined) {
        if (readPaths.size > 500) readPaths.clear()
        readPaths.set(e.tool_use_id, path)
      }
      void session.store.describeFile(path, 'read').then(async item => {
        const merged = PreviewSession.mergeGallery(await read($, galleryItems), [item])
        if (merged !== null) await update($, galleryItems, () => merged)
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  // ...and show as a small thumbnail under the result row in the transcript.
  on('ui.render', { component: 'ToolResult', props: { tool: 'Read' } }, async ($, e, next) => {
    const state = (await read($, rendererState)) ?? BLOCKS
    const path = readPaths.get(e.props.tool_use_id)
    if (
      !settings.readPreviews ||
      e.surface !== 'terminal' ||
      e.props.isErrored ||
      session === null ||
      path === undefined
    )
      return next(e)
    const item = await session.store.describeFile(path, 'read')
    if (item.status !== 'ready') return next(e)
    const ui = $.ui.resolve(e)
    const cells = fitCells(
      item.width !== undefined && item.height !== undefined ? { width: item.width, height: item.height } : null,
      {
        columns: Math.min(40, Math.max(8, (e.viewport?.columns ?? 80) - 8)),
        rows: 5,
      },
    )
    // Pictures in the transcript scroll with it; colored blocks are the safe choice there.
    const picture = pictureFor(
      $,
      item,
      cells,
      state.mode === 'pictures' && state.isConfirmed ? state : BLOCKS,
      `read-${e.props.tool_use_id}`,
      BAND_PICTURE_SIDE,
    )
    const own = await next(e)
    const { Box } = ui
    return (
      <Box flexDirection="column">
        {own}
        <Box marginLeft={5}>{pictureElement(ui, picture, cells, `[${item.label}]`)}</Box>
      </Box>
    )
  })

  // @clipboard typed out and sent: it becomes the clipboard's pictures, or the prompt waits.
  on('prompt.submit', async ($, e, next) => {
    if (session === null || e.origin.kind !== 'composer' || !CLIPBOARD_WORD.test(e.text)) return next(e)
    session.useSession(await $.session.id())
    const capture = await session.clipboard({ reuse: true })
    if (capture.files.length === 0) {
      return {
        drop: `There is no picture on the clipboard for @clipboard${capture.reason === undefined ? '' : ` (${capture.reason})`}.`,
      }
    }
    const mentions = capture.files.map(mentionFor).join(' ')
    return next({ ...e, text: e.text.replace(CLIPBOARD_WORDS, (_, lead: string) => `${lead}${mentions}`) })
  }).catch(($, e, next) => next(e))

  // @clipboard in the prompt: the typeahead offers the clipboard's pictures as @-mentions.
  on('prompt.autocomplete', { token: /^@c/i }, async ($, e, next) => {
    const offered = await next(e)
    const word = e.token.slice(1).toLowerCase()
    // From `@cli` on: `@cl` is also how `@CLAUDE.md` starts, and reading the clipboard is not free.
    if (session === null || word.length < 3 || !'clipboard'.startsWith(word)) return offered
    session.useSession(await $.session.id())
    const capture = await session.clipboard({ reuse: true })
    if (capture.files.length === 0) return offered
    const description =
      capture.files.length === 1
        ? `picture on the clipboard (${basename(capture.files[0]!)})`
        : `${capture.files.length} pictures on the clipboard`
    return {
      suggestions: [
        ...offered.suggestions,
        { text: `${capture.files.map(mentionFor).join(' ')} `, label: '@clipboard', description },
      ],
    }
  })
}
