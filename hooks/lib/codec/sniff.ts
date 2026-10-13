// Format detection from content, never from the file name, and the picture's
// size read from its header without decoding it.

import { readBmpInfo } from './bmp'
import { readGifInfo } from './gif'
import { readJpegInfo } from './jpeg'
import { readPngHeader } from './png'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic' | 'avif' | 'ico' | 'svg'

export type Sniffed = {
  format: ImageFormat
  /** Pixel size as a viewer shows it, when the header says. */
  width?: number
  height?: number
  /** True for an animated GIF/WebP/PNG, when the header says. */
  isAnimated?: boolean
}

export const FORMAT_LABEL: Record<ImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  tiff: 'TIFF',
  heic: 'HEIC',
  avif: 'AVIF',
  ico: 'ICO',
  svg: 'SVG',
}

/** File extensions that name a picture, mapped to the format they usually hold. */
export const IMAGE_EXTENSIONS: Record<string, ImageFormat> = {
  png: 'png',
  apng: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  dib: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  heic: 'heic',
  heif: 'heic',
  avif: 'avif',
  ico: 'ico',
  svg: 'svg',
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)

function sniffWebp(bytes: Uint8Array): Sniffed {
  const result: Sniffed = { format: 'webp' }
  const kind = ascii(bytes, 12, 4)
  if (kind === 'VP8X' && bytes.length >= 30) {
    result.isAnimated = (bytes[20]! & 0x02) !== 0
    result.width = le24(bytes, 24) + 1
    result.height = le24(bytes, 27) + 1
  } else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
    result.width = (bits & 0x3fff) + 1
    result.height = ((bits >>> 14) & 0x3fff) + 1
  } else if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    result.width = le16(bytes, 26) & 0x3fff
    result.height = le16(bytes, 28) & 0x3fff
  }
  return result
}

/** The ISO base media "ftyp" brand family: HEIC/HEIF or AVIF. */
function sniffIsoMedia(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null
  const size = Math.min(bytes.length, ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0)
  const brands: string[] = [ascii(bytes, 8, 4)]
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(bytes, at, 4))
  if (brands.some(brand => brand === 'avif' || brand === 'avis')) return 'avif'
  if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)))
    return 'heic'
  return null
}

/** What the bytes are, by their signature; null when no known picture format. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 4) return null

  const png = readPngHeader(bytes)
  if (png !== null) {
    // An APNG announces itself with acTL before the first IDAT.
    let isAnimated = false
    for (let at = 8; at + 8 <= Math.min(bytes.length, 4096); ) {
      const length = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
      const type = ascii(bytes, at + 4, 4)
      if (type === 'acTL') isAnimated = true
      if (type === 'IDAT' || type === 'acTL') break
      at += 12 + length
    }
    return { format: 'png', width: png.width, height: png.height, isAnimated }
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const info = readJpegInfo(bytes)
    return info === null ? { format: 'jpeg' } : { format: 'jpeg', width: info.displayWidth, height: info.displayHeight }
  }

  const gif = readGifInfo(bytes)
  if (gif !== null) {
    // More than one image descriptor is an animation; checking the count is cheap enough to skip.
    return { format: 'gif', width: gif.width, height: gif.height }
  }

  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return sniffWebp(bytes)

  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const bmp = readBmpInfo(bytes)
    if (bmp !== null) return { format: 'bmp', width: bmp.width, height: bmp.height }
  }

  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return { format: 'tiff' }
  }

  const iso = sniffIsoMedia(bytes)
  if (iso !== null) return { format: iso }

  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return { format: 'ico' }

  const head = ascii(bytes, 0, Math.min(bytes.length, 256)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { format: 'svg' }

  return null
}

/** The lower-case extension of a file name or path, without the dot; '' when none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when a path's extension names a picture format. */
export function looksLikeImagePath(path: string): boolean {
  return Object.hasOwn(IMAGE_EXTENSIONS, extensionOf(path))
}
