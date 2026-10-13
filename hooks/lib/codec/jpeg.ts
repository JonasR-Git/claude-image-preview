// JPEG decoder: baseline, extended and progressive Huffman-coded files with
// 8-bit samples, any chroma subsampling, restart intervals, grayscale, YCbCr,
// RGB, CMYK and YCCK, and the EXIF orientation.
//
// A thumbnail rarely needs every pixel: when the picture is at least eight
// times larger than the target, only the DC coefficient of each 8x8 block is
// kept, which is that block's average color, and the inverse DCT is skipped.
// A progressive file then needs nothing past its DC scans.

import { BoxDownsampler, fitWithin, orient } from './bitmap'
import type { Bitmap } from './bitmap'
import { DecodeError, UnsupportedError } from './errors'

// Position in the 8x8 block (row-major) of the n-th coefficient in zigzag order.
const ZIGZAG = Uint8Array.of(
  0,
  1,
  8,
  16,
  9,
  2,
  3,
  10,
  17,
  24,
  32,
  25,
  18,
  11,
  4,
  5,
  12,
  19,
  26,
  33,
  40,
  48,
  41,
  34,
  27,
  20,
  13,
  6,
  7,
  14,
  21,
  28,
  35,
  42,
  49,
  56,
  57,
  50,
  43,
  36,
  29,
  22,
  15,
  23,
  30,
  37,
  44,
  51,
  58,
  59,
  52,
  45,
  38,
  31,
  39,
  46,
  53,
  60,
  61,
  54,
  47,
  55,
  62,
  63,
)

// Inverse DCT bases for blocks decoded at 8, 4, 2 or 1 pixels a side:
// BASES[n][u * n + x] = C(u) / 2 * cos((2x + 1) u pi / 2n). With n < 8 this is
// the 8-point transform evaluated at the centers of n wider pixels from the
// lowest n frequencies: libjpeg's scaled decoding, for a fraction of the work.
const BASES: Record<number, Float64Array> = {}
for (const n of [1, 2, 4, 8]) {
  const table = new Float64Array(n * n)
  for (let u = 0; u < n; u++) {
    for (let x = 0; x < n; x++) {
      table[u * n + x] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n))
    }
  }
  BASES[n] = table
}

export type JpegInfo = {
  width: number
  height: number
  /** Width and height after the EXIF orientation, as a viewer shows them. */
  displayWidth: number
  displayHeight: number
  orientation: number
  components: number
  isProgressive: boolean
}

export type JpegDecodeOptions = { maxSide: number; maxPixels: number }

type Huffman = {
  /** (length << 8) | symbol for codes of up to 9 bits, indexed by the next 9 bits. */
  fast: Uint16Array
  maxCode: Int32Array
  offset: Int32Array
  symbols: Uint8Array
}

type Component = {
  id: number
  h: number
  v: number
  quantTable: number
  /** Blocks across and down the area the component covers. */
  blocksAcross: number
  blocksDown: number
  /** Blocks across and down including the padding of the last MCUs. */
  storedAcross: number
  storedDown: number
  /** 64 coefficients per block, or one (the DC) in DC-only mode. */
  coefficients: Int16Array
  predictor: number
  dcTable: Huffman | undefined
  acTable: Huffman | undefined
}

type Frame = {
  width: number
  height: number
  isProgressive: boolean
  maxH: number
  maxV: number
  mcusAcross: number
  mcusDown: number
  components: Component[]
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!
}

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const fast = new Uint16Array(512)
  const maxCode = new Int32Array(18).fill(-1)
  const offset = new Int32Array(18)
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!
    offset[length] = k - code
    for (let i = 0; i < count; i++, k++, code++) {
      if (length <= 9) {
        const shift = 9 - length
        const entry = (length << 8) | symbols[k]!
        for (let fill = 0; fill < 1 << shift; fill++) fast[(code << shift) | fill] = entry
      }
    }
    maxCode[length] = count > 0 ? code - 1 : -1
    code <<= 1
  }
  maxCode[17] = 0x7fffffff
  return { fast, maxCode, offset, symbols }
}

/** MSB-first bit reader over entropy-coded data: skips 0xFF00 stuffing and stops at markers. */
class Bits {
  buffer = 0
  count = 0
  hitMarker = false

  constructor(
    readonly data: Uint8Array,
    public position: number,
  ) {}

