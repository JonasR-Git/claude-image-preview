// Colored half blocks for terminals that draw no pictures. Each cell holds two
// pixels stacked: the upper as the glyph's color, the lower as the cell's
// background. Fully transparent pixels show the terminal's own background.

import { toBase64 } from '../codec/base64'
import { BoxDownsampler, createBitmap } from '../codec/bitmap'
import type { Bitmap } from '../codec/bitmap'

/** The Raster element's color for "the terminal's default". */
export const DEFAULT_COLOR = 0x01000000

const UPPER_HALF = 0x2580 // ▀
const LOWER_HALF = 0x2584 // ▄
const SPACE = 0x20

/** What a partly transparent pixel is blended on: most terminals are dark. */
const UNDER = [30, 30, 30] as const

/** Scales a bitmap to exactly `width` x `height`: area-averaging down, nearest pixel up. */
export function resize(bitmap: Bitmap, width: number, height: number): Bitmap {
  if (bitmap.width === width && bitmap.height === height) return bitmap
  if (width <= bitmap.width && height <= bitmap.height) {
    const sampler = new BoxDownsampler(bitmap.width, bitmap.height, width, height)
    const stride = bitmap.width * 4
    for (let y = 0; y < bitmap.height; y++) sampler.addRow(y, bitmap.data, y * stride)
    return sampler.result()
  }
  const out = createBitmap(width, height)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(bitmap.height - 1, Math.floor(((y + 0.5) * bitmap.height) / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(bitmap.width - 1, Math.floor(((x + 0.5) * bitmap.width) / width))
      const from = (sy * bitmap.width + sx) * 4
      out.data.set(bitmap.data.subarray(from, from + 4), (y * width + x) * 4)
    }
  }
  return out
}

/**
 * A pixel as a cell color: null when it should show the terminal's
 * background, else 0xRRGGBB with partial transparency blended on dark.
 */
function colorOf(data: Uint8Array, at: number): number | null {
  const alpha = data[at + 3]!
  if (alpha === 0) return null
  const r = data[at]!
  const g = data[at + 1]!
  const b = data[at + 2]!
  if (alpha === 255) return (r << 16) | (g << 8) | b
  const mix = (top: number, bottom: number) => Math.round((top * alpha + bottom * (255 - alpha)) / 255)
  return (mix(r, UNDER[0]) << 16) | (mix(g, UNDER[1]) << 8) | mix(b, UNDER[2])
}

/** The `cells` of a Raster that draws `bitmap` in `columns` x `rows` half-block cells. */
export function halfBlockCells(bitmap: Bitmap, columns: number, rows: number): string {
  const pixels = resize(bitmap, columns, rows * 2)
  const words = new Uint32Array(columns * rows * 3)
  const data = pixels.data
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const top = colorOf(data, (row * 2 * columns + column) * 4)
      const bottom = colorOf(data, ((row * 2 + 1) * columns + column) * 4)
      const at = (row * columns + column) * 3
      if (top === null && bottom === null) {
        words[at] = SPACE
        words[at + 1] = DEFAULT_COLOR
        words[at + 2] = DEFAULT_COLOR
      } else if (top === null) {
        words[at] = LOWER_HALF
        words[at + 1] = bottom!
        words[at + 2] = DEFAULT_COLOR
      } else {
        words[at] = UPPER_HALF
        words[at + 1] = top
        words[at + 2] = bottom ?? DEFAULT_COLOR
      }
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

/** RGBA bytes for an Image source, within the element's 2 MiB and 2048-pixel limits. */
export function imageSource(bitmap: Bitmap): { rgba: string; width: number; height: number } {
  return { rgba: toBase64(bitmap.data), width: bitmap.width, height: bitmap.height }
}
