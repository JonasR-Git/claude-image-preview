// WebP decoder: the RIFF container (simple, extended, and animated files,
// whose first frame is shown), lossless VP8L, lossy VP8 key frames with the
// loop filter, and the ALPH chunk that gives a lossy picture its alpha.
//
// Browsers copy pictures as WebP more and more, and Claude Code stores a
// pasted WebP as it came, so this format matters as much as PNG and JPEG.

import { BoxDownsampler, createBitmap, fitWithin } from './bitmap'
import type { Bitmap } from './bitmap'
import { DecodeError, UnsupportedError } from './errors'
import {
  AC_TABLE,
  BANDS,
  BMODE_PROBS,
  CAT_PROBS,
  CODE_LENGTH_ORDER,
  COEFF_PROBS,
  COEFF_UPDATE_PROBS,
  DC_TABLE,
  DISTANCE_MAP,
  ZIGZAG,
} from './vp8-tables'

/** Decoded pixels; `fullWidth` and `fullHeight` say the picture's size when the pixels are a reduced copy. */
type Raw = { width: number; height: number; rgba: Uint8Array; fullWidth?: number; fullHeight?: number }

const ascii = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const le32 = (b: Uint8Array, at: number) => (le24(b, at) | (b[at + 3]! << 24)) >>> 0

// ------------------------------------------------------------------ container

type Chunk = { id: string; data: Uint8Array }

function readChunks(bytes: Uint8Array, from: number, to: number): Chunk[] {
  const out: Chunk[] = []
  let at = from
  while (at + 8 <= to) {
    const id = ascii(bytes, at)
    const size = le32(bytes, at + 4)
    const start = at + 8
    const end = Math.min(to, start + size)
    out.push({ id, data: bytes.subarray(start, end) })
    at = start + size + (size & 1)
  }
  return out
}

export function decodeWebp(
  bytes: Uint8Array,
  options: { maxSide: number; maxPixels: number },
): { bitmap: Bitmap; width: number; height: number } {
  if (bytes.length < 16 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP') {
    throw new DecodeError('not a WebP file')
  }
  const end = Math.min(bytes.length, 8 + le32(bytes, 4))
  const chunks = readChunks(bytes, 12, end)

  let canvasWidth = 0
  let canvasHeight = 0
  const extended = chunks.find(chunk => chunk.id === 'VP8X')
  if (extended !== undefined && extended.data.length >= 10) {
    canvasWidth = le24(extended.data, 4) + 1
    canvasHeight = le24(extended.data, 7) + 1
  }

  let frameChunks = chunks
  let offsetX = 0
  let offsetY = 0
  const firstFrame = chunks.find(chunk => chunk.id === 'ANMF')
  if (firstFrame !== undefined && firstFrame.data.length >= 16) {
    const data = firstFrame.data
    offsetX = le24(data, 0) * 2
    offsetY = le24(data, 3) * 2
    frameChunks = readChunks(data, 16, data.length)
  }

  const guard = (width: number, height: number) => {
    if (width * height > options.maxPixels) {
      throw new DecodeError(`WebP is ${width}x${height}, more pixels than a preview decodes`)
    }
  }
  if (canvasWidth > 0) guard(canvasWidth, canvasHeight)

  // The loop filter's effect does not survive shrinking to a third or less.
  const shrinks = (size: number) => size > 0 && options.maxSide * 3 <= size
  // A frame placed on a larger canvas is composited at full size.
  const fillsCanvas = (width: number, height: number) =>
    offsetX === 0 && offsetY === 0 && (canvasWidth === 0 || (canvasWidth === width && canvasHeight === height))
  const raw = decodeFrame(
    frameChunks,
    guard,
    (width, height) => fillsCanvas(width, height) && shrinks(Math.max(width, height)),
  )
  const fullWidth = raw.fullWidth ?? raw.width
  const fullHeight = raw.fullHeight ?? raw.height
  const isReduced = raw.fullWidth !== undefined
  const width = canvasWidth > 0 && !isReduced ? canvasWidth : raw.width
  const height = canvasHeight > 0 && !isReduced ? canvasHeight : raw.height

  // An animation frame sits somewhere on its canvas; everything else fills it.
  let source = raw
  if (width !== raw.width || height !== raw.height || offsetX !== 0 || offsetY !== 0) {
    const canvas = createBitmap(width, height)
    for (let y = 0; y < raw.height && y + offsetY < height; y++) {
      const rowWidth = Math.min(raw.width, width - offsetX)
      if (rowWidth <= 0) break
      canvas.data.set(
        raw.rgba.subarray(y * raw.width * 4, (y * raw.width + rowWidth) * 4),
        ((y + offsetY) * width + offsetX) * 4,
      )
    }
    source = { width, height, rgba: canvas.data }
  }

  const target = fitWithin({ width, height }, options.maxSide)
  const sampler = new BoxDownsampler(width, height, target.width, target.height)
  for (let y = 0; y < height; y++) sampler.addRow(y, source.rgba, y * width * 4)
  const shown = isReduced ? { width: canvasWidth || fullWidth, height: canvasHeight || fullHeight } : { width, height }
  return { bitmap: sampler.result(), ...shown }
}

function decodeFrame(
  chunks: Chunk[],
  guard: (width: number, height: number) => void,
  canSkipFilter: (width: number, height: number) => boolean,
): Raw {
  const lossless = chunks.find(chunk => chunk.id === 'VP8L')
  if (lossless !== undefined) return decodeLossless(lossless.data, guard)
  const lossy = chunks.find(chunk => chunk.id === 'VP8 ')
  if (lossy === undefined) throw new DecodeError('WebP has no image data')
  const frame = decodeLossy(lossy.data, (width, height) => guard(width, height), false, canSkipFilter)
  const alpha = chunks.find(chunk => chunk.id === 'ALPH')
  if (alpha !== undefined) {
    try {
      const plane = decodeAlpha(alpha.data, frame.width, frame.height)
      for (let i = 0; i < plane.length; i++) frame.rgba[i * 4 + 3] = plane[i]!
    } catch {
      // A broken alpha plane leaves the picture opaque rather than unreadable.
    }
  }
  return frame
}

// ------------------------------------------------------------ VP8L lossless

class LsbReader {
  private buffer = 0
  private count = 0
  private overrun = 0

  constructor(
    private readonly data: Uint8Array,
    private position = 0,
  ) {}

  fill(bits: number): void {
    while (this.count < bits) {
      let byte = 0
      if (this.position < this.data.length) byte = this.data[this.position++]!
      else if (++this.overrun > 8) throw new DecodeError('WebP lossless data is truncated')
      this.buffer |= byte << this.count
      this.count += 8
    }
  }

  bits(n: number): number {
    if (n === 0) return 0
    this.fill(n)
    const value = this.buffer & ((1 << n) - 1)
    this.buffer >>>= n
    this.count -= n
    return value
  }

  peek(): number {
    this.fill(15)
    return this.buffer
  }

  skip(n: number): void {
    this.buffer >>>= n
    this.count -= n
  }
}

/** A canonical prefix code read least significant bit first, as VP8L (and DEFLATE) pack it. */
type PrefixCode = {
  /** The one symbol of a code with a single used symbol, which takes no bits; -1 otherwise. */
  single: number
  /** (length << 16) | symbol for codes of up to 8 bits, indexed by the next 8 bits. */
  root: Int32Array
  counts: Uint16Array
  symbols: Uint16Array
}

function buildPrefixCode(lengths: Uint8Array): PrefixCode {
  const counts = new Uint16Array(16)
  let used = 0
  let last = -1
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    counts[length]!++
    used++
    last = symbol
  }
  if (used === 0) throw new DecodeError('WebP prefix code has no symbols')
  const root = new Int32Array(256)
  if (used === 1) return { single: last, root, counts, symbols: Uint16Array.of(last) }

  const offsets = new Uint16Array(16)
  for (let length = 1; length < 16; length++) offsets[length] = offsets[length - 1]! + counts[length - 1]!
  const symbols = new Uint16Array(used)
  const next = new Uint16Array(16)
  for (let length = 1, code = 0; length < 16; length++) {
    code = (code + counts[length - 1]!) << 1
    next[length] = code
  }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    symbols[offsets[length]!++] = symbol
    const code = next[length]!++
    if (length > 8) continue
    let reversed = 0
    for (let i = 0, c = code; i < length; i++, c >>= 1) reversed = (reversed << 1) | (c & 1)
    for (let at = reversed; at < 256; at += 1 << length) root[at] = (length << 16) | symbol
  }
  return { single: -1, root, counts, symbols }
}