  private fill(): void {
    while (this.count <= 24) {
      let byte = 0
      if (!this.hitMarker && this.position < this.data.length) {
        byte = this.data[this.position]!
        if (byte === 0xff) {
          const next = this.data[this.position + 1]
          if (next === 0x00) {
            this.position += 2
          } else {
            // A marker: feed zeros from here on and leave it for the parser.
            this.hitMarker = true
            byte = 0
          }
        } else {
          this.position++
        }
      }
      this.buffer = ((this.buffer << 8) | byte) >>> 0
      this.count += 8
    }
  }

  bit(): number {
    if (this.count < 1) this.fill()
    this.count--
    return (this.buffer >>> this.count) & 1
  }

  get(n: number): number {
    if (n === 0) return 0
    if (this.count < n) this.fill()
    this.count -= n
    return (this.buffer >>> this.count) & ((1 << n) - 1)
  }

  /** The next value coded with `n` bits, sign-extended as JPEG's EXTEND does. */
  receive(n: number): number {
    if (n === 0) return 0
    const value = this.get(n)
    return value < 1 << (n - 1) ? value - (1 << n) + 1 : value
  }

  decode(table: Huffman): number {
    if (this.count < 16) this.fill()
    const peek = (this.buffer >>> (this.count - 9)) & 0x1ff
    const entry = table.fast[peek]!
    if (entry !== 0) {
      this.count -= entry >> 8
      return entry & 0xff
    }
    for (let length = 10; length <= 16; length++) {
      const code = (this.buffer >>> (this.count - length)) & ((1 << length) - 1)
      if (code <= table.maxCode[length]!) {
        this.count -= length
        return table.symbols[table.offset[length]! + code]!
      }
    }
    throw new DecodeError('JPEG has an invalid Huffman code')
  }

  /** Drops buffered bits so the next read starts at a byte (after a restart marker). */
  reset(): void {
    this.buffer = 0
    this.count = 0
    this.hitMarker = false
  }
}

function readExifOrientation(segment: Uint8Array): number {
  // "Exif\0\0", then a TIFF header.
  if (segment.length < 14 || String.fromCharCode(...segment.subarray(0, 4)) !== 'Exif') return 1
  const tiff = segment.subarray(6)
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1
  const read16 = (at: number) => (little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!)
  const read32 = (at: number) =>
    little
      ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) >>> 0
      : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!) >>> 0
  const ifd = read32(4)
  if (ifd + 2 > tiff.length) return 1
  const entries = read16(ifd)
  for (let i = 0; i < entries; i++) {
    const at = ifd + 2 + i * 12
    if (at + 12 > tiff.length) break
    if (read16(at) === 0x0112) {
      const value = read16(at + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

const SUPPORTED_FRAMES = new Set([0xc0, 0xc1, 0xc2])
const UNSUPPORTED_FRAMES = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Size, orientation and kind from the markers before the first scan; null when not a JPEG. */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let orientation = 1
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at++
      continue
    }
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const length = u16(bytes, at + 2)
    const body = bytes.subarray(at + 4, at + 2 + length)
    if (marker === 0xe1) orientation = readExifOrientation(body)
    if (SUPPORTED_FRAMES.has(marker) || UNSUPPORTED_FRAMES.has(marker)) {
      if (body.length < 6) return null
      const height = u16(body, 1)
      const width = u16(body, 3)
      const swaps = orientation >= 5
      return {
        width,
        height,
        displayWidth: swaps ? height : width,
        displayHeight: swaps ? width : height,
        orientation,
        components: body[5]!,
        isProgressive: marker === 0xc2,
      }
    }
    if (marker === 0xda || marker === 0xd9) return null
    at += 2 + length
  }
  return null
}

type Axis = { first: Int32Array; second: Int32Array; weight: Float64Array }

/** For each output position, the two plane samples around it and the weight of the second. */
function axis(count: number, factor: number, max: number, valid: number): Axis {
  const first = new Int32Array(count)
  const second = new Int32Array(count)
  const weight = new Float64Array(count)
  const last = Math.max(0, valid - 1)
  for (let o = 0; o < count; o++) {
    if (factor === max) {
      first[o] = second[o] = Math.min(o, last)
      continue
    }
    const position = Math.max(0, ((o + 0.5) * factor) / max - 0.5)
    const low = Math.min(Math.floor(position), last)
    first[o] = low
    second[o] = Math.min(low + 1, last)
    weight[o] = position - Math.floor(position)
  }
  return { first, second, weight }
}

