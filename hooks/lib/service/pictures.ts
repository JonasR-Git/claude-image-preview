// Turns a reference (a paste, a path) into what the band shows: the facts in
// a PreviewItem for $.state, and the pixels in a cache of the module's own.
// A file is decoded once per content: size and modification time key the
// cache, so an unchanged draft costs one stat per picture.

import type { PreviewItem, PreviewSource } from '../../../types'
import { shrink } from '../codec/bitmap'
import type { Bitmap } from '../codec/bitmap'
import { BUILTIN_FORMATS, decodeImage } from '../codec/decode'
import { DecodeError, UnsupportedError } from '../codec/errors'
import { decodePng } from '../codec/png'
import { FORMAT_LABEL, IMAGE_EXTENSIONS, extensionOf, sniff } from '../codec/sniff'
import type { ImageFormat } from '../codec/sniff'
import type { DraftRef } from '../prompt/draft'
import { basename, expandHome, isNetworkPath, join, msysToWindows, resolve } from '../platform/paths'
import { convertToPng } from './convert'
import { READ_LIMIT } from './host'
import type { FileStat, Host } from './host'
import type { Locator } from './locator'
import type { System } from './system'

export type StoreOptions = {
  /** Longest side of the cached thumbnail every drawing starts from. */
  thumbSide: number
  /** How many pictures keep their pixels in memory. */
  maxEntries: number
}

type Entry = {
  item: PreviewItem
  signature: string
  format: ImageFormat | undefined
  /** The file to decode again for a larger view: the original, or its converted PNG. */
  decodePath: string
  thumb: Bitmap
  larger: Map<number, Bitmap>
  /** Larger renditions being decoded, so a redraw meanwhile does not start another. */
  pending: Map<number, Promise<Bitmap | null>>
}

const MAX_LARGER_SIDE = 1024
/** The most RGBA an `Image` takes from the plugin. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** `bitmap`, shrunk as far as it must be to fit an `Image`. */
function withinImageLimit(bitmap: Bitmap): Bitmap {
  const bytes = bitmap.width * bitmap.height * 4
  if (bytes <= MAX_IMAGE_BYTES) return bitmap
  const side = Math.max(bitmap.width, bitmap.height)
  return shrink(bitmap, Math.floor(side * Math.sqrt(MAX_IMAGE_BYTES / bytes)) - 1)
}