function readSymbol(reader: LsbReader, code: PrefixCode): number {
  if (code.single >= 0) return code.single
  const bits = reader.peek()
  const entry = code.root[bits & 255]!
  if (entry !== 0) {
    reader.skip(entry >>> 16)
    return entry & 0xffff
  }
  // Longer codes, a bit at a time in canonical order.
  let value = 0
  let first = 0
  let index = 0
  for (let length = 1; length < 16; length++) {
    value |= (bits >>> (length - 1)) & 1
    const count = code.counts[length]!
    if (value - first < count) {
      reader.skip(length)
      return code.symbols[index + value - first]!
    }
    index += count
    first = (first + count) << 1
    value <<= 1
  }
  throw new DecodeError('WebP lossless data has an invalid prefix code')
}

function readPrefixCode(reader: LsbReader, alphabet: number): PrefixCode {
  const lengths = new Uint8Array(alphabet)
  if (reader.bits(1) === 1) {
    // Simple code: one or two symbols.
    const count = reader.bits(1) + 1
    const first = reader.bits(reader.bits(1) === 0 ? 1 : 8)
    if (first >= alphabet) throw new DecodeError('WebP prefix code symbol is out of range')
    lengths[first] = 1
    if (count === 2) {
      const second = reader.bits(8)
      if (second >= alphabet) throw new DecodeError('WebP prefix code symbol is out of range')
      lengths[second] = 1
    }
    return buildPrefixCode(lengths)
  }

  const codeLengthLengths = new Uint8Array(19)
  const count = reader.bits(4) + 4
  if (count > 19) throw new DecodeError('WebP has too many code length codes')
  for (let i = 0; i < count; i++) codeLengthLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3)
  const codeLengthCode = buildPrefixCode(codeLengthLengths)

  let maxSymbol = alphabet
  if (reader.bits(1) === 1) {
    const lengthBits = 2 + 2 * reader.bits(3)
    maxSymbol = 2 + reader.bits(lengthBits)
    if (maxSymbol > alphabet) throw new DecodeError('WebP prefix code is longer than its alphabet')
  }
  let previous = 8
  for (let symbol = 0; symbol < alphabet; ) {
    if (maxSymbol-- === 0) break
    const length = readSymbol(reader, codeLengthCode)
    if (length < 16) {
      lengths[symbol++] = length
      if (length !== 0) previous = length
      continue
    }
    const repeat = length === 16 ? 3 + reader.bits(2) : length === 17 ? 3 + reader.bits(3) : 11 + reader.bits(7)
    if (symbol + repeat > alphabet) throw new DecodeError('WebP code lengths overflow')
    lengths.fill(length === 16 ? previous : 0, symbol, symbol + repeat)
    symbol += repeat
  }
  return buildPrefixCode(lengths)
}

type Group = [PrefixCode, PrefixCode, PrefixCode, PrefixCode, PrefixCode]

function readGroup(reader: LsbReader, cacheBits: number): Group {
  const green = readPrefixCode(reader, 256 + 24 + (cacheBits > 0 ? 1 << cacheBits : 0))
  return [
    green,
    readPrefixCode(reader, 256),
    readPrefixCode(reader, 256),
    readPrefixCode(reader, 256),
    readPrefixCode(reader, 40),
  ]
}

/** LZ77 lengths and distances: a prefix symbol plus extra bits. */
function prefixValue(reader: LsbReader, symbol: number): number {
  if (symbol < 4) return symbol + 1
  const extra = (symbol - 2) >> 1
  const offset = (2 + (symbol & 1)) << extra
  return offset + reader.bits(extra) + 1
}

function subSample(size: number, bits: number): number {
  return (size + (1 << bits) - 1) >> bits
}

type Transform =
  | { type: 0 | 1; width: number; height: number; bits: number; data: Uint32Array }
  | { type: 2; width: number; height: number }
  | { type: 3; width: number; height: number; bits: number; palette: Uint32Array }

