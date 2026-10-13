// One entry point for every built-in decoder.

import type { Bitmap } from './bitmap'
import { decodeBmp } from './bmp'
import { DecodeError, UnsupportedError } from './errors'
import { decodeGif } from './gif'
import { decodeJpeg } from './jpeg'
import { decodePng } from './png'
import { FORMAT_LABEL, sniff } from './sniff'
import type { ImageFormat } from './sniff'
import { decodeWebp } from './webp'

export type DecodeOptions = {
  /** Longest side of the bitmap returned; the picture is downsampled to fit. */
  maxSide: number
  /** Pictures with more pixels than this are refused rather than decoded. */
  maxPixels?: number
}

export type Decoded = {
  format: ImageFormat
  /** The picture's own size, as a viewer shows it. */
  width: number
  height: number
  /** The downsampled RGBA pixels. */
  bitmap: Bitmap
}

/** Formats the built-in decoders read; the rest need a converter on the machine. */
export const BUILTIN_FORMATS: ReadonlySet<ImageFormat> = new Set(['png', 'jpeg', 'gif', 'bmp', 'webp'])

export const DEFAULT_MAX_PIXELS = 64_000_000

/** Decodes a picture in any built-in format. Throws DecodeError or UnsupportedError. */
export function decodeImage(bytes: Uint8Array, options: DecodeOptions): Decoded {
  const sniffed = sniff(bytes)
  if (sniffed === null) throw new DecodeError('not a picture in a known format')
  const limits = {
    maxSide: Math.max(1, Math.floor(options.maxSide)),
    maxPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
  }
  let result: { bitmap: Bitmap; width: number; height: number }
  switch (sniffed.format) {
    case 'png':
      result = decodePng(bytes, limits)
      break
    case 'jpeg':
      result = decodeJpeg(bytes, limits)
      break
    case 'gif':
      result = decodeGif(bytes, limits)
      break
    case 'bmp':
      result = decodeBmp(bytes, limits)
      break
    case 'webp':
      result = decodeWebp(bytes, limits)
      break
    default:
      throw new UnsupportedError(`${FORMAT_LABEL[sniffed.format]} needs a converter on this machine`)
  }
  return { format: sniffed.format, ...result }
}