/** FNV-1a, for short stable file names. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** `clipboard 21:24:28` for a capture the mod saved (`clipboard-20261012-212428-549.png`); null otherwise. */
export function captureLabel(name: string): string | null {
  const match = /^clipboard-\d{8}-(\d{2})(\d{2})(\d{2})-\d{3}\.[a-z]+$/.exec(name)
  return match === null ? null : `clipboard ${match[1]}:${match[2]}:${match[3]}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PictureStore {
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<PreviewItem>>()
  /** Differs per module load, so a reload redraws pictures whose files did not change. */
  private readonly generation = Math.random().toString(36).slice(2, 8)

  constructor(
    private readonly host: Host,
    private readonly system: System,
    private readonly locator: Locator,
    private readonly cwd: string,
    private readonly workDir: () => Promise<string>,
    private readonly options: StoreOptions,
  ) {}

  /** The absolute path a mention names, from the session's working directory; Git Bash paths too on Windows. */
  resolvePath(path: string): string {
    const style = this.system.style
    const native = style === 'windows' ? (msysToWindows(path) ?? path) : path
    return resolve(this.cwd, expandHome(native, this.system.home, style), style)
  }

  static keyOfFile(path: string): string {
    return `file:${path}`
  }

  /** Describes what the draft reference shows, decoding it when its file is new or changed. */
  async describe(ref: DraftRef, sessionId: string): Promise<PreviewItem> {
    if (ref.kind === 'paste') {
      const key = `paste:${ref.id}`
      const label = `#${ref.id}`
      const path = await this.locator.pastedImage(sessionId, ref.id)
      if (path === null) {
        return {
          key,
          label,
          source: 'paste',
          path: null,
          status: 'loading',
          reason: 'waiting for the paste',
          revision: 'pending',
        }
      }
      return this.describeFile(path, 'paste', key, label)
    }
    const path = this.resolvePath(ref.path)
    const capture = captureLabel(basename(path))
    return this.describeFile(
      path,
      capture === null ? 'mention' : 'clipboard',
      PictureStore.keyOfFile(path),
      capture ?? basename(path),
    )
  }

  /** Describes the picture in a file, decoding it when new or changed. */
  async describeFile(
    path: string,
    source: PreviewSource,
    key = PictureStore.keyOfFile(path),
    label = captureLabel(basename(path)) ?? basename(path),
  ): Promise<PreviewItem> {
    const base: PreviewItem = { key, label, source, path, status: 'loading', revision: 'pending' }
    // Even a look at a share sends the account's credentials to whoever runs it.
    if (isNetworkPath(path)) return { ...base, status: 'unsupported', reason: 'network paths are not opened' }
    const stat = await this.host.stat(path)
    if (stat === null) return { ...base, status: 'missing', reason: 'file not found' }
    if (stat.kind !== 'file') return { ...base, status: 'error', reason: 'not a file' }
    const signature = `${stat.size}:${stat.mtimeMs}`
    const cached = this.entries.get(key)
    if (cached !== undefined && cached.signature === signature && cached.item.path === path) {
      this.touch(key, cached)
      return cached.item
    }
    const flight = `${key}\n${signature}`
    let pending = this.loading.get(flight)
    if (pending === undefined) {
      pending = this.load(base, stat, signature).finally(() => this.loading.delete(flight))
      this.loading.set(flight, pending)
    }
    return pending
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private remember(key: string, entry: Entry): void {
    this.touch(key, entry)
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private async load(base: PreviewItem, stat: FileStat, signature: string): Promise<PreviewItem> {
    const path = base.path!
    const revision = `${hashText(signature)}${this.generation}`
    let format = IMAGE_EXTENSIONS[extensionOf(path)]
    let width: number | undefined
    let height: number | undefined
    let bytes: Uint8Array | null = null
    const facts = () => ({
      format: format === undefined ? undefined : FORMAT_LABEL[format],
      width,
      height,
      bytes: stat.size,
    })

    if (stat.size <= READ_LIMIT) {
      try {
        bytes = await this.host.readBytes(path)
      } catch (error) {
        return { ...base, status: 'error', reason: `cannot read it: ${message(error)}`, bytes: stat.size }
      }
      const sniffed = sniff(bytes)
      if (sniffed === null) return { ...base, status: 'unsupported', reason: 'not a picture', bytes: stat.size }
      format = sniffed.format
      width = sniffed.width
      height = sniffed.height
      if (format === 'svg')
        return { ...base, ...facts(), status: 'unsupported', reason: 'SVG is drawing code, not pixels' }
      if (BUILTIN_FORMATS.has(format)) {
        try {
          const decoded = decodeImage(bytes, { maxSide: this.options.thumbSide })
          const item: PreviewItem = {
            ...base,
            ...facts(),
            width: decoded.width,
            height: decoded.height,
            status: 'ready',
            revision,
          }
          this.remember(item.key, {
            item,
            signature,
            format,
            decodePath: path,
            thumb: decoded.bitmap,
            larger: new Map(),
            pending: new Map(),
          })
          return item
        } catch (error) {
          // A variant the built-in decoder does not read still has a chance with a converter.
          if (!(error instanceof UnsupportedError)) {
            if (error instanceof DecodeError) return { ...base, ...facts(), status: 'error', reason: error.message }
            return { ...base, ...facts(), status: 'error', reason: message(error) }
          }
        }
      }
    }

    // A converter on the machine makes a PNG the built-in decoder reads, for a
    // file its first bytes or, past the read limit, its extension mark as a picture.
    if (format === undefined || format === 'svg')
      return { ...base, ...facts(), status: 'unsupported', reason: 'over 4 MB and not named as a picture' }
    const target = join(this.system.style, await this.workDir(), 'thumbs', `${hashText(`${path}\n${signature}`)}.png`)
    const converted = await convertToPng(this.system, path, target, MAX_LARGER_SIDE, format)
    if (!converted.ok) {
      const what = format === undefined ? 'this format' : FORMAT_LABEL[format]
      const reason =
        stat.size > READ_LIMIT && (format === undefined || BUILTIN_FORMATS.has(format))
          ? `over 4 MB and ${converted.reason}`
          : `${what}: ${converted.reason}`
      return { ...base, ...facts(), status: 'unsupported', reason }
    }
    try {
      const png = await this.host.readBytes(target)
      const decoded = decodePng(png, { maxSide: this.options.thumbSide, maxPixels: 64_000_000 })
      const item: PreviewItem = {
        ...base,
        ...facts(),
        width: converted.width ?? width ?? decoded.width,
        height: converted.height ?? height ?? decoded.height,
        status: 'ready',
        revision,
      }
      this.remember(item.key, {
        item,
        signature,
        format,
        decodePath: target,
        thumb: decoded.bitmap,
        larger: new Map(),
        pending: new Map(),
      })
      return item
    } catch (error) {
      return { ...base, ...facts(), status: 'error', reason: `the converted picture did not decode: ${message(error)}` }
    }
  }

  /** The cached thumbnail, when this module load has decoded it. */
  thumbnail(key: string, revision: string): Bitmap | null {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.item.revision === revision ? entry.thumb : null
  }

  /** The format of a cached picture. */
  format(key: string): ImageFormat | undefined {
    return this.entries.get(key)?.format
  }

  /** A larger rendition for a big view, decoded on first use; the thumbnail when that fails. */
  async larger(key: string, side: number): Promise<Bitmap | null> {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    const wanted = Math.min(MAX_LARGER_SIDE, Math.max(this.options.thumbSide, Math.round(side)))
    if (wanted <= this.options.thumbSide) return entry.thumb
    const bucket = Math.ceil(wanted / 128) * 128
    const cached = entry.larger.get(bucket)
    if (cached !== undefined) return cached
    let pending = entry.pending.get(bucket)
    if (pending === undefined) {
      pending = (async () => {
        try {
          const bytes = await this.host.readBytes(entry.decodePath)
          const bitmap = withinImageLimit(decodeImage(bytes, { maxSide: bucket }).bitmap)
          entry.larger.set(bucket, bitmap)
          return bitmap
        } catch {
          return entry.thumb
        } finally {
          entry.pending.delete(bucket)
        }
      })()
      entry.pending.set(bucket, pending)
    }
    return pending
  }

  /** The cached larger rendition, without decoding. */
  largerCached(key: string, side: number): Bitmap | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    const wanted = Math.min(MAX_LARGER_SIDE, Math.max(this.options.thumbSide, Math.round(side)))
    if (wanted <= this.options.thumbSide) return entry.thumb
    return entry.larger.get(Math.ceil(wanted / 128) * 128) ?? null
  }
}