function addPixels(a: number, b: number): number {
  return (
    ((((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00) | (((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff)) >>> 0
  )
}

function average2(a: number, b: number): number {
  return ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

function select(top: number, left: number, topLeft: number): number {
  let leftDistance = 0
  for (let shift = 0; shift < 32; shift += 8) {
    const t = (top >>> shift) & 0xff
    const l = (left >>> shift) & 0xff
    const tl = (topLeft >>> shift) & 0xff
    leftDistance += Math.abs(l - tl) - Math.abs(t - tl)
  }
  return leftDistance <= 0 ? top : left
}

function clampAddSubtractFull(a: number, b: number, c: number): number {
  let out = 0
  for (let shift = 24; shift >= 0; shift -= 8) {
    out = (out << 8) | clampByte(((a >>> shift) & 0xff) + ((b >>> shift) & 0xff) - ((c >>> shift) & 0xff))
  }
  return out >>> 0
}

function clampAddSubtractHalf(a: number, b: number): number {
  let out = 0
  for (let shift = 24; shift >= 0; shift -= 8) {
    const x = (a >>> shift) & 0xff
    const y = (b >>> shift) & 0xff
    out = (out << 8) | clampByte(x + Math.trunc((x - y) / 2))
  }
  return out >>> 0
}

function predict(mode: number, left: number, top: number, topLeft: number, topRight: number): number {
  switch (mode) {
    case 1:
      return left
    case 2:
      return top
    case 3:
      return topRight
    case 4:
      return topLeft
    case 5:
      return average2(average2(left, topRight), top)
    case 6:
      return average2(left, topLeft)
    case 7:
      return average2(left, top)
    case 8:
      return average2(topLeft, top)
    case 9:
      return average2(top, topRight)
    case 10:
      return average2(average2(left, topLeft), average2(top, topRight))
    case 11:
      return select(top, left, topLeft)
    case 12:
      return clampAddSubtractFull(left, top, topLeft)
    case 13:
      return clampAddSubtractHalf(average2(left, top), topLeft)
    default:
      return 0xff000000
  }
}

function inversePredictor(
  t: { width: number; height: number; bits: number; data: Uint32Array },
  pixels: Uint32Array,
): void {
  const { width, height, bits, data } = t
  const tiles = subSample(width, bits)
  pixels[0] = addPixels(pixels[0]!, 0xff000000)
  for (let x = 1; x < width; x++) pixels[x] = addPixels(pixels[x]!, pixels[x - 1]!)
  for (let y = 1; y < height; y++) {
    const row = y * width
    pixels[row] = addPixels(pixels[row]!, pixels[row - width]!)
    const tileRow = (y >> bits) * tiles
    for (let x = 1; x < width; x++) {
      const at = row + x
      const mode = (data[tileRow + (x >> bits)]! >>> 8) & 15
      const predicted = predict(
        mode,
        pixels[at - 1]!,
        pixels[at - width]!,
        pixels[at - width - 1]!,
        pixels[at - width + 1]!,
      )
      pixels[at] = addPixels(pixels[at]!, predicted)
    }
  }
}

const int8 = (value: number) => (value << 24) >> 24

function inverseColor(
  t: { width: number; height: number; bits: number; data: Uint32Array },
  pixels: Uint32Array,
): void {
  const { width, height, bits, data } = t
  const tiles = subSample(width, bits)
  for (let y = 0; y < height; y++) {
    const tileRow = (y >> bits) * tiles
    for (let x = 0; x < width; x++) {
      const element = data[tileRow + (x >> bits)]!
      const greenToRed = int8(element & 0xff)
      const greenToBlue = int8((element >>> 8) & 0xff)
      const redToBlue = int8((element >>> 16) & 0xff)
      const at = y * width + x
      const argb = pixels[at]!
      const green = int8((argb >>> 8) & 0xff)
      let red = (argb >>> 16) & 0xff
      let blue = argb & 0xff
      red = (red + ((greenToRed * green) >> 5)) & 0xff
      blue = (blue + ((greenToBlue * green) >> 5)) & 0xff
      blue = (blue + ((redToBlue * int8(red)) >> 5)) & 0xff
      pixels[at] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0
    }
  }
}

function inverseSubtractGreen(pixels: Uint32Array): void {
  for (let i = 0; i < pixels.length; i++) {
    const argb = pixels[i]!
    const green = (argb >>> 8) & 0xff
    const red = (((argb >>> 16) & 0xff) + green) & 0xff
    const blue = ((argb & 0xff) + green) & 0xff
    pixels[i] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0
  }
}

function inverseColorIndexing(
  t: { width: number; height: number; bits: number; palette: Uint32Array },
  pixels: Uint32Array,
): Uint32Array {
  const { width, height, bits, palette } = t
  const out = new Uint32Array(width * height)
  if (bits === 0) {
    for (let i = 0; i < out.length; i++) out[i] = palette[(pixels[i]! >>> 8) & 0xff] ?? 0
    return out
  }
  const packedWidth = subSample(width, bits)
  const perPixel = 8 >> bits
  const mask = (1 << perPixel) - 1
  const within = (1 << bits) - 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const packed = (pixels[y * packedWidth + (x >> bits)]! >>> 8) & 0xff
      out[y * width + x] = palette[(packed >> ((x & within) * perPixel)) & mask] ?? 0
    }
  }
  return out
}

function decodePixels(
  reader: LsbReader,
  width: number,
  height: number,
  cacheBits: number,
  groups: Group[],
  meta: { image: Uint32Array; bits: number; width: number } | null,
): Uint32Array {
  const total = width * height
  const out = new Uint32Array(total)
  const cache = cacheBits > 0 ? new Uint32Array(1 << cacheBits) : null
  const cacheShift = 32 - cacheBits
  let cached = 0
  const insertUpTo = (end: number) => {
    for (; cached < end; cached++) {
      const argb = out[cached]!
      cache![Math.imul(argb, 0x1e35a7bd) >>> cacheShift] = argb
    }
  }
  const mask = meta === null ? 0 : (1 << meta.bits) - 1
  const groupAt = (x: number, y: number): Group =>
    groups[(meta!.image[(y >> meta!.bits) * meta!.width + (x >> meta!.bits)]! >>> 8) & 0xffff]!
  let group = groups[0]!
  let x = 0
  let y = 0
  let at = 0
  while (at < total) {
    if (meta !== null && (x & mask) === 0) group = groupAt(x, y)
    const green = readSymbol(reader, group[0])
    if (green < 256) {
      const red = readSymbol(reader, group[1])
      const blue = readSymbol(reader, group[2])
      const alpha = readSymbol(reader, group[3])
      out[at++] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0
      if (++x >= width) {
        x = 0
        y++
      }
    } else if (green < 256 + 24) {
      const length = prefixValue(reader, green - 256)
      const code = prefixValue(reader, readSymbol(reader, group[4]))
      let distance: number
      if (code > 120) distance = code - 120
      else {
        const planeCode = DISTANCE_MAP[code - 1]!
        distance = Math.max(1, (planeCode >> 4) * width + 8 - (planeCode & 15))
      }
      if (distance > at || at + length > total) throw new DecodeError('WebP lossless copy reaches outside the picture')
      for (let i = 0; i < length; i++, at++) out[at] = out[at - distance]!
      x += length
      while (x >= width) {
        x -= width
        y++
      }
      if (meta !== null && at < total && (x & mask) !== 0) group = groupAt(x, y)
      if (cache !== null) insertUpTo(at)
    } else {
      if (cache === null) throw new DecodeError('WebP lossless data uses a color cache it did not declare')
      insertUpTo(at)
      out[at++] = cache[green - 280]!
      if (++x >= width) {
        x = 0
        y++
      }
    }
  }
  return out
}

/** One image stream of VP8L: the main picture (with transforms) or a sub-image (without). */
function decodeImageStream(reader: LsbReader, width: number, height: number, isMain: boolean): Uint32Array {
  const transforms: Transform[] = []
  let codedWidth = width
  if (isMain) {
    const seen = new Set<number>()
    while (reader.bits(1) === 1) {
      const type = reader.bits(2) as 0 | 1 | 2 | 3
      if (seen.has(type)) throw new DecodeError('WebP repeats a transform')
      seen.add(type)
      if (type === 0 || type === 1) {
        const bits = reader.bits(3) + 2
        const data = decodeImageStream(reader, subSample(codedWidth, bits), subSample(height, bits), false)
        transforms.push({ type, width: codedWidth, height, bits, data })
      } else if (type === 2) {
        transforms.push({ type, width: codedWidth, height })
      } else {
        const colors = reader.bits(8) + 1
        const bits = colors > 16 ? 0 : colors > 4 ? 1 : colors > 2 ? 2 : 3
        const raw = decodeImageStream(reader, colors, 1, false)
        const palette = new Uint32Array(1 << (8 >> bits))
        for (let i = 0; i < colors && i < palette.length; i++)
          palette[i] = i === 0 ? raw[0]! : addPixels(raw[i]!, palette[i - 1]!)
        transforms.push({ type, width: codedWidth, height, bits, palette })
        codedWidth = subSample(codedWidth, bits)
      }
    }
  }

  let cacheBits = 0
  if (reader.bits(1) === 1) {
    cacheBits = reader.bits(4)
    if (cacheBits < 1 || cacheBits > 11) throw new DecodeError('WebP color cache size is invalid')
  }

  let meta: { image: Uint32Array; bits: number; width: number } | null = null
  let groupCount = 1
  if (isMain && reader.bits(1) === 1) {
    const bits = reader.bits(3) + 2
    const metaWidth = subSample(codedWidth, bits)
    const image = decodeImageStream(reader, metaWidth, subSample(height, bits), false)
    for (const pixel of image) groupCount = Math.max(groupCount, ((pixel >>> 8) & 0xffff) + 1)
    meta = { image, bits, width: metaWidth }
  }
  const groups: Group[] = []
  for (let i = 0; i < groupCount; i++) groups.push(readGroup(reader, cacheBits))

  let pixels = decodePixels(reader, codedWidth, height, cacheBits, groups, meta)
  for (let i = transforms.length - 1; i >= 0; i--) {
    const transform = transforms[i]!
    if (transform.type === 2) inverseSubtractGreen(pixels)
    else if (transform.type === 3) pixels = inverseColorIndexing(transform, pixels)
    else if (transform.type === 0) inversePredictor(transform, pixels)
    else inverseColor(transform, pixels)
  }
  return pixels
}

function decodeLossless(data: Uint8Array, guard: (width: number, height: number) => void): Raw {
  if (data.length < 5 || data[0] !== 0x2f) throw new DecodeError('WebP lossless header is invalid')
  const reader = new LsbReader(data, 1)
  const width = reader.bits(14) + 1
  const height = reader.bits(14) + 1
  reader.bits(1) // alpha hint
  if (reader.bits(3) !== 0) throw new UnsupportedError('WebP lossless version is not 0')
  guard(width, height)
  const argb = decodeImageStream(reader, width, height, true)
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < argb.length; i++) {
    const pixel = argb[i]!
    rgba[i * 4] = (pixel >>> 16) & 0xff
    rgba[i * 4 + 1] = (pixel >>> 8) & 0xff
    rgba[i * 4 + 2] = pixel & 0xff
    rgba[i * 4 + 3] = pixel >>> 24
  }
  return { width, height, rgba }
}

/** The ALPH chunk: raw or VP8L-coded alpha, then the inverse of its prediction filter. */
function decodeAlpha(data: Uint8Array, width: number, height: number): Uint8Array {
  const header = data[0]!
  const method = header & 3
  const filter = (header >> 2) & 3
  let plane: Uint8Array
  if (method === 0) {
    plane = data.slice(1, 1 + width * height)
    if (plane.length < width * height) throw new DecodeError('WebP alpha is truncated')
  } else if (method === 1) {
    const argb = decodeImageStream(new LsbReader(data, 1), width, height, true)
    plane = new Uint8Array(width * height)
    for (let i = 0; i < plane.length; i++) plane[i] = (argb[i]! >>> 8) & 0xff
  } else {
    throw new UnsupportedError('WebP alpha compression method is unknown')
  }
  if (filter === 0) return plane
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const at = row + x
      let predicted: number
      if (y === 0) predicted = x === 0 ? 0 : plane[at - 1]!
      else if (x === 0) predicted = plane[at - width]!
      else if (filter === 1) predicted = plane[at - 1]!
      else if (filter === 2) predicted = plane[at - width]!
      else predicted = clampByte(plane[at - 1]! + plane[at - width]! - plane[at - width - 1]!)
      plane[at] = (plane[at]! + predicted) & 0xff
    }
  }
  return plane
}

// ----------------------------------------------------------------- VP8 lossy

/** The boolean entropy decoder of RFC 6386 section 7. */
class BoolDecoder {
  private value: number
  private range = 255
  private bitCount = 0

  constructor(
    private readonly data: Uint8Array,
    private position: number,
    private readonly end: number,
  ) {
    this.value = (this.next() << 8) | this.next()
  }

  private next(): number {
    return this.position < this.end ? this.data[this.position++]! : 0
  }

