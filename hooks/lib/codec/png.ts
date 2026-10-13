// PNG decoder: every color type and bit depth, palettes, tRNS transparency and
// Adam7 interlacing. Rows are unfiltered as the inflater hands them over and
// go straight into the downsampler, so a large screenshot never has to exist
// at full size; only interlaced files are assembled whole first.

import { BoxDownsampler, createBitmap, fitWithin, shrink } from './bitmap'
import type { Bitmap } from './bitmap'
import { DecodeError } from './errors'
import { inflate } from './inflate'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Adam7: start column, start row, column step, row step of each pass.
const PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

export type PngHeader = {
  width: number
  height: number
  depth: number
  colorType: number
  interlaced: boolean
}

export type PngDecodeOptions = {
  /** Longest side of the result; larger pictures are downsampled while decoding. */
  maxSide: number
  /** Refuse pictures with more pixels than this. */
  maxPixels: number
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((byte, i) => bytes[i] === byte)
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
}

/** The header alone, from the first 33 bytes; null when they are not a PNG's. */
export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (!isPng(bytes) || bytes.length < 29) return null
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null
  return {
    width: u32(bytes, 16),
    height: u32(bytes, 20),
    depth: bytes[24]!,
    colorType: bytes[25]!,
    interlaced: bytes[28] === 1,
  }
}

type Chunks = {
  header: PngHeader
  palette: Uint8Array | null
  transparency: Uint8Array | null
  data: Uint8Array
}

function readChunks(bytes: Uint8Array): Chunks {
  const header = readPngHeader(bytes)
  if (header === null) throw new DecodeError('not a PNG file')
  const { width, height, depth, colorType } = header
  if (width === 0 || height === 0) throw new DecodeError('PNG has no pixels')
  if (!(DEPTHS[colorType] ?? []).includes(depth)) {
    throw new DecodeError(`PNG color type ${colorType} with bit depth ${depth} is invalid`)
  }

  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const parts: Uint8Array[] = []
  let dataLength = 0
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const start = at + 8
    const end = start + length
    if (end > bytes.length) {
      // A cut-off file: decode what arrived, as viewers do.
      if (type === 'IDAT') {
        parts.push(bytes.subarray(start))
        dataLength += bytes.length - start
      }
      break
    }
    if (type === 'PLTE') palette = bytes.subarray(start, end)
    else if (type === 'tRNS') transparency = bytes.subarray(start, end)
    else if (type === 'IDAT') {
      parts.push(bytes.subarray(start, end))
      dataLength += length
    } else if (type === 'IEND') break
    at = end + 4 // the CRC
  }
  if (parts.length === 0) throw new DecodeError('PNG has no image data')
  if (colorType === 3 && palette === null) throw new DecodeError('PNG palette is missing')

  let data: Uint8Array
  if (parts.length === 1) data = parts[0]!
  else {
    data = new Uint8Array(dataLength)
    let offset = 0
    for (const part of parts) {
      data.set(part, offset)
      offset += part.length
    }
  }
  return { header, palette, transparency, data }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reverses the filter of one row in place, given the unfiltered row above it. */
