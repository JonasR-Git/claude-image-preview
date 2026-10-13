// DEFLATE (RFC 1951) with an optional zlib wrapper (RFC 1950), streaming.
//
// The hooks runtime has no zlib, and a decoded screenshot can be tens of
// megabytes, so the output is handed to a sink in chunks through a 32 KiB
// sliding window: a PNG decoder downsamples rows as they arrive and never holds
// the whole picture.

export class InflateError extends Error {
  override name = 'InflateError'
}

/** Receives decompressed bytes in order; returning `false` stops early. */
export type InflateSink = (chunk: Uint8Array) => boolean | void

const WINDOW = 32768
const MAX_MATCH = 258
const BUFFER = WINDOW * 3

const LENGTH_BASE = Uint16Array.of(
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258,
)
const LENGTH_EXTRA = Uint8Array.of(
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
)
const DISTANCE_BASE = Uint16Array.of(
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577,
)
const DISTANCE_EXTRA = Uint8Array.of(
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
)
// The order code-length code lengths are sent in (RFC 1951 §3.2.7).
const CODE_LENGTH_ORDER = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15)

/**
 * A canonical Huffman code as one lookup table indexed by the next `bits`
 * input bits (least significant first). Each entry is `(length << 16) | symbol`;
 * 0 marks a bit pattern no code starts with.
 */
type HuffmanTable = { entries: Int32Array; bits: number }

function buildTable(lengths: Uint8Array, count: number): HuffmanTable {
  const perLength = new Uint16Array(16)
  let longest = 0
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    perLength[length]!++
    if (length > longest) longest = length
  }
  const bits = Math.max(1, longest)
  const entries = new Int32Array(1 << bits)
  if (longest === 0) return { entries, bits }

  // Over-subscribed code sets cannot be decoded unambiguously.
  let left = 1
  for (let length = 1; length <= 15; length++) {
    left = (left << 1) - perLength[length]!
    if (left < 0) throw new InflateError('over-subscribed Huffman code')
  }

  const next = new Uint16Array(16)
  for (let length = 1, code = 0; length <= 15; length++) {
    code = (code + perLength[length - 1]!) << 1
    next[length] = code
  }
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    // DEFLATE sends codes most significant bit first; the table is indexed by
    // bits as they arrive, so the code is stored bit-reversed.
    let code = next[length]!++
    let reversed = 0
    for (let i = 0; i < length; i++) {
      reversed = (reversed << 1) | (code & 1)
      code >>>= 1
    }
    const entry = (length << 16) | symbol
    for (let at = reversed; at < entries.length; at += 1 << length) entries[at] = entry
  }
  return { entries, bits }
}

let fixedTables: { literals: HuffmanTable; distances: HuffmanTable } | undefined

function fixed(): { literals: HuffmanTable; distances: HuffmanTable } {
  if (fixedTables === undefined) {
    const literals = new Uint8Array(288)
    literals.fill(8, 0, 144)
    literals.fill(9, 144, 256)
    literals.fill(7, 256, 280)
    literals.fill(8, 280, 288)
    const distances = new Uint8Array(30).fill(5)
    fixedTables = { literals: buildTable(literals, 288), distances: buildTable(distances, 30) }
  }
  return fixedTables
}

class Inflater {
  private position = 0
  private buffer = 0
  private count = 0
  // Zero bytes read past the end of the input; a valid stream needs a few at most
  // because a table lookup peeks further than the last code may reach.
  private overrun = 0

  private readonly window = new Uint8Array(BUFFER)
  private at = 0
  private flushed = 0
  private total = 0
  private stopped = false

  constructor(
    private readonly input: Uint8Array,
    private readonly sink: InflateSink,
    private readonly limit: number,
  ) {}

  private fill(bits: number): void {
    while (this.count < bits) {
      if (this.position < this.input.length) {
        this.buffer |= this.input[this.position++]! << this.count
      } else if (++this.overrun > 4) {
        throw new InflateError('compressed data is truncated')
      }
      this.count += 8
    }
  }

  private bits(n: number): number {
    if (n === 0) return 0
    this.fill(n)
    const value = this.buffer & ((1 << n) - 1)
    this.buffer >>>= n
    this.count -= n
    return value
  }

  private symbol(table: HuffmanTable): number {
    this.fill(table.bits)
    const entry = table.entries[this.buffer & ((1 << table.bits) - 1)]!
    const length = entry >>> 16
    if (length === 0) throw new InflateError('invalid Huffman code')
    this.buffer >>>= length
    this.count -= length
    return entry & 0xffff
  }

  /** Hands the unflushed output to the sink and slides the window back. */
  private flush(final: boolean): void {
    if (this.at > this.flushed && !this.stopped) {
      if (this.sink(this.window.subarray(this.flushed, this.at)) === false) this.stopped = true
    }
    if (final) return
    if (this.at > WINDOW) {
      this.window.copyWithin(0, this.at - WINDOW, this.at)
      this.at = WINDOW
    }
    this.flushed = this.at
  }

  private room(): void {
    if (this.at > BUFFER - MAX_MATCH) this.flush(false)
  }

  private literal(byte: number): void {
    this.room()
    this.window[this.at++] = byte
    if (++this.total > this.limit) throw new InflateError('decompressed data exceeds the limit')
  }