  bit(probability: number): number {
    const split = 1 + (((this.range - 1) * probability) >> 8)
    const bigSplit = split << 8
    let bit: number
    if (this.value >= bigSplit) {
      bit = 1
      this.range -= split
      this.value -= bigSplit
    } else {
      bit = 0
      this.range = split
    }
    if (this.range < 128) {
      const shift = Math.clz32(this.range) - 24
      this.range <<= shift
      this.value <<= shift
      this.bitCount += shift
      if (this.bitCount >= 8) {
        this.bitCount -= 8
        this.value |= this.next() << this.bitCount
      }
    }
    return bit
  }

  literal(bits: number): number {
    let value = 0
    while (bits-- > 0) value = (value << 1) | this.bit(128)
    return value
  }

  signed(bits: number): number {
    const value = this.literal(bits)
    return this.bit(128) ? -value : value
  }

  /** An optional field: a flag, then the signed value. */
  optionalSigned(bits: number): number {
    return this.bit(128) ? this.signed(bits) : 0
  }
}

// Intra modes, numbered as the tables are: 16x16 and chroma use the first four.
const DC = 0
const TM = 1
const VE = 2
const HE = 3
const RD = 4
const VR = 5
const LD = 6
const VL = 7
const HD = 8
const HU = 9

type Quant = { y1: [number, number]; y2: [number, number]; uv: [number, number] }
type FilterStrength = { limit: number; inner: number; hevThreshold: number }

const Y_STRIDE = 32 // work buffer: left column, 16 pixels, 4 top-right pixels
const UV_STRIDE = 16

function clip(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value
}

const mul1 = (a: number) => Math.floor((a * 20091) / 65536) + a
const mul2 = (a: number) => Math.floor((a * 35468) / 65536)

const transformScratch = new Int32Array(16)

/** Inverse DCT of one 4x4 block, added to the prediction at `at` (RFC 6386 section 14.4). */
function addTransform(coeffs: Int32Array, offset: number, buffer: Uint8Array, at: number, stride: number): void {
  let hasAc = false
  for (let i = 1; i < 16; i++) {
    if (coeffs[offset + i] !== 0) {
      hasAc = true
      break
    }
  }
  if (!hasAc) {
    // Only the DC: the same value lands on all 16 pixels.
    const dc = coeffs[offset]!
    if (dc === 0) return
    const add = (dc + 4) >> 3
    for (let y = 0; y < 4; y++) {
      const row = at + y * stride
      for (let x = 0; x < 4; x++) buffer[row + x] = clip(buffer[row + x]! + add, 255)
    }
    return
  }
  const temp = transformScratch
  for (let i = 0; i < 4; i++) {
    const i0 = coeffs[offset + i]!
    const i4 = coeffs[offset + 4 + i]!
    const i8 = coeffs[offset + 8 + i]!
    const i12 = coeffs[offset + 12 + i]!
    const a = i0 + i8
    const b = i0 - i8
    const c = mul2(i4) - mul1(i12)
    const d = mul1(i4) + mul2(i12)
    temp[i * 4] = a + d
    temp[i * 4 + 1] = b + c
    temp[i * 4 + 2] = b - c
    temp[i * 4 + 3] = a - d
  }
  for (let i = 0; i < 4; i++) {
    const dc = temp[i]! + 4
    const a = dc + temp[8 + i]!
    const b = dc - temp[8 + i]!
    const c = mul2(temp[4 + i]!) - mul1(temp[12 + i]!)
    const d = mul1(temp[4 + i]!) + mul2(temp[12 + i]!)
    const row = at + i * stride
    buffer[row] = clip(buffer[row]! + ((a + d) >> 3), 255)
    buffer[row + 1] = clip(buffer[row + 1]! + ((b + c) >> 3), 255)
    buffer[row + 2] = clip(buffer[row + 2]! + ((b - c) >> 3), 255)
    buffer[row + 3] = clip(buffer[row + 3]! + ((a - d) >> 3), 255)
  }
}

/** Inverse Walsh-Hadamard transform of the Y2 block into the DCs of the 16 luma blocks. */
function inverseWht(input: Int32Array, coeffs: Int32Array): void {
  const temp = new Int32Array(16)
  for (let i = 0; i < 4; i++) {
    const a0 = input[i]! + input[12 + i]!
    const a1 = input[4 + i]! + input[8 + i]!
    const a2 = input[4 + i]! - input[8 + i]!
    const a3 = input[i]! - input[12 + i]!
    temp[i] = a0 + a1
    temp[8 + i] = a0 - a1
    temp[4 + i] = a3 + a2
    temp[12 + i] = a3 - a2
  }
  for (let i = 0; i < 4; i++) {
    const dc = temp[i * 4]! + 3
    const a0 = dc + temp[i * 4 + 3]!
    const a1 = temp[i * 4 + 1]! + temp[i * 4 + 2]!
    const a2 = temp[i * 4 + 1]! - temp[i * 4 + 2]!
    const a3 = dc - temp[i * 4 + 3]!
    coeffs[i * 4 * 16] = (a0 + a1) >> 3
    coeffs[(i * 4 + 1) * 16] = (a3 + a2) >> 3
    coeffs[(i * 4 + 2) * 16] = (a0 - a1) >> 3
    coeffs[(i * 4 + 3) * 16] = (a3 - a2) >> 3
  }
}

function largeValue(br: BoolDecoder, probs: Uint8Array, p: number): number {
  if (!br.bit(probs[p + 3]!)) {
    return br.bit(probs[p + 4]!) ? 3 + br.bit(probs[p + 5]!) : 2
  }
  if (!br.bit(probs[p + 6]!)) {
    if (!br.bit(probs[p + 7]!)) return 5 + br.bit(159)
    return 7 + 2 * br.bit(165) + br.bit(145)
  }
  const bit1 = br.bit(probs[p + 8]!)
  const bit0 = br.bit(probs[p + 9 + bit1]!)
  const category = 2 * bit1 + bit0
  let value = 0
  const table = CAT_PROBS[category]!
  for (let i = 0; table[i] !== 0; i++) value = value + value + br.bit(table[i]!)
  return value + 3 + (8 << category)
}

/** Decodes one block's tokens from position `n` (RFC 6386 section 13); returns where they ended. */
function readCoefficients(
  br: BoolDecoder,
  probs: Uint8Array,
  type: number,
  context: number,
  dcFactor: number,
  acFactor: number,
  start: number,
  out: Int32Array,
  offset: number,
): number {
  let n = start
  let p = ((type * 8 + BANDS[n]!) * 3 + context) * 11
  for (; n < 16; n++) {
    if (!br.bit(probs[p]!)) return n
    while (!br.bit(probs[p + 1]!)) {
      if (++n === 16) return 16
      p = (type * 8 + BANDS[n]!) * 3 * 11
    }
    const nextBand = (type * 8 + BANDS[n + 1]!) * 3
    let value: number
    if (!br.bit(probs[p + 2]!)) {
      value = 1
      p = (nextBand + 1) * 11
    } else {
      value = largeValue(br, probs, p)
      p = (nextBand + 2) * 11
    }
    if (br.bit(128)) value = -value
    out[offset + ZIGZAG[n]!] = value * (n > 0 ? acFactor : dcFactor)
  }
  return 16
}

// 4x4 intra predictions over the work buffer; `at` is the block's top-left pixel.
const avg3 = (a: number, b: number, c: number) => (a + 2 * b + c + 2) >> 2
const avg2 = (a: number, b: number) => (a + b + 1) >> 1

