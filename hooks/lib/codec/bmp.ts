// BMP decoder: OS/2 and Windows headers (core through V5), 1/2/4/8-bit
// palettes, 16/24/32-bit pixels, bit-field masks with alpha, RLE4 and RLE8,
// and top-down or bottom-up rows. Windows puts BMP and DIB data on the clipboard.

import { BoxDownsampler, fitWithin } from './bitmap'
import type { Bitmap } from './bitmap'
import { DecodeError, UnsupportedError } from './errors'

export type BmpInfo = { width: number; height: number }

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const i32 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)

export function isBmp(bytes: Uint8Array): boolean {
  return bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d
}

type Header = {
  width: number
  height: number
  topDown: boolean
  depth: number
  compression: number
  dataOffset: number
  palette: Uint8Array[]
  masks: [number, number, number, number] | null
}

function readHeader(bytes: Uint8Array): Header {
  if (!isBmp(bytes)) throw new DecodeError('not a BMP file')
  const dataOffset = u32(bytes, 10)
  const headerSize = u32(bytes, 14)
  let width: number
  let rawHeight: number
  let depth: number
  let compression = 0
  let colors = 0
  let masks: [number, number, number, number] | null = null
  let paletteEntrySize = 4
  if (headerSize === 12) {
    width = u16(bytes, 18)
    rawHeight = u16(bytes, 20)
    depth = u16(bytes, 24)
    paletteEntrySize = 3
  } else if (headerSize >= 40) {
    width = i32(bytes, 18)
    rawHeight = i32(bytes, 22)
    depth = u16(bytes, 28)
    compression = u32(bytes, 30)
    colors = u32(bytes, 46)
    if (compression === 3 || compression === 6) {
      // Masks follow a 40-byte header, or sit inside a V2 and later header.
      const at = 14 + 40
      masks = [
        u32(bytes, at),
        u32(bytes, at + 4),
        u32(bytes, at + 8),
        compression === 6 || headerSize >= 56 ? u32(bytes, at + 12) : 0,
      ]
    } else if (headerSize >= 56 && (depth === 16 || depth === 32)) {
      const alpha = u32(bytes, 14 + 52)
      if (alpha !== 0 && depth === 32) masks = [0x00ff0000, 0x0000ff00, 0x000000ff, alpha]
    }
  } else {
    throw new UnsupportedError(`BMP header of ${headerSize} bytes is not supported`)
  }
  if (width <= 0 || rawHeight === 0) throw new DecodeError('BMP has no pixels')
  if (![1, 2, 4, 8, 16, 24, 32].includes(depth)) throw new UnsupportedError(`${depth}-bit BMP is not supported`)
  if (compression === 4 || compression === 5)
    throw new UnsupportedError('BMP with embedded JPEG or PNG data is not supported')

  const palette: Uint8Array[] = []
  if (depth <= 8) {
    const count = colors > 0 ? Math.min(colors, 256) : 1 << depth
    const start =
      14 + headerSize + (compression === 3 && headerSize === 40 ? 12 : compression === 6 && headerSize === 40 ? 16 : 0)
    for (let i = 0; i < count; i++) {
      const at = start + i * paletteEntrySize
      if (at + 3 > bytes.length) break
      palette.push(Uint8Array.of(bytes[at + 2]!, bytes[at + 1]!, bytes[at]!))
    }
  }
  return { width, height: Math.abs(rawHeight), topDown: rawHeight < 0, depth, compression, dataOffset, palette, masks }
}

export function readBmpInfo(bytes: Uint8Array): BmpInfo | null {
  try {
    const header = readHeader(bytes)
    return { width: header.width, height: header.height }
  } catch {
    return null
  }
}

/** Extracts the channel a mask selects, scaled to 0-255. */
function channel(value: number, mask: number): number {
  if (mask === 0) return 0
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  const max = mask >>> shift
  return Math.round((((value & mask) >>> shift) * 255) / max)
}