  private copy(distance: number, length: number): void {
    if (distance > this.total || distance > WINDOW) throw new InflateError('distance reaches before the start')
    this.room()
    const window = this.window
    let from = this.at - distance
    let to = this.at
    // Overlapping copies repeat the run, so byte by byte is the correct order.
    for (let i = 0; i < length; i++) window[to++] = window[from++]!
    this.at = to
    this.total += length
    if (this.total > this.limit) throw new InflateError('decompressed data exceeds the limit')
  }

  private stored(): void {
    // Drop to a byte boundary; the length fields are whole bytes.
    const skip = this.count & 7
    this.buffer >>>= skip
    this.count -= skip
    const length = this.bits(16)
    const check = this.bits(16)
    if ((length ^ 0xffff) !== check) throw new InflateError('stored block length check failed')
    // Bytes still held in the bit buffer come first.
    let remaining = length
    while (remaining > 0 && this.count >= 8) {
      this.literal(this.bits(8))
      remaining--
    }
    if (this.position + remaining > this.input.length) throw new InflateError('stored block is truncated')
    while (remaining > 0) {
      this.literal(this.input[this.position++]!)
      remaining--
    }
  }

  private dynamicTables(): { literals: HuffmanTable; distances: HuffmanTable } {
    const literalCount = this.bits(5) + 257
    const distanceCount = this.bits(5) + 1
    const codeLengthCount = this.bits(4) + 4
    if (literalCount > 286 || distanceCount > 30) throw new InflateError('too many length or distance codes')

    const codeLengths = new Uint8Array(19)
    for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = this.bits(3)
    const codeLengthTable = buildTable(codeLengths, 19)

    const lengths = new Uint8Array(literalCount + distanceCount)
    for (let i = 0; i < lengths.length; ) {
      const symbol = this.symbol(codeLengthTable)
      if (symbol < 16) {
        lengths[i++] = symbol
        continue
      }
      let repeat: number
      let value = 0
      if (symbol === 16) {
        if (i === 0) throw new InflateError('repeat with no previous length')
        value = lengths[i - 1]!
        repeat = 3 + this.bits(2)
      } else if (symbol === 17) {
        repeat = 3 + this.bits(3)
      } else {
        repeat = 11 + this.bits(7)
      }
      if (i + repeat > lengths.length) throw new InflateError('code lengths overflow')
      lengths.fill(value, i, i + repeat)
      i += repeat
    }
    if (lengths[256] === 0) throw new InflateError('no end-of-block code')
    return {
      literals: buildTable(lengths.subarray(0, literalCount), literalCount),
      distances: buildTable(lengths.subarray(literalCount), distanceCount),
    }
  }

  private compressed(tables: { literals: HuffmanTable; distances: HuffmanTable }): void {
    for (;;) {
      if (this.stopped) return
      const symbol = this.symbol(tables.literals)
      if (symbol < 256) {
        this.literal(symbol)
      } else if (symbol === 256) {
        return
      } else {
        const lengthCode = symbol - 257
        if (lengthCode >= 29) throw new InflateError('invalid length code')
        const length = LENGTH_BASE[lengthCode]! + this.bits(LENGTH_EXTRA[lengthCode]!)
        const distanceCode = this.symbol(tables.distances)
        if (distanceCode >= 30) throw new InflateError('invalid distance code')
        const distance = DISTANCE_BASE[distanceCode]! + this.bits(DISTANCE_EXTRA[distanceCode]!)
        this.copy(distance, length)
      }
    }
  }

  run(zlib: boolean): number {
    if (zlib) {
      if (this.input.length < 2) throw new InflateError('zlib header is missing')
      const cmf = this.input[0]!
      const flags = this.input[1]!
      if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flags) % 31 !== 0) throw new InflateError('not a zlib stream')
      if (flags & 0x20) throw new InflateError('preset dictionaries are not supported')
      this.position = 2
    }
    let last = false
    while (!last && !this.stopped) {
      last = this.bits(1) === 1
      const type = this.bits(2)
      if (type === 0) this.stored()
      else if (type === 1) this.compressed(fixed())
      else if (type === 2) this.compressed(this.dynamicTables())
      else throw new InflateError('invalid block type')
    }
    this.flush(true)
    return this.total
  }
}

/**
 * Inflates `input` into `sink`, chunk by chunk, and returns the byte count.
 * `zlib` expects the two-byte zlib header (PNG's IDAT); the trailing checksum
 * is not verified. Throws InflateError on malformed data or past `limit` bytes.
 */
export function inflate(
  input: Uint8Array,
  sink: InflateSink,
  options: { zlib: boolean; limit?: number } = { zlib: true },
): number {
  return new Inflater(input, sink, options.limit ?? Number.MAX_SAFE_INTEGER).run(options.zlib)
}

/** Inflates into one buffer; for small payloads such as a WebP or PNG chunk. */
export function inflateAll(input: Uint8Array, options: { zlib: boolean; limit?: number } = { zlib: true }): Uint8Array {
  const chunks: Uint8Array[] = []
  const total = inflate(input, chunk => void chunks.push(chunk.slice()), options)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