function predict4(mode: number, buf: Uint8Array, at: number, s: number): void {
  const top = at - s
  const A = buf[top]!
  const B = buf[top + 1]!
  const C = buf[top + 2]!
  const D = buf[top + 3]!
  const E = buf[top + 4]!
  const F = buf[top + 5]!
  const G = buf[top + 6]!
  const H = buf[top + 7]!
  const X = buf[top - 1]!
  const I = buf[at - 1]!
  const J = buf[at - 1 + s]!
  const K = buf[at - 1 + 2 * s]!
  const L = buf[at - 1 + 3 * s]!
  switch (mode) {
    case DC: {
      const dc = (A + B + C + D + I + J + K + L + 4) >> 3
      for (let y = 0; y < 4; y++) buf.fill(dc, at + y * s, at + y * s + 4)
      return
    }
    case TM: {
      for (let y = 0; y < 4; y++) {
        const left = buf[at - 1 + y * s]!
        for (let x = 0; x < 4; x++) buf[at + y * s + x] = clip(left + buf[top + x]! - X, 255)
      }
      return
    }
    case VE: {
      const values = [avg3(X, A, B), avg3(A, B, C), avg3(B, C, D), avg3(C, D, E)]
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) buf[at + y * s + x] = values[x]!
      return
    }
    case HE: {
      const values = [avg3(X, I, J), avg3(I, J, K), avg3(J, K, L), avg3(K, L, L)]
      for (let y = 0; y < 4; y++) buf.fill(values[y]!, at + y * s, at + y * s + 4)
      return
    }
    case RD:
      buf[at + 3 * s + 0] = avg3(J, K, L)
      buf[at + 3 * s + 1] = avg3(I, J, K)
      buf[at + 2 * s + 0] = avg3(I, J, K)
      buf[at + 3 * s + 2] = avg3(X, I, J)
      buf[at + 2 * s + 1] = avg3(X, I, J)
      buf[at + 1 * s + 0] = avg3(X, I, J)
      buf[at + 3 * s + 3] = avg3(A, X, I)
      buf[at + 2 * s + 2] = avg3(A, X, I)
      buf[at + 1 * s + 1] = avg3(A, X, I)
      buf[at + 0 * s + 0] = avg3(A, X, I)
      buf[at + 2 * s + 3] = avg3(B, A, X)
      buf[at + 1 * s + 2] = avg3(B, A, X)
      buf[at + 0 * s + 1] = avg3(B, A, X)
      buf[at + 1 * s + 3] = avg3(C, B, A)
      buf[at + 0 * s + 2] = avg3(C, B, A)
      buf[at + 0 * s + 3] = avg3(D, C, B)
      return
    case LD:
      buf[at + 0 * s + 0] = avg3(A, B, C)
      buf[at + 0 * s + 1] = avg3(B, C, D)
      buf[at + 1 * s + 0] = avg3(B, C, D)
      buf[at + 0 * s + 2] = avg3(C, D, E)
      buf[at + 1 * s + 1] = avg3(C, D, E)
      buf[at + 2 * s + 0] = avg3(C, D, E)
      buf[at + 0 * s + 3] = avg3(D, E, F)
      buf[at + 1 * s + 2] = avg3(D, E, F)
      buf[at + 2 * s + 1] = avg3(D, E, F)
      buf[at + 3 * s + 0] = avg3(D, E, F)
      buf[at + 1 * s + 3] = avg3(E, F, G)
      buf[at + 2 * s + 2] = avg3(E, F, G)
      buf[at + 3 * s + 1] = avg3(E, F, G)
      buf[at + 2 * s + 3] = avg3(F, G, H)
      buf[at + 3 * s + 2] = avg3(F, G, H)
      buf[at + 3 * s + 3] = avg3(G, H, H)
      return
    case VR:
      buf[at + 0 * s + 0] = avg2(X, A)
      buf[at + 2 * s + 1] = avg2(X, A)
      buf[at + 0 * s + 1] = avg2(A, B)
      buf[at + 2 * s + 2] = avg2(A, B)
      buf[at + 0 * s + 2] = avg2(B, C)
      buf[at + 2 * s + 3] = avg2(B, C)
      buf[at + 0 * s + 3] = avg2(C, D)
      buf[at + 3 * s + 0] = avg3(K, J, I)
      buf[at + 2 * s + 0] = avg3(J, I, X)
      buf[at + 1 * s + 0] = avg3(I, X, A)
      buf[at + 3 * s + 1] = avg3(I, X, A)
      buf[at + 1 * s + 1] = avg3(X, A, B)
      buf[at + 3 * s + 2] = avg3(X, A, B)
      buf[at + 1 * s + 2] = avg3(A, B, C)
      buf[at + 3 * s + 3] = avg3(A, B, C)
      buf[at + 1 * s + 3] = avg3(B, C, D)
      return
    case VL:
      buf[at + 0 * s + 0] = avg2(A, B)
      buf[at + 0 * s + 1] = avg2(B, C)
      buf[at + 2 * s + 0] = avg2(B, C)
      buf[at + 0 * s + 2] = avg2(C, D)
      buf[at + 2 * s + 1] = avg2(C, D)
      buf[at + 0 * s + 3] = avg2(D, E)
      buf[at + 2 * s + 2] = avg2(D, E)
      buf[at + 1 * s + 0] = avg3(A, B, C)
      buf[at + 1 * s + 1] = avg3(B, C, D)
      buf[at + 3 * s + 0] = avg3(B, C, D)
      buf[at + 1 * s + 2] = avg3(C, D, E)
      buf[at + 3 * s + 1] = avg3(C, D, E)
      buf[at + 1 * s + 3] = avg3(D, E, F)
      buf[at + 3 * s + 2] = avg3(D, E, F)
      buf[at + 2 * s + 3] = avg3(E, F, G)
      buf[at + 3 * s + 3] = avg3(F, G, H)
      return
    case HD:
      buf[at + 0 * s + 0] = avg2(I, X)
      buf[at + 1 * s + 2] = avg2(I, X)
      buf[at + 1 * s + 0] = avg2(J, I)
      buf[at + 2 * s + 2] = avg2(J, I)
      buf[at + 2 * s + 0] = avg2(K, J)
      buf[at + 3 * s + 2] = avg2(K, J)
      buf[at + 3 * s + 0] = avg2(L, K)
      buf[at + 0 * s + 3] = avg3(A, B, C)
      buf[at + 0 * s + 2] = avg3(X, A, B)
      buf[at + 0 * s + 1] = avg3(I, X, A)
      buf[at + 1 * s + 3] = avg3(I, X, A)
      buf[at + 1 * s + 1] = avg3(J, I, X)
      buf[at + 2 * s + 3] = avg3(J, I, X)
      buf[at + 2 * s + 1] = avg3(K, J, I)
      buf[at + 3 * s + 3] = avg3(K, J, I)
      buf[at + 3 * s + 1] = avg3(L, K, J)
      return
    default: // HU
      buf[at + 0 * s + 0] = avg2(I, J)
      buf[at + 0 * s + 2] = avg2(J, K)
      buf[at + 1 * s + 0] = avg2(J, K)
      buf[at + 1 * s + 2] = avg2(K, L)
      buf[at + 2 * s + 0] = avg2(K, L)
      buf[at + 0 * s + 1] = avg3(I, J, K)
      buf[at + 0 * s + 3] = avg3(J, K, L)
      buf[at + 1 * s + 1] = avg3(J, K, L)
      buf[at + 1 * s + 3] = avg3(K, L, L)
      buf[at + 2 * s + 1] = avg3(K, L, L)
      buf[at + 2 * s + 3] = L
      buf[at + 2 * s + 2] = L
      buf[at + 3 * s + 0] = L
      buf[at + 3 * s + 1] = L
      buf[at + 3 * s + 2] = L
      buf[at + 3 * s + 3] = L
  }
}

/** 16x16 luma or 8x8 chroma prediction; DC falls back at the frame's top and left edges. */
function predictBlock(
  mode: number,
  buf: Uint8Array,
  at: number,
  s: number,
  size: number,
  hasTop: boolean,
  hasLeft: boolean,
): void {
  const top = at - s
  if (mode === DC) {
    let sum = 0
    let count = 0
    if (hasTop) for (let x = 0; x < size; x++, count++) sum += buf[top + x]!
    if (hasLeft) for (let y = 0; y < size; y++, count++) sum += buf[at - 1 + y * s]!
    const dc = count === 0 ? 128 : (sum + (count >> 1)) >> Math.log2(count)
    for (let y = 0; y < size; y++) buf.fill(dc, at + y * s, at + y * s + size)
    return
  }
  for (let y = 0; y < size; y++) {
    const row = at + y * s
    const left = buf[row - 1]!
    for (let x = 0; x < size; x++) {
      if (mode === VE) buf[row + x] = buf[top + x]!
      else if (mode === HE) buf[row + x] = left
      else buf[row + x] = clip(left + buf[top + x]! - buf[top - 1]!, 255)
    }
  }
}

// Loop filter (RFC 6386 section 15), on a plane with `step` across the edge and `along` along it.
const sclip1 = (v: number) => (v < -128 ? -128 : v > 127 ? 127 : v)
const sclip2 = (v: number) => (v < -16 ? -16 : v > 15 ? 15 : v)
const clip255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

function filter2(p: Uint8Array, at: number, step: number): void {
  const p1 = p[at - 2 * step]!
  const p0 = p[at - step]!
  const q0 = p[at]!
  const q1 = p[at + step]!
  const a = 3 * (q0 - p0) + sclip1(p1 - q1)
  const a1 = sclip2((a + 4) >> 3)
  const a2 = sclip2((a + 3) >> 3)
  p[at - step] = clip255(p0 + a2)
  p[at] = clip255(q0 - a1)
}