function unfilter(type: number, row: Uint8Array, previous: Uint8Array, bpp: number): void {
  const length = row.length
  switch (type) {
    case 0:
      return
    case 1:
      for (let i = bpp; i < length; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff
      return
    case 2:
      for (let i = 0; i < length; i++) row[i] = (row[i]! + previous[i]!) & 0xff
      return
    case 3:
      for (let i = 0; i < bpp; i++) row[i] = (row[i]! + (previous[i]! >> 1)) & 0xff
      for (let i = bpp; i < length; i++) row[i] = (row[i]! + ((row[i - bpp]! + previous[i]!) >> 1)) & 0xff
      return
    case 4:
      for (let i = 0; i < bpp; i++) row[i] = (row[i]! + previous[i]!) & 0xff
      for (let i = bpp; i < length; i++) {
        row[i] = (row[i]! + paeth(row[i - bpp]!, previous[i]!, previous[i - bpp]!)) & 0xff
      }
      return
    default:
      throw new DecodeError(`PNG row has unknown filter type ${type}`)
  }
}

/** Converts unfiltered rows of one color type and depth to RGBA. */
function rowConverter(chunks: Chunks): (row: Uint8Array, width: number, out: Uint8Array) => void {
  const { depth, colorType } = chunks.header
  const trns = chunks.transparency
  const sixteen = depth === 16

  if (colorType === 3) {
    const palette = chunks.palette!
    const entries = Math.floor(palette.length / 3)
    const lut = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i++) {
      if (i < entries) {
        lut[i * 4] = palette[i * 3]!
        lut[i * 4 + 1] = palette[i * 3 + 1]!
        lut[i * 4 + 2] = palette[i * 3 + 2]!
      }
      lut[i * 4 + 3] = trns !== null && i < trns.length ? trns[i]! : 255
    }
    const mask = (1 << depth) - 1
    const perByte = 8 / depth
    return (row, width, out) => {
      for (let x = 0; x < width; x++) {
        const index = depth === 8 ? row[x]! : (row[(x / perByte) | 0]! >> (8 - depth * ((x % perByte) + 1))) & mask
        out[x * 4] = lut[index * 4]!
        out[x * 4 + 1] = lut[index * 4 + 1]!
        out[x * 4 + 2] = lut[index * 4 + 2]!
        out[x * 4 + 3] = lut[index * 4 + 3]!
      }
    }
  }

  if (colorType === 0) {
    const key = trns !== null && trns.length >= 2 ? (trns[0]! << 8) | trns[1]! : -1
    const mask = (1 << Math.min(depth, 8)) - 1
    const scale = depth < 8 ? 255 / mask : 1
    const perByte = depth < 8 ? 8 / depth : 1
    return (row, width, out) => {
      for (let x = 0; x < width; x++) {
        let raw: number
        let gray: number
        if (sixteen) {
          raw = (row[x * 2]! << 8) | row[x * 2 + 1]!
          gray = row[x * 2]!
        } else if (depth === 8) {
          raw = gray = row[x]!
        } else {
          raw = (row[(x / perByte) | 0]! >> (8 - depth * ((x % perByte) + 1))) & mask
          gray = Math.round(raw * scale)
        }
        out[x * 4] = out[x * 4 + 1] = out[x * 4 + 2] = gray
        out[x * 4 + 3] = raw === key ? 0 : 255
      }
    }
  }

  if (colorType === 2) {
    const key =
      trns !== null && trns.length >= 6
        ? [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!]
        : null
    return (row, width, out) => {
      for (let x = 0; x < width; x++) {
        let r: number
        let g: number
        let b: number
        let transparent = false
        if (sixteen) {
          const at = x * 6
          r = row[at]!
          g = row[at + 2]!
          b = row[at + 4]!
          if (key !== null) {
            transparent =
              ((row[at]! << 8) | row[at + 1]!) === key[0] &&
              ((row[at + 2]! << 8) | row[at + 3]!) === key[1] &&
              ((row[at + 4]! << 8) | row[at + 5]!) === key[2]
          }
        } else {
          const at = x * 3
          r = row[at]!
          g = row[at + 1]!
          b = row[at + 2]!
          if (key !== null) transparent = r === key[0] && g === key[1] && b === key[2]
        }
        out[x * 4] = r
        out[x * 4 + 1] = g
        out[x * 4 + 2] = b
        out[x * 4 + 3] = transparent ? 0 : 255
      }
    }
  }

  if (colorType === 4) {
    const step = sixteen ? 4 : 2
    const alphaAt = sixteen ? 2 : 1
    return (row, width, out) => {
      for (let x = 0; x < width; x++) {
        const gray = row[x * step]!
        out[x * 4] = out[x * 4 + 1] = out[x * 4 + 2] = gray
        out[x * 4 + 3] = row[x * step + alphaAt]!
      }
    }
  }

  // Color type 6: RGBA.
  if (sixteen) {
    return (row, width, out) => {
      for (let x = 0; x < width; x++) {
        out[x * 4] = row[x * 8]!
        out[x * 4 + 1] = row[x * 8 + 2]!
        out[x * 4 + 2] = row[x * 8 + 4]!
        out[x * 4 + 3] = row[x * 8 + 6]!
      }
    }
  }
  return (row, width, out) => out.set(row.subarray(0, width * 4))
}