class JpegDecoder {
  private readonly quant: (Uint16Array | undefined)[] = []
  private readonly dcTables: (Huffman | undefined)[] = []
  private readonly acTables: (Huffman | undefined)[] = []
  private frame: Frame | undefined
  private restartInterval = 0
  private adobeTransform = -1
  private orientation = 1
  private eobRun = 0
  /** 1, 2, 4 or 8: how many source pixels each decoded pixel stands for, across and down. */
  private scale = 1

  /** At 1/8 scale only the DC coefficient of each block matters. */
  private get dcOnly(): boolean {
    return this.scale === 8
  }

  constructor(
    private readonly bytes: Uint8Array,
    private readonly options: JpegDecodeOptions,
  ) {}

  decode(): { bitmap: Bitmap; width: number; height: number } {
    const bytes = this.bytes
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new DecodeError('not a JPEG file')
    let at = 2
    let scans = 0
    outer: while (at < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1]
      if (marker === undefined) break
      if (marker === 0xff || marker === 0x00) {
        at++
        continue
      }
      at += 2
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (marker === 0xd9) break
      if (at + 2 > bytes.length) break
      const length = u16(bytes, at)
      const body = bytes.subarray(at + 2, Math.min(bytes.length, at + length))
      const next = at + length
      switch (marker) {
        case 0xdb:
          this.readQuantTables(body)
          break
        case 0xc4:
          this.readHuffmanTables(body)
          break
        case 0xdd:
          this.restartInterval = u16(body, 0)
          break
        case 0xe1:
          this.orientation = readExifOrientation(body)
          break
        case 0xee:
          if (body.length >= 12 && String.fromCharCode(...body.subarray(0, 5)) === 'Adobe')
            this.adobeTransform = body[11]!
          break
        case 0xda: {
          if (this.frame === undefined) throw new DecodeError('JPEG scan comes before the frame header')
          // In DC-only mode the AC scans of a progressive file are skipped unread.
          const skip = this.dcOnly && this.isAcScan(body)
          let end = next
          if (!skip) {
            try {
              end = this.decodeScan(body, next)
            } catch (error) {
              // A damaged or cut-off scan keeps the blocks decoded before it.
              if (error instanceof UnsupportedError || scans === 0) throw error
              break outer
            }
          }
          scans++
          at = this.nextMarker(end)
          continue
        }
        default:
          if (SUPPORTED_FRAMES.has(marker)) this.readFrame(body, marker === 0xc2)
          else if (UNSUPPORTED_FRAMES.has(marker)) {
            throw new UnsupportedError('lossless, hierarchical and arithmetic-coded JPEG files are not supported')
          }
      }
      at = next
    }
    if (this.frame === undefined || scans === 0) throw new DecodeError('JPEG has no image data')
    return this.output()
  }

  private isAcScan(body: Uint8Array): boolean {
    const count = body[0]!
    const spectralStart = body[1 + count * 2]!
    return spectralStart > 0
  }

  /** The offset of the next marker other than a restart marker, from `from`. */
  private nextMarker(from: number): number {
    const bytes = this.bytes
    for (let at = from; at + 1 < bytes.length; at++) {
      if (bytes[at] !== 0xff) continue
      const marker = bytes[at + 1]!
      if (marker !== 0x00 && marker !== 0xff && !(marker >= 0xd0 && marker <= 0xd7)) return at
    }
    return bytes.length
  }

  private readQuantTables(body: Uint8Array): void {
    let at = 0
    while (at < body.length) {
      const precision = body[at]! >> 4
      const id = body[at]! & 15
      at++
      const table = new Uint16Array(64)
      for (let i = 0; i < 64; i++) {
        table[ZIGZAG[i]!] = precision === 0 ? body[at + i]! : u16(body, at + i * 2)
      }
      at += precision === 0 ? 64 : 128
      this.quant[id] = table
    }
  }

  private readHuffmanTables(body: Uint8Array): void {
    let at = 0
    while (at + 17 <= body.length) {
      const tableClass = body[at]! >> 4
      const id = body[at]! & 15
      const counts = body.subarray(at + 1, at + 17)
      const total = counts.reduce((sum, n) => sum + n, 0)
      const symbols = body.subarray(at + 17, at + 17 + total)
      at += 17 + total
      const table = buildHuffman(counts, symbols)
      if (tableClass === 0) this.dcTables[id] = table
      else this.acTables[id] = table
    }
  }

  private readFrame(body: Uint8Array, isProgressive: boolean): void {
    if (this.frame !== undefined) throw new UnsupportedError('JPEG has more than one frame')
    if (body[0] !== 8) throw new UnsupportedError(`${body[0]}-bit JPEG samples are not supported`)
    const height = u16(body, 1)
    const width = u16(body, 3)
    if (width === 0 || height === 0) throw new UnsupportedError('JPEG height is defined later (DNL)')
    if (width * height > this.options.maxPixels) {
      throw new DecodeError(`JPEG is ${width}x${height}, more pixels than a preview decodes`)
    }
    const count = body[5]!
    const components: Component[] = []
    let maxH = 1
    let maxV = 1
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 3
      const h = body[at + 1]! >> 4
      const v = body[at + 1]! & 15
      if (h < 1 || h > 4 || v < 1 || v > 4) throw new DecodeError('JPEG sampling factors are invalid')
      maxH = Math.max(maxH, h)
      maxV = Math.max(maxV, v)
      components.push({
        id: body[at]!,
        h,
        v,
        quantTable: body[at + 2]!,
        blocksAcross: 0,
        blocksDown: 0,
        storedAcross: 0,
        storedDown: 0,
        coefficients: new Int16Array(0),
        predictor: 0,
        dcTable: undefined,
        acTable: undefined,
      })
    }
    const mcusAcross = Math.ceil(width / (8 * maxH))
    const mcusDown = Math.ceil(height / (8 * maxV))
    // Decode at the smallest scale that still covers the target; 1/8 keeps only DCs.
    const target = fitWithin({ width, height }, this.options.maxSide)
    this.scale =
      [8, 4, 2].find(s => Math.ceil(width / s) >= target.width && Math.ceil(height / s) >= target.height) ?? 1
    for (const component of components) {
      component.blocksAcross = Math.ceil(Math.ceil((width * component.h) / maxH) / 8)
      component.blocksDown = Math.ceil(Math.ceil((height * component.v) / maxV) / 8)
      component.storedAcross = mcusAcross * component.h
      component.storedDown = mcusDown * component.v
      const blocks = component.storedAcross * component.storedDown
      component.coefficients = new Int16Array(this.dcOnly ? blocks : blocks * 64)
    }
    this.frame = { width, height, isProgressive, maxH, maxV, mcusAcross, mcusDown, components }
  }

  private decodeScan(body: Uint8Array, dataStart: number): number {
    const frame = this.frame!
    const count = body[0]!
    const scanComponents: Component[] = []
    for (let i = 0; i < count; i++) {
      const id = body[1 + i * 2]!
      const tables = body[2 + i * 2]!
      const component = frame.components.find(c => c.id === id)
      if (component === undefined) throw new DecodeError('JPEG scan names an unknown component')
      component.dcTable = this.dcTables[tables >> 4]
      component.acTable = this.acTables[tables & 15]
      scanComponents.push(component)
    }
    const at = 1 + count * 2
    const spectralStart = body[at]!
    const spectralEnd = body[at + 1]!
    const approxHigh = body[at + 2]! >> 4
    const approxLow = body[at + 2]! & 15
    const progressive = frame.isProgressive || spectralStart !== 0 || spectralEnd !== 63 || approxHigh !== 0
    if (progressive) frame.isProgressive = true

    type BlockDecoder = (component: Component, block: number) => void
    let decodeBlock: BlockDecoder
    if (!progressive) decodeBlock = (c, b) => this.decodeBaseline(bits, c, b)
    else if (spectralStart === 0) {
      decodeBlock =
        approxHigh === 0
          ? (c, b) => this.decodeDcFirst(bits, c, b, approxLow)
          : (c, b) => this.decodeDcRefine(bits, c, b, approxLow)
    } else {
      decodeBlock =
        approxHigh === 0
          ? (c, b) => this.decodeAcFirst(bits, c, b, spectralStart, spectralEnd, approxLow)
          : (c, b) => this.decodeAcRefine(bits, c, b, spectralStart, spectralEnd, approxLow)
    }

    const bits = new Bits(this.bytes, dataStart)
    for (const component of scanComponents) component.predictor = 0
    this.eobRun = 0

    const single = scanComponents.length === 1
    const first = scanComponents[0]!
    const units = single ? first.blocksAcross * first.blocksDown : frame.mcusAcross * frame.mcusDown
    const interval = this.restartInterval

    for (let unit = 0; unit < units; unit++) {
      if (interval > 0 && unit > 0 && unit % interval === 0) {
        this.restart(bits)
        for (const component of scanComponents) component.predictor = 0
        this.eobRun = 0
      }
      if (single) {
        const row = Math.floor(unit / first.blocksAcross)
        const column = unit % first.blocksAcross
        decodeBlock(first, row * first.storedAcross + column)
      } else {
        const mcuRow = Math.floor(unit / frame.mcusAcross)
        const mcuColumn = unit % frame.mcusAcross
        for (const component of scanComponents) {
          for (let v = 0; v < component.v; v++) {
            for (let h = 0; h < component.h; h++) {
              const row = mcuRow * component.v + v
              const column = mcuColumn * component.h + h
              decodeBlock(component, row * component.storedAcross + column)
            }
          }
        }
      }
    }
    return bits.position
  }

  /** Moves past the restart marker that ends an interval, wherever the bits stopped. */
  private restart(bits: Bits): void {
    const bytes = this.bytes
    let at = bits.position
    while (at + 1 < bytes.length) {
      if (bytes[at] === 0xff) {
        const marker = bytes[at + 1]!
        if (marker >= 0xd0 && marker <= 0xd7) {
          at += 2
          break
        }
        // Another marker: the interval was cut short; leave it for the parser.
        if (marker !== 0x00 && marker !== 0xff) break
      }
      at++
    }
    bits.position = at
    bits.reset()
  }

  private table(table: Huffman | undefined): Huffman {
    if (table === undefined) throw new DecodeError('JPEG scan uses a Huffman table that was not defined')
    return table
  }

  private decodeBaseline(bits: Bits, component: Component, block: number): void {
    const dc = this.table(component.dcTable)
    const ac = this.table(component.acTable)
    const coefficients = component.coefficients
    const t = bits.decode(dc)
    component.predictor += bits.receive(t)
    if (this.dcOnly) {
      coefficients[block] = component.predictor
      // The AC codes still have to be read to reach the next block.
      for (let k = 1; k < 64; ) {
        const rs = bits.decode(ac)
        const size = rs & 15
        const run = rs >> 4
        if (size === 0) {
          if (run < 15) break
          k += 16
          continue
        }
        bits.get(size)
        k += run + 1
      }
      return
    }
    const base = block * 64
    coefficients[base] = component.predictor
    for (let k = 1; k < 64; ) {
      const rs = bits.decode(ac)
      const size = rs & 15
      const run = rs >> 4
      if (size === 0) {
        if (run < 15) break
        k += 16
        continue
      }
      k += run
      if (k > 63) break
      coefficients[base + ZIGZAG[k]!] = bits.receive(size)
      k++
    }
  }

  private decodeDcFirst(bits: Bits, component: Component, block: number, low: number): void {
    const t = bits.decode(this.table(component.dcTable))
    component.predictor += bits.receive(t)
    component.coefficients[this.dcOnly ? block : block * 64] = component.predictor * (1 << low)
  }

  private decodeDcRefine(bits: Bits, component: Component, block: number, low: number): void {
    if (bits.bit() === 0) return
    const at = this.dcOnly ? block : block * 64
    component.coefficients[at] = component.coefficients[at]! | (1 << low)
  }

  private decodeAcFirst(
    bits: Bits,
    component: Component,
    block: number,
    start: number,
    end: number,
    low: number,
  ): void {
    if (this.eobRun > 0) {
      this.eobRun--
      return
    }
    const ac = this.table(component.acTable)
    const base = block * 64
    const coefficients = component.coefficients
    for (let k = start; k <= end; ) {
      const rs = bits.decode(ac)
      const size = rs & 15
      const run = rs >> 4
      if (size === 0) {
        if (run < 15) {
          this.eobRun = (1 << run) - 1
          if (run > 0) this.eobRun += bits.get(run)
          break
        }
        k += 16
        continue
      }
      k += run
      if (k > 63) break
      coefficients[base + ZIGZAG[k]!] = bits.receive(size) * (1 << low)
      k++
    }
  }

  private decodeAcRefine(
    bits: Bits,
    component: Component,
    block: number,
    start: number,
    end: number,
    low: number,
  ): void {
    const ac = this.table(component.acTable)
    const base = block * 64
    const coefficients = component.coefficients
    const plus = 1 << low
    const minus = -1 << low
    let k = start

    const refine = (at: number): void => {
      if (bits.bit()) {
        const value = coefficients[at]!
        if ((value & plus) === 0) coefficients[at] = value >= 0 ? value + plus : value + minus
      }
    }

    if (this.eobRun === 0) {
      for (; k <= end; k++) {
        const rs = bits.decode(ac)
        let run = rs >> 4
        const size = rs & 15
        let value = 0
        if (size !== 0) {
          value = bits.bit() ? plus : minus
        } else if (run !== 15) {
          this.eobRun = 1 << run
          if (run > 0) this.eobRun += bits.get(run)
          break
        }
        // Step over nonzero coefficients (refining each) and `run` zero ones.
        while (k <= end) {
          const at = base + ZIGZAG[k]!
          if (coefficients[at] !== 0) refine(at)
          else {
            if (run === 0) break
            run--
          }
          k++
        }
        if (value !== 0 && k <= end) coefficients[base + ZIGZAG[k]!] = value
      }
    }
    if (this.eobRun > 0) {
      for (; k <= end; k++) {
        const at = base + ZIGZAG[k]!
        if (coefficients[at] !== 0) refine(at)
      }
      this.eobRun--
    }
  }

  /** Dequantizes and inverse-transforms every block into a sample plane per component, at the decode scale. */
  private planes(): Plane[] {
    const frame = this.frame!
    const n = 8 / this.scale
    const basis = BASES[n]!
    const block = new Float64Array(n * n)
    const temp = new Float64Array(n * n)
    return frame.components.map(component => {
      const quant = this.quant[component.quantTable]
      if (quant === undefined) throw new DecodeError('JPEG uses a quantization table that was not defined')
      const coefficients = component.coefficients
      const width = component.storedAcross * n
      const height = component.storedDown * n
      const data = new Uint8Array(width * height)
      if (this.dcOnly) {
        const q = quant[0]!
        for (let i = 0; i < data.length; i++) data[i] = clampByte((coefficients[i]! * q) / 8 + 128)
        return { data, width, height }
      }
      for (let row = 0; row < component.storedDown; row++) {
        for (let column = 0; column < component.storedAcross; column++) {
          const base = (row * component.storedAcross + column) * 64
          let isFlat = true
          for (let v = 0; v < n; v++) {
            for (let u = 0; u < n; u++) {
              const value = coefficients[base + v * 8 + u]!
              block[v * n + u] = value * quant[v * 8 + u]!
              if (value !== 0 && (u > 0 || v > 0)) isFlat = false
            }
          }
          const origin = row * n * width + column * n
          if (isFlat) {
            const value = clampByte(block[0]! / 8 + 128)
            for (let y = 0; y < n; y++) data.fill(value, origin + y * width, origin + y * width + n)
            continue
          }
          // Rows: temp[v][x] = sum over u of basis[u][x] * F[v][u].
          for (let v = 0; v < n; v++) {
            for (let x = 0; x < n; x++) {
              let sum = 0
              for (let u = 0; u < n; u++) sum += basis[u * n + x]! * block[v * n + u]!
              temp[v * n + x] = sum
            }
          }
          // Columns: f[y][x] = sum over v of basis[v][y] * temp[v][x].
          for (let y = 0; y < n; y++) {
            const line = origin + y * width
            for (let x = 0; x < n; x++) {
              let sum = 0
              for (let v = 0; v < n; v++) sum += basis[v * n + y]! * temp[v * n + x]!
              data[line + x] = clampByte(sum + 128)
            }
          }
        }
      }
      return { data, width, height }
    })
  }

  private colorTransform(): 'gray' | 'rgb' | 'ycc' | 'cmyk' | 'ycck' {
    const components = this.frame!.components
    if (components.length === 3) {
      const isRgb =
        this.adobeTransform === 0 ||
        (components[0]!.id === 0x52 && components[1]!.id === 0x47 && components[2]!.id === 0x42)
      return isRgb ? 'rgb' : 'ycc'
    }
    if (components.length === 4) return this.adobeTransform === 2 ? 'ycck' : 'cmyk'
    return 'gray'
  }

  private output(): { bitmap: Bitmap; width: number; height: number } {
    const frame = this.frame!
    const planes = this.planes()
    const scale = this.scale
    const width = Math.ceil(frame.width / scale)
    const height = Math.ceil(frame.height / scale)
    const components = frame.components
    const count = components.length

    // Subsampled components are interpolated between sample centers (bilinear,
    // as libjpeg's "fancy upsampling" does for 2x), not repeated.
    const columns = components.map(c =>
      axis(width, c.h, frame.maxH, Math.ceil(Math.ceil((frame.width * c.h) / frame.maxH) / scale)),
    )
    const rows = components.map(c =>
      axis(height, c.v, frame.maxV, Math.ceil(Math.ceil((frame.height * c.v) / frame.maxV) / scale)),
    )

    const transform = this.colorTransform()
    // Adobe writes CMYK inverted (255 = no ink).
    const inverted = this.adobeTransform >= 0

    const orientation = this.orientation
    const swaps = orientation >= 5
    const target = fitWithin({ width: swaps ? height : width, height: swaps ? width : height }, this.options.maxSide)
    // Orientation is applied after downsampling, so sample to the unrotated target.
    const sampler = new BoxDownsampler(
      width,
      height,
      swaps ? target.height : target.width,
      swaps ? target.width : target.height,
    )
    const line = new Uint8Array(width * 4)
    const samples = Array.from({ length: count }, () => new Float64Array(width))

    for (let y = 0; y < height; y++) {
      for (let i = 0; i < count; i++) interpolateRow(planes[i]!, columns[i]!, rows[i]!, y, samples[i]!)
      const c0 = samples[0]!
      const c1 = samples[1] ?? c0
      const c2 = samples[2] ?? c0
      const c3 = samples[3] ?? c0
      for (let x = 0; x < width; x++) {
        let r: number
        let g: number
        let b: number
        if (transform === 'gray') {
          r = g = b = c0[x]!
        } else if (transform === 'rgb') {
          r = c0[x]!
          g = c1[x]!
          b = c2[x]!
        } else {
          const luma = c0[x]!
          const cb = c1[x]! - 128
          const cr = c2[x]! - 128
          if (transform === 'cmyk') {
            r = luma
            g = c1[x]!
            b = c2[x]!
          } else {
            r = luma + 1.402 * cr
            g = luma - 0.344136 * cb - 0.714136 * cr
            b = luma + 1.772 * cb
          }
          if (transform !== 'ycc') {
            const k = c3[x]!
            r = clampByte(r)
            g = clampByte(g)
            b = clampByte(b)
            if (inverted) {
              r = (r * k) / 255
              g = (g * k) / 255
              b = (b * k) / 255
            } else {
              r = ((255 - r) * (255 - k)) / 255
              g = ((255 - g) * (255 - k)) / 255
              b = ((255 - b) * (255 - k)) / 255
            }
          }
        }
        const at = x * 4
        line[at] = clampByte(r)
        line[at + 1] = clampByte(g)
        line[at + 2] = clampByte(b)
        line[at + 3] = 255
      }
      sampler.addRow(y, line)
    }
    const bitmap = orient(sampler.result(), orientation)
    return { bitmap, width: swaps ? frame.height : frame.width, height: swaps ? frame.width : frame.height }
  }
}

type Plane = { data: Uint8Array; width: number; height: number }

function clampByte(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
}

/** One output row of a component, interpolated from its plane. */
function interpolateRow(plane: Plane, columns: Axis, rows: Axis, y: number, out: Float64Array): void {
  const data = plane.data
  const top = rows.first[y]! * plane.width
  const bottom = rows.second[y]! * plane.width
  const wy = rows.weight[y]!
  const first = columns.first
  const second = columns.second
  const weight = columns.weight
  for (let x = 0; x < out.length; x++) {
    const left = first[x]!
    const right = second[x]!
    const wx = weight[x]!
    const upper = data[top + left]! + (data[top + right]! - data[top + left]!) * wx
    const lower = data[bottom + left]! + (data[bottom + right]! - data[bottom + left]!) * wx
    out[x] = upper + (lower - upper) * wy
  }
}

/** Decodes a JPEG to RGBA, downsampled to fit `maxSide` and turned upright. */
export function decodeJpeg(
  bytes: Uint8Array,
  options: JpegDecodeOptions,
): { bitmap: Bitmap; width: number; height: number } {
  return new JpegDecoder(bytes, options).decode()
}