/**
 * Filters `count` positions of one edge (RFC 6386 section 15.3): macroblock
 * edges with the 6-tap filter, inner edges with the 4-tap one, and the 2-tap
 * filter where the edge has high variance.
 */
function filterEdge(
  p: Uint8Array,
  at: number,
  step: number,
  along: number,
  count: number,
  limit: number,
  interior: number,
  hevThreshold: number,
  isMacroblockEdge: boolean,
): void {
  const threshold = 2 * limit + 1
  for (let i = 0; i < count; i++, at += along) {
    const p1 = p[at - 2 * step]!
    const p0 = p[at - step]!
    const q0 = p[at]!
    const q1 = p[at + step]!
    const dp = p0 > q0 ? p0 - q0 : q0 - p0
    const d1 = p1 > q1 ? p1 - q1 : q1 - p1
    if (4 * dp + d1 > threshold) continue
    const p3 = p[at - 4 * step]!
    const p2 = p[at - 3 * step]!
    const q2 = p[at + 2 * step]!
    const q3 = p[at + 3 * step]!
    const pp = p1 > p0 ? p1 - p0 : p0 - p1
    const qq = q1 > q0 ? q1 - q0 : q0 - q1
    if (
      Math.abs(p3 - p2) > interior ||
      Math.abs(p2 - p1) > interior ||
      pp > interior ||
      Math.abs(q3 - q2) > interior ||
      Math.abs(q2 - q1) > interior ||
      qq > interior
    ) {
      continue
    }
    if (pp > hevThreshold || qq > hevThreshold) {
      const a = 3 * (q0 - p0) + sclip1(p1 - q1)
      p[at - step] = clip255(p0 + sclip2((a + 3) >> 3))
      p[at] = clip255(q0 - sclip2((a + 4) >> 3))
    } else if (isMacroblockEdge) {
      const a = sclip1(3 * (q0 - p0) + sclip1(p1 - q1))
      const a1 = (27 * a + 63) >> 7
      const a2 = (18 * a + 63) >> 7
      const a3 = (9 * a + 63) >> 7
      p[at - 3 * step] = clip255(p2 + a3)
      p[at - 2 * step] = clip255(p1 + a2)
      p[at - step] = clip255(p0 + a1)
      p[at] = clip255(q0 - a1)
      p[at + step] = clip255(q1 - a2)
      p[at + 2 * step] = clip255(q2 - a3)
    } else {
      const a = 3 * (q0 - p0)
      const a1 = sclip2((a + 4) >> 3)
      const a2 = sclip2((a + 3) >> 3)
      const a3 = (a1 + 1) >> 1
      p[at - 2 * step] = clip255(p1 + a3)
      p[at - step] = clip255(p0 + a2)
      p[at] = clip255(q0 - a1)
      p[at + step] = clip255(q1 - a3)
    }
  }
}

function simpleEdge(p: Uint8Array, at: number, step: number, along: number, limit: number): void {
  const threshold = 2 * limit + 1
  for (let i = 0; i < 16; i++, at += along) {
    const p1 = p[at - 2 * step]!
    const p0 = p[at - step]!
    const q0 = p[at]!
    const q1 = p[at + step]!
    if (4 * Math.abs(p0 - q0) + Math.abs(p1 - q1) <= threshold) filter2(p, at, step)
  }
}

/**
 * Decodes a VP8 key frame. The loop filter only smooths block edges, so it is
 * left out when `canSkipFilter` says the result is shrunk a lot anyway.
 */