/** One pass of rows (the whole picture when not interlaced). */
type Pass = { x0: number; y0: number; dx: number; dy: number; width: number; height: number; rowBytes: number }

function passesOf(header: PngHeader, bitsPerPixel: number): Pass[] {
  const layout = header.interlaced ? PASSES : ([[0, 0, 1, 1]] as const)
  const passes: Pass[] = []
  for (const [x0, y0, dx, dy] of layout) {
    const width = Math.ceil((header.width - x0) / dx)
    const height = Math.ceil((header.height - y0) / dy)
    if (width <= 0 || height <= 0) continue
    passes.push({ x0, y0, dx, dy, width, height, rowBytes: Math.ceil((width * bitsPerPixel) / 8) })
  }
  return passes
}

/**
 * Decodes a PNG to RGBA, downsampled to fit `maxSide`. Reports the full size
 * separately so a caller can show the real dimensions.
 */
export function decodePng(
  bytes: Uint8Array,
  options: PngDecodeOptions,
): { bitmap: Bitmap; width: number; height: number } {
  const chunks = readChunks(bytes)
  const { header } = chunks
  const { width, height } = header
  if (width * height > options.maxPixels) {
    throw new DecodeError(`PNG is ${width}x${height}, more pixels than a preview decodes`)
  }

  const bitsPerPixel = CHANNELS[header.colorType]! * header.depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const passes = passesOf(header, bitsPerPixel)
  const convert = rowConverter(chunks)
  const target = fitWithin(header, options.maxSide)
  // Interlaced pictures land in a full canvas first: a pass covers every row.
  const canvas = header.interlaced ? createBitmap(width, height) : null
  const sampler = canvas === null ? new BoxDownsampler(width, height, target.width, target.height) : null

  let passIndex = 0
  let pass = passes[0]!
  let rowInPass = 0
  let filled = 0
  let current = new Uint8Array(pass.rowBytes + 1)
  let previous = new Uint8Array(pass.rowBytes + 1)
  const pixels = new Uint8Array(width * 4)

  const finishRow = (): boolean => {
    const filter = current[0]!
    const row = current.subarray(1)
    unfilter(filter, row, previous.subarray(1), bpp)
    convert(row, pass.width, pixels)
    const y = pass.y0 + rowInPass * pass.dy
    if (sampler !== null) {
      sampler.addRow(y, pixels)
    } else {
      const data = canvas!.data
      for (let i = 0; i < pass.width; i++) {
        const to = (y * width + pass.x0 + i * pass.dx) * 4
        data[to] = pixels[i * 4]!
        data[to + 1] = pixels[i * 4 + 1]!
        data[to + 2] = pixels[i * 4 + 2]!
        data[to + 3] = pixels[i * 4 + 3]!
      }
    }
    const swap = previous
    previous = current
    current = swap
    filled = 0
    if (++rowInPass < pass.height) return true
    // Next pass: rows are a different length and the "row above" starts empty.
    if (++passIndex >= passes.length) return false
    pass = passes[passIndex]!
    rowInPass = 0
    current = new Uint8Array(pass.rowBytes + 1)
    previous = new Uint8Array(pass.rowBytes + 1)
    return true
  }

  const expected = passes.reduce((sum, p) => sum + (p.rowBytes + 1) * p.height, 0)
  try {
    inflate(
      chunks.data,
      chunk => {
        let at = 0
        while (at < chunk.length) {
          const take = Math.min(current.length - filled, chunk.length - at)
          current.set(chunk.subarray(at, at + take), filled)
          filled += take
          at += take
          if (filled === current.length && !finishRow()) return false
        }
        return true
      },
      { zlib: true, limit: expected + 1024 },
    )
  } catch (error) {
    // A truncated stream still shows the rows that arrived; anything else is fatal.
    if (passIndex === 0 && rowInPass === 0) throw error
  }

  if (sampler !== null) return { bitmap: sampler.result(), width, height }
  return { bitmap: shrink(canvas!, options.maxSide), width, height }
}
