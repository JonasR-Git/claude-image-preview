// GIF decoder: the first frame, drawn on the logical screen, with its
// transparent color and interlacing. An animation previews as its first frame.

import { createBitmap, shrink } from './bitmap'
import type { Bitmap } from './bitmap'
import { DecodeError } from './errors'

export type GifInfo = { width: number; height: number }

export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
}

export function readGifInfo(bytes: Uint8Array): GifInfo | null {
  if (!isGif(bytes) || bytes.length < 10) return null
  return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) }
}

/** Concatenates the data sub-blocks starting at `at`; returns them and the offset after the terminator. */
function subBlocks(bytes: Uint8Array, at: number): { data: Uint8Array; end: number } {
  const parts: Uint8Array[] = []
  let total = 0
  while (at < bytes.length) {
    const size = bytes[at++]!
    if (size === 0) break
    const end = Math.min(bytes.length, at + size)
    parts.push(bytes.subarray(at, end))
    total += end - at
    at = end
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    data.set(part, offset)
    offset += part.length
  }
  return { data, end: at }
}

/** GIF's variable-width LZW, into `count` palette indices; a short stream leaves the rest 0. */
function lzw(data: Uint8Array, minimumCodeSize: number, count: number): Uint8Array {
  if (minimumCodeSize < 2 || minimumCodeSize > 8) throw new DecodeError('GIF code size is invalid')
  const out = new Uint8Array(count)
  const clear = 1 << minimumCodeSize
  const end = clear + 1
  const prefix = new Int16Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)

  let size = minimumCodeSize + 1
  let mask = (1 << size) - 1
  let next = end + 1
  let previous = -1
  let first = 0
  let buffer = 0
  let bits = 0
  let position = 0
  let written = 0

  for (let i = 0; i < clear; i++) suffix[i] = i

  while (written < count) {
    while (bits < size) {
      if (position >= data.length) return out
      buffer |= data[position++]! << bits
      bits += 8
    }
    const code = buffer & mask
    buffer >>>= size
    bits -= size

    if (code === clear) {
      size = minimumCodeSize + 1
      mask = (1 << size) - 1
      next = end + 1
      previous = -1
      continue
    }
    if (code === end) break
    if (previous === -1) {
      if (code >= clear) throw new DecodeError('GIF data starts with an undefined code')
      out[written++] = code
      previous = first = code
      continue
    }

    let top = 0
    let current = code
    if (code >= next) {
      // The KwKwK case: the code being defined right now.
      if (code > next) throw new DecodeError('GIF data has an undefined code')
      stack[top++] = first
      current = previous
    }
    while (current >= clear) {
      stack[top++] = suffix[current]!
      current = prefix[current]!
    }
    first = suffix[current]!
    stack[top++] = first
    while (top > 0 && written < count) out[written++] = stack[--top]!

    if (next < 4096) {
      prefix[next] = previous
      suffix[next] = first
      next++
      if (next > mask && size < 12) {
        size++
        mask = (1 << size) - 1
      }
    }
    previous = code
  }
  return out
}

/** Decodes the first frame of a GIF to RGBA, downsampled to fit `maxSide`. */
export function decodeGif(
  bytes: Uint8Array,
  options: { maxSide: number; maxPixels: number },
): { bitmap: Bitmap; width: number; height: number } {
  const info = readGifInfo(bytes)
  if (info === null) throw new DecodeError('not a GIF file')
  const { width, height } = info
  if (width === 0 || height === 0) throw new DecodeError('GIF has no pixels')
  if (width * height > options.maxPixels)
    throw new DecodeError(`GIF is ${width}x${height}, more pixels than a preview decodes`)

  const packed = bytes[10]!
  let at = 13
  let globalPalette: Uint8Array | null = null
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 7) + 1))
    globalPalette = bytes.subarray(at, at + size)
    at += size
  }

  let transparent = -1
  while (at < bytes.length) {
    const introducer = bytes[at++]!
    if (introducer === 0x3b) break
    if (introducer === 0x21) {
      const label = bytes[at++]!
      if (label === 0xf9 && bytes[at] === 4) {
        const flags = bytes[at + 1]!
        transparent = flags & 1 ? bytes[at + 4]! : -1
      }
      at = subBlocks(bytes, at).end
      continue
    }
    if (introducer !== 0x2c) throw new DecodeError('GIF has an unknown block')

    const left = bytes[at]! | (bytes[at + 1]! << 8)
    const top = bytes[at + 2]! | (bytes[at + 3]! << 8)
    const frameWidth = bytes[at + 4]! | (bytes[at + 5]! << 8)
    const frameHeight = bytes[at + 6]! | (bytes[at + 7]! << 8)
    const flags = bytes[at + 8]!
    at += 9
    // A frame may claim more than the canvas; its pixels are allocated before they are clipped.
    if (frameWidth * frameHeight > options.maxPixels) throw new DecodeError('GIF frame is too large')
    let palette = globalPalette
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1))
      palette = bytes.subarray(at, at + size)
      at += size
    }
    if (palette === null) throw new DecodeError('GIF frame has no color table')
    const minimumCodeSize = bytes[at++]!
    const { data } = subBlocks(bytes, at)
    const indices = lzw(data, minimumCodeSize, frameWidth * frameHeight)

    // Interlaced frames store rows in four passes.
    const rowOrder = new Int32Array(frameHeight)
    if (flags & 0x40) {
      let row = 0
      for (const [start, step] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
      ] as const) {
        for (let y = start; y < frameHeight; y += step) rowOrder[row++] = y
      }
    } else {
      for (let y = 0; y < frameHeight; y++) rowOrder[y] = y
    }

    const canvas = createBitmap(width, height)
    const entries = palette.length / 3
    for (let row = 0; row < frameHeight; row++) {
      const y = top + rowOrder[row]!
      if (y >= height) continue
      for (let x = 0; x < frameWidth; x++) {
        const tx = left + x
        if (tx >= width) break
        const index = indices[row * frameWidth + x]!
        if (index === transparent || index >= entries) continue
        const to = (y * width + tx) * 4
        canvas.data[to] = palette[index * 3]!
        canvas.data[to + 1] = palette[index * 3 + 1]!
        canvas.data[to + 2] = palette[index * 3 + 2]!
        canvas.data[to + 3] = 255
      }
    }
    return { bitmap: shrink(canvas, options.maxSide), width, height }
  }
  throw new DecodeError('GIF has no frames')
}