function decodeLossy(
  data: Uint8Array,
  guard: (width: number, height: number) => void,
  forceFilter: boolean,
  canSkipFilter: (width: number, height: number) => boolean,
): Raw {
  if (data.length < 10) throw new DecodeError('WebP lossy data is truncated')
  const tag = le24(data, 0)
  if (tag & 1) throw new UnsupportedError('WebP lossy data is not a key frame')
  const firstPartitionSize = tag >>> 5
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new DecodeError('VP8 start code is missing')
  const width = le16(data, 6) & 0x3fff
  const height = le16(data, 8) & 0x3fff
  if (width === 0 || height === 0) throw new DecodeError('VP8 frame has no pixels')
  guard(width, height)
  const skipFilter = !forceFilter && canSkipFilter(width, height)

  const headerEnd = 10 + firstPartitionSize
  if (headerEnd > data.length) throw new DecodeError('VP8 first partition is truncated')
  const br = new BoolDecoder(data, 10, headerEnd)

  br.bit(128) // color space
  br.bit(128) // clamping type

  // Segments.
  const segmentQuant = [0, 0, 0, 0]
  const segmentFilter = [0, 0, 0, 0]
  const segmentProbs = [255, 255, 255]
  let useSegments = false
  let updateMap = false
  let absoluteDelta = false
  if (br.bit(128)) {
    useSegments = true
    updateMap = br.bit(128) === 1
    if (br.bit(128)) {
      absoluteDelta = br.bit(128) === 1
      for (let s = 0; s < 4; s++) segmentQuant[s] = br.optionalSigned(7)
      for (let s = 0; s < 4; s++) segmentFilter[s] = br.optionalSigned(6)
    }
    if (updateMap) for (let s = 0; s < 3; s++) segmentProbs[s] = br.bit(128) ? br.literal(8) : 255
  }

  // Loop filter.
  const isSimpleFilter = br.bit(128) === 1
  const filterLevel = br.literal(6)
  const sharpness = br.literal(3)
  const refDeltas = [0, 0, 0, 0]
  const modeDeltas = [0, 0, 0, 0]
  const useDeltas = br.bit(128) === 1
  if (useDeltas && br.bit(128)) {
    for (let i = 0; i < 4; i++) if (br.bit(128)) refDeltas[i] = br.signed(6)
    for (let i = 0; i < 4; i++) if (br.bit(128)) modeDeltas[i] = br.signed(6)
  }
  const filterType = filterLevel === 0 ? 0 : isSimpleFilter ? 1 : 2

  // Token partitions.
  const partitionCount = 1 << br.literal(2)
  const sizesAt = headerEnd
  let partitionStart = sizesAt + 3 * (partitionCount - 1)
  if (partitionStart > data.length) throw new DecodeError('VP8 partition table is truncated')
  const partitions: BoolDecoder[] = []
  for (let p = 0; p < partitionCount; p++) {
    const size = p < partitionCount - 1 ? le24(data, sizesAt + p * 3) : data.length - partitionStart
    const end = Math.min(data.length, partitionStart + size)
    partitions.push(new BoolDecoder(data, partitionStart, end))
    partitionStart = end
  }

  // Quantizers.
  const baseQ = br.literal(7)
  const y1Dc = br.optionalSigned(4)
  const y2Dc = br.optionalSigned(4)
  const y2Ac = br.optionalSigned(4)
  const uvDc = br.optionalSigned(4)
  const uvAc = br.optionalSigned(4)
  const quants: Quant[] = []
  for (let s = 0; s < 4; s++) {
    const q = useSegments ? segmentQuant[s]! + (absoluteDelta ? 0 : baseQ) : baseQ
    const y2AcFactor = Math.max(8, (AC_TABLE[clip(q + y2Ac, 127)]! * 101581) >> 16)
    quants.push({
      y1: [DC_TABLE[clip(q + y1Dc, 127)]!, AC_TABLE[clip(q, 127)]!],
      y2: [DC_TABLE[clip(q + y2Dc, 127)]! * 2, y2AcFactor],
      uv: [DC_TABLE[clip(q + uvDc, 117)]!, AC_TABLE[clip(q + uvAc, 127)]!],
    })
  }

  br.bit(128) // refresh entropy probabilities: irrelevant for a single frame
  const probs = COEFF_PROBS.slice()
  for (let i = 0; i < probs.length; i++) if (br.bit(COEFF_UPDATE_PROBS[i]!)) probs[i] = br.literal(8)
  const useSkip = br.bit(128) === 1
  const skipProb = useSkip ? br.literal(8) : 0

  // Filter strengths per segment and per kind (16x16 or 4x4 prediction).
  const strengths: FilterStrength[][] = []
  for (let s = 0; s < 4; s++) {
    let base = filterLevel
    if (useSegments) base = segmentFilter[s]! + (absoluteDelta ? 0 : filterLevel)
    const pair: FilterStrength[] = []
    for (let i4x4 = 0; i4x4 <= 1; i4x4++) {
      let level = base
      if (useDeltas) {
        level += refDeltas[0]!
        if (i4x4) level += modeDeltas[0]!
      }
      level = clip(level, 63)
      if (level === 0) {
        pair.push({ limit: 0, inner: 0, hevThreshold: 0 })
        continue
      }
      let interior = level
      if (sharpness > 0) {
        interior >>= sharpness > 4 ? 2 : 1
        if (interior > 9 - sharpness) interior = 9 - sharpness
      }
      if (interior < 1) interior = 1
      pair.push({ limit: 2 * level + interior, inner: interior, hevThreshold: level >= 40 ? 2 : level >= 15 ? 1 : 0 })
    }
    strengths.push(pair)
  }

  const mbWidth = (width + 15) >> 4
  const mbHeight = (height + 15) >> 4
  const yStride = mbWidth * 16
  const uvStride = mbWidth * 8
  const planeY = new Uint8Array(yStride * mbHeight * 16)
  const planeU = new Uint8Array(uvStride * mbHeight * 8)
  const planeV = new Uint8Array(uvStride * mbHeight * 8)
  const mbSegment = new Uint8Array(mbWidth * mbHeight)
  const mbIs4x4 = new Uint8Array(mbWidth * mbHeight)
  const mbInner = new Uint8Array(mbWidth * mbHeight)

  const topModes = new Uint8Array(mbWidth * 4)
  const leftModes = new Uint8Array(4)
  const topNz = new Uint8Array(mbWidth * 9)
  const leftNz = new Uint8Array(9)
  const modes = new Uint8Array(16)
  const coeffs = new Int32Array(24 * 16)
  const y2 = new Int32Array(16)
  const work = new Uint8Array(Y_STRIDE * 17)
  const workU = new Uint8Array(UV_STRIDE * 9)
  const workV = new Uint8Array(UV_STRIDE * 9)

  for (let mbY = 0; mbY < mbHeight; mbY++) {
    leftModes.fill(DC)
    leftNz.fill(0)
    const tokens = partitions[mbY & (partitionCount - 1)]!
    for (let mbX = 0; mbX < mbWidth; mbX++) {
      const index = mbY * mbWidth + mbX
      // Macroblock header (first partition).
      const segment = updateMap
        ? !br.bit(segmentProbs[0]!)
          ? br.bit(segmentProbs[1]!)
          : 2 + br.bit(segmentProbs[2]!)
        : 0
      const isSkipped = useSkip ? br.bit(skipProb) === 1 : false
      const is4x4 = !br.bit(145)
      let yMode = DC
      if (!is4x4) {
        yMode = br.bit(156) ? (br.bit(128) ? TM : HE) : br.bit(163) ? VE : DC
        topModes.fill(yMode, mbX * 4, mbX * 4 + 4)
        leftModes.fill(yMode)
      } else {
        for (let y = 0; y < 4; y++) {
          let mode = leftModes[y]!
          for (let x = 0; x < 4; x++) {
            const p = (topModes[mbX * 4 + x]! * 10 + mode) * 9
            mode = !br.bit(BMODE_PROBS[p]!)
              ? DC
              : !br.bit(BMODE_PROBS[p + 1]!)
                ? TM
                : !br.bit(BMODE_PROBS[p + 2]!)
                  ? VE
                  : !br.bit(BMODE_PROBS[p + 3]!)
                    ? !br.bit(BMODE_PROBS[p + 4]!)
                      ? HE
                      : !br.bit(BMODE_PROBS[p + 5]!)
                        ? RD
                        : VR
                    : !br.bit(BMODE_PROBS[p + 6]!)
                      ? LD
                      : !br.bit(BMODE_PROBS[p + 7]!)
                        ? VL
                        : !br.bit(BMODE_PROBS[p + 8]!)
                          ? HD
                          : HU
            topModes[mbX * 4 + x] = mode
            modes[y * 4 + x] = mode
          }
          leftModes[y] = mode
        }
      }
      const uvMode = !br.bit(142) ? DC : !br.bit(114) ? VE : br.bit(183) ? TM : HE

      // Residuals (token partition).
      coeffs.fill(0)
      const quant = quants[segment]!
      const top = mbX * 9
      if (!isSkipped) {
        let first = 0
        let acType = 3
        if (!is4x4) {
          y2.fill(0)
          const n = readCoefficients(tokens, probs, 1, topNz[top + 8]! + leftNz[8]!, quant.y2[0], quant.y2[1], 0, y2, 0)
          topNz[top + 8] = leftNz[8] = n > 0 ? 1 : 0
          if (n > 1) inverseWht(y2, coeffs)
          else {
            const dc = (y2[0]! + 3) >> 3
            for (let i = 0; i < 16; i++) coeffs[i * 16] = dc
          }
          first = 1
          acType = 0
        }
        for (let y = 0; y < 4; y++) {
          let left = leftNz[y]!
          for (let x = 0; x < 4; x++) {
            const n = readCoefficients(
              tokens,
              probs,
              acType,
              left + topNz[top + x]!,
              quant.y1[0],
              quant.y1[1],
              first,
              coeffs,
              (y * 4 + x) * 16,
            )
            left = n > first ? 1 : 0
            topNz[top + x] = left
          }
          leftNz[y] = left
        }
        for (let channel = 0; channel < 2; channel++) {
          for (let y = 0; y < 2; y++) {
            let left = leftNz[4 + channel * 2 + y]!
            for (let x = 0; x < 2; x++) {
              const block = 16 + channel * 4 + y * 2 + x
              const n = readCoefficients(
                tokens,
                probs,
                2,
                left + topNz[top + 4 + channel * 2 + x]!,
                quant.uv[0],
                quant.uv[1],
                0,
                coeffs,
                block * 16,
              )
              left = n > 0 ? 1 : 0
              topNz[top + 4 + channel * 2 + x] = left
            }
            leftNz[4 + channel * 2 + y] = left
          }
        }
      } else {
        leftNz.fill(0, 0, 8)
        topNz.fill(0, top, top + 8)
        if (!is4x4) leftNz[8] = topNz[top + 8] = 0
      }
      let hasCoefficients = false
      for (let i = 0; i < coeffs.length; i++) {
        if (coeffs[i] !== 0) {
          hasCoefficients = true
          break
        }
      }
      mbSegment[index] = segment
      mbIs4x4[index] = is4x4 ? 1 : 0
      mbInner[index] = is4x4 || hasCoefficients ? 1 : 0

      // Reconstruction into the work buffers, then into the planes.
      const x0 = mbX * 16
      const y0 = mbY * 16
      // Above row, the left column, and the four pixels above and to the right.
      if (mbY === 0) {
        work.fill(127, 0, 21)
      } else {
        const above = (y0 - 1) * yStride + x0
        work[0] = mbX === 0 ? 129 : planeY[above - 1]!
        work.set(planeY.subarray(above, above + 16), 1)
        if (mbX < mbWidth - 1) work.set(planeY.subarray(above + 16, above + 20), 17)
        else work.fill(planeY[above + 15]!, 17, 21)
      }
      for (let y = 0; y < 16; y++) work[(y + 1) * Y_STRIDE] = mbX === 0 ? 129 : planeY[(y0 + y) * yStride + x0 - 1]!
      for (const [plane, buffer] of [
        [planeU, workU],
        [planeV, workV],
      ] as const) {
        const cx = mbX * 8
        const cy = mbY * 8
        if (mbY === 0) buffer.fill(127, 0, 9)
        else {
          const above = (cy - 1) * uvStride + cx
          buffer[0] = mbX === 0 ? 129 : plane[above - 1]!
          buffer.set(plane.subarray(above, above + 8), 1)
        }
        for (let y = 0; y < 8; y++) buffer[(y + 1) * UV_STRIDE] = mbX === 0 ? 129 : plane[(cy + y) * uvStride + cx - 1]!
      }

      const origin = Y_STRIDE + 1
      if (is4x4) {
        // The top-right pixels repeat beside every fourth row for the right column of blocks.
        for (const row of [4, 8, 12]) work.copyWithin(row * Y_STRIDE + 17, 17, 21)
        for (let block = 0; block < 16; block++) {
          const at = origin + (block >> 2) * 4 * Y_STRIDE + (block & 3) * 4
          predict4(modes[block]!, work, at, Y_STRIDE)
          addTransform(coeffs, block * 16, work, at, Y_STRIDE)
        }
      } else {
        predictBlock(yMode, work, origin, Y_STRIDE, 16, mbY > 0, mbX > 0)
        for (let block = 0; block < 16; block++) {
          const at = origin + (block >> 2) * 4 * Y_STRIDE + (block & 3) * 4
          addTransform(coeffs, block * 16, work, at, Y_STRIDE)
        }
      }
      for (let channel = 0; channel < 2; channel++) {
        const buffer = channel === 0 ? workU : workV
        const at = UV_STRIDE + 1
        predictBlock(uvMode, buffer, at, UV_STRIDE, 8, mbY > 0, mbX > 0)
        for (let block = 0; block < 4; block++) {
          addTransform(
            coeffs,
            (16 + channel * 4 + block) * 16,
            buffer,
            at + (block >> 1) * 4 * UV_STRIDE + (block & 1) * 4,
            UV_STRIDE,
          )
        }
      }
      for (let y = 0; y < 16; y++) {
        planeY.set(work.subarray(origin + y * Y_STRIDE, origin + y * Y_STRIDE + 16), (y0 + y) * yStride + x0)
      }
      for (let y = 0; y < 8; y++) {
        const to = (mbY * 8 + y) * uvStride + mbX * 8
        planeU.set(workU.subarray(UV_STRIDE + 1 + y * UV_STRIDE, UV_STRIDE + 9 + y * UV_STRIDE), to)
        planeV.set(workV.subarray(UV_STRIDE + 1 + y * UV_STRIDE, UV_STRIDE + 9 + y * UV_STRIDE), to)
      }
    }
  }

  // The loop filter runs over finished macroblocks in decoding order; intra
  // prediction used the unfiltered pixels, as the format defines.
  if (filterType > 0 && !skipFilter) {
    for (let mbY = 0; mbY < mbHeight; mbY++) {
      for (let mbX = 0; mbX < mbWidth; mbX++) {
        const index = mbY * mbWidth + mbX
        const strength = strengths[mbSegment[index]!]![mbIs4x4[index]!]!
        if (strength.limit === 0) continue
        const inner = mbInner[index] === 1
        const yAt = mbY * 16 * yStride + mbX * 16
        const { limit, inner: interior, hevThreshold } = strength
        if (filterType === 1) {
          if (mbX > 0) simpleEdge(planeY, yAt, 1, yStride, limit + 4)
          if (inner) for (let k = 4; k < 16; k += 4) simpleEdge(planeY, yAt + k, 1, yStride, limit)
          if (mbY > 0) simpleEdge(planeY, yAt, yStride, 1, limit + 4)
          if (inner) for (let k = 4; k < 16; k += 4) simpleEdge(planeY, yAt + k * yStride, yStride, 1, limit)
          continue
        }
        const uvAt = mbY * 8 * uvStride + mbX * 8
        if (mbX > 0) {
          filterEdge(planeY, yAt, 1, yStride, 16, limit + 4, interior, hevThreshold, true)
          filterEdge(planeU, uvAt, 1, uvStride, 8, limit + 4, interior, hevThreshold, true)
          filterEdge(planeV, uvAt, 1, uvStride, 8, limit + 4, interior, hevThreshold, true)
        }
        if (inner) {
          for (let k = 4; k < 16; k += 4)
            filterEdge(planeY, yAt + k, 1, yStride, 16, limit, interior, hevThreshold, false)
          filterEdge(planeU, uvAt + 4, 1, uvStride, 8, limit, interior, hevThreshold, false)
          filterEdge(planeV, uvAt + 4, 1, uvStride, 8, limit, interior, hevThreshold, false)
        }
        if (mbY > 0) {
          filterEdge(planeY, yAt, yStride, 1, 16, limit + 4, interior, hevThreshold, true)
          filterEdge(planeU, uvAt, uvStride, 1, 8, limit + 4, interior, hevThreshold, true)
          filterEdge(planeV, uvAt, uvStride, 1, 8, limit + 4, interior, hevThreshold, true)
        }
        if (inner) {
          for (let k = 4; k < 16; k += 4) {
            filterEdge(planeY, yAt + k * yStride, yStride, 1, 16, limit, interior, hevThreshold, false)
          }
          filterEdge(planeU, uvAt + 4 * uvStride, uvStride, 1, 8, limit, interior, hevThreshold, false)
          filterEdge(planeV, uvAt + 4 * uvStride, uvStride, 1, 8, limit, interior, hevThreshold, false)
        }
      }
    }
  }

  if (skipFilter) {
    // Shrunk a lot anyway: convert at the chroma's own resolution, a quarter of the pixels.
    const half = yuvToRgbaHalf(planeY, planeU, planeV, yStride, uvStride, width, height)
    return { ...half, fullWidth: width, fullHeight: height }
  }
  return { width, height, rgba: yuvToRgba(planeY, planeU, planeV, yStride, uvStride, width, height) }
}