/** Expands RLE4/RLE8 data into one palette index per pixel, bottom-up. */
function expandRle(bytes: Uint8Array, header: Header): Uint8Array {
  const { width, height, compression } = header
  const out = new Uint8Array(width * height)
  let at = header.dataOffset
  let x = 0
  let y = 0
  const put = (index: number) => {
    if (x < width && y < height) out[y * width + x] = index
    x++
  }
  while (at + 1 < bytes.length && y < height) {
    const count = bytes[at]!
    const value = bytes[at + 1]!
    at += 2
    if (count > 0) {
      for (let i = 0; i < count; i++) put(compression === 1 ? value : i % 2 === 0 ? value >> 4 : value & 15)
    } else if (value === 0) {
      x = 0
      y++
    } else if (value === 1) {
      break
    } else if (value === 2) {
      x += bytes[at]!
      y += bytes[at + 1]!
      at += 2
    } else {
      // Absolute run of `value` pixels, padded to 16 bits.
      if (compression === 1) {
        for (let i = 0; i < value; i++) put(bytes[at + i]!)
        at += value + (value & 1)
      } else {
        for (let i = 0; i < value; i++) put(i % 2 === 0 ? bytes[at + (i >> 1)]! >> 4 : bytes[at + (i >> 1)]! & 15)
        const used = Math.ceil(value / 2)
        at += used + (used & 1)
      }
    }
  }
  return out
}

export function decodeBmp(
  bytes: Uint8Array,
  options: { maxSide: number; maxPixels: number },
): { bitmap: Bitmap; width: number; height: number } {
  const header = readHeader(bytes)
  const { width, height, depth, compression, palette } = header
  if (width * height > options.maxPixels)
    throw new DecodeError(`BMP is ${width}x${height}, more pixels than a preview decodes`)
  const target = fitWithin(header, options.maxSide)
  const sampler = new BoxDownsampler(width, height, target.width, target.height)
  const row = new Uint8Array(width * 4)
  const color = (index: number, at: number) => {
    const entry = palette[index]
    row[at] = entry?.[0] ?? 0
    row[at + 1] = entry?.[1] ?? 0
    row[at + 2] = entry?.[2] ?? 0
    row[at + 3] = 255
  }

  if (compression === 1 || compression === 2) {
    const indices = expandRle(bytes, header)
    for (let stored = 0; stored < height; stored++) {
      for (let x = 0; x < width; x++) color(indices[stored * width + x]!, x * 4)
      sampler.addRow(header.topDown ? stored : height - 1 - stored, row)
    }
    return { bitmap: sampler.result(), width, height }
  }

  const stride = Math.ceil((width * depth) / 32) * 4
  let masks = header.masks
  if (masks === null && depth === 16) masks = [0x7c00, 0x03e0, 0x001f, 0]
  // 32-bit BI_RGB keeps a byte that is usually 0; it is alpha only when some pixel uses it.
  let alphaInUnusedByte = false
  if (depth === 32 && masks === null) {
    for (let y = 0; y < height && !alphaInUnusedByte; y++) {
      const start = header.dataOffset + y * stride
      for (let x = 0; x < width; x++) {
        if (bytes[start + x * 4 + 3]) {
          alphaInUnusedByte = true
          break
        }
      }
    }
  }

  for (let stored = 0; stored < height; stored++) {
    const start = header.dataOffset + stored * stride
    if (start + stride > bytes.length + 3) break
    for (let x = 0; x < width; x++) {
      const at = x * 4
      if (depth <= 8) {
        const perByte = 8 / depth
        const byte = bytes[start + Math.floor(x / perByte)] ?? 0
        const index = (byte >> (8 - depth * ((x % perByte) + 1))) & ((1 << depth) - 1)
        color(index, at)
      } else if (depth === 24) {
        const p = start + x * 3
        row[at] = bytes[p + 2] ?? 0
        row[at + 1] = bytes[p + 1] ?? 0
        row[at + 2] = bytes[p] ?? 0
        row[at + 3] = 255
      } else if (masks !== null) {
        const p = start + x * (depth / 8)
        const value = depth === 16 ? u16(bytes, p) : u32(bytes, p)
        row[at] = channel(value, masks[0])
        row[at + 1] = channel(value, masks[1])
        row[at + 2] = channel(value, masks[2])
        row[at + 3] = masks[3] !== 0 ? channel(value, masks[3]) : 255
      } else {
        const p = start + x * 4
        row[at] = bytes[p + 2] ?? 0
        row[at + 1] = bytes[p + 1] ?? 0
        row[at + 2] = bytes[p] ?? 0
        row[at + 3] = alphaInUnusedByte ? (bytes[p + 3] ?? 255) : 255
      }
    }
    sampler.addRow(header.topDown ? stored : height - 1 - stored, row)
  }
  return { bitmap: sampler.result(), width, height }
}