function yuvPixel(rgba: Uint8Array, at: number, y: number, u: number, v: number): void {
  const luma = (y * 19077) >> 8
  const clip8 = (value: number) => ((value & ~16383) === 0 ? value >> 6 : value < 0 ? 0 : 255)
  rgba[at] = clip8(luma + ((v * 26149) >> 8) - 14234)
  rgba[at + 1] = clip8(luma - ((u * 6419) >> 8) - ((v * 13320) >> 8) + 8708)
  rgba[at + 2] = clip8(luma + ((u * 33050) >> 8) - 17685)
  rgba[at + 3] = 255
}

/** YUV 4:2:0 to RGBA at half size: each pixel is a 2x2 luma average with its chroma sample. */
function yuvToRgbaHalf(
  planeY: Uint8Array,
  planeU: Uint8Array,
  planeV: Uint8Array,
  yStride: number,
  uvStride: number,
  width: number,
  height: number,
): Raw {
  const halfWidth = (width + 1) >> 1
  const halfHeight = (height + 1) >> 1
  const rgba = new Uint8Array(halfWidth * halfHeight * 4)
  for (let y = 0; y < halfHeight; y++) {
    const top = 2 * y * yStride
    const bottom = Math.min(2 * y + 1, height - 1) * yStride
    for (let x = 0; x < halfWidth; x++) {
      const left = 2 * x
      const right = Math.min(2 * x + 1, width - 1)
      const luma =
        (planeY[top + left]! + planeY[top + right]! + planeY[bottom + left]! + planeY[bottom + right]! + 2) >> 2
      yuvPixel(rgba, (y * halfWidth + x) * 4, luma, planeU[y * uvStride + x]!, planeV[y * uvStride + x]!)
    }
  }
  return { width: halfWidth, height: halfHeight, rgba }
}

/** YUV 4:2:0 to RGBA with chroma interpolated between sample centers (libwebp's "fancy upsampling"). */
function yuvToRgba(
  planeY: Uint8Array,
  planeU: Uint8Array,
  planeV: Uint8Array,
  yStride: number,
  uvStride: number,
  width: number,
  height: number,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const chromaWidth = (width + 1) >> 1
  const chromaHeight = (height + 1) >> 1
  // For each output position: the nearer chroma sample (weight 3/4) and the farther one (1/4).
  const nearX = new Int32Array(width)
  const farX = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    nearX[x] = x >> 1
    farX[x] = clip((x >> 1) + (x & 1 ? 1 : -1), chromaWidth - 1)
  }
  const multHi = (v: number, coefficient: number) => (v * coefficient) >> 8
  const clip8 = (v: number) => ((v & ~16383) === 0 ? v >> 6 : v < 0 ? 0 : 255)
  for (let y = 0; y < height; y++) {
    const nearRow = (y >> 1) * uvStride
    const farRow = clip((y >> 1) + (y & 1 ? 1 : -1), chromaHeight - 1) * uvStride
    for (let x = 0; x < width; x++) {
      const a = nearRow + nearX[x]!
      const b = nearRow + farX[x]!
      const c = farRow + nearX[x]!
      const d = farRow + farX[x]!
      const u = (9 * planeU[a]! + 3 * planeU[b]! + 3 * planeU[c]! + planeU[d]! + 8) >> 4
      const v = (9 * planeV[a]! + 3 * planeV[b]! + 3 * planeV[c]! + planeV[d]! + 8) >> 4
      const luma = multHi(planeY[y * yStride + x]!, 19077)
      const at = (y * width + x) * 4
      rgba[at] = clip8(luma + multHi(v, 26149) - 14234)
      rgba[at + 1] = clip8(luma - multHi(u, 6419) - multHi(v, 13320) + 8708)
      rgba[at + 2] = clip8(luma + multHi(u, 33050) - 17685)
      rgba[at + 3] = 255
    }
  }
  return rgba
}
