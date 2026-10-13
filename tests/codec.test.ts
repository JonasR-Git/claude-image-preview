import { describe, expect, test } from 'claude-code/testing'

import { fromBase64, toBase64 } from '../hooks/lib/codec/base64'
import { BoxDownsampler, fitWithin, orient, shrink } from '../hooks/lib/codec/bitmap'
import type { Bitmap } from '../hooks/lib/codec/bitmap'
import { decodeImage } from '../hooks/lib/codec/decode'
import { inflateAll } from '../hooks/lib/codec/inflate'
import { sniff } from '../hooks/lib/codec/sniff'
import { PILLOW_FIXTURES, PNG_FIXTURES } from './fixtures/images'
import type { Fixture } from './fixtures/images'

/** Mean and worst absolute channel difference, colors compared only where both are visible. */
function difference(actual: Bitmap, expected: Uint8Array): { mean: number; worst: number; alphaWorst: number } {
  let sum = 0
  let count = 0
  let worst = 0
  let alphaWorst = 0
  for (let at = 0; at < expected.length; at += 4) {
    alphaWorst = Math.max(alphaWorst, Math.abs(actual.data[at + 3]! - expected[at + 3]!))
    if (expected[at + 3] === 0 || actual.data[at + 3] === 0) continue
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(actual.data[at + c]! - expected[at + c]!)
      sum += d
      count++
      worst = Math.max(worst, d)
    }
  }
  return { mean: count === 0 ? 0 : sum / count, worst, alphaWorst }
}

function decodeFixture(fixture: Fixture) {
  const bytes = fromBase64(fixture.data)
  const decoded = decodeImage(bytes, { maxSide: fixture.isReduced ? 256 : 4096 })
  const bitmap = fixture.isReduced ? shrink(decoded.bitmap, Math.max(fixture.width, fixture.height)) : decoded.bitmap
  return { decoded, bitmap }
}

describe('base64', () => {
  test('round-trips every length and decodes URL-safe input', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 73 + length) & 0xff)
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
    }
    expect(Array.from(fromBase64('-_8'))).toEqual([0xfb, 0xff])
  })
})

describe('inflate', () => {
  test('reads stored, fixed and dynamic blocks', () => {
    // zlib.compress(b'hello hello hello', 9), and a stored block from level 0.
    expect(new TextDecoder().decode(inflateAll(fromBase64('eNrLSM3JyVfIQJAAOi4GfQ==')))).toBe('hello hello hello')
    expect(new TextDecoder().decode(inflateAll(fromBase64('eAEBBQD6/2hlbGxvBiwCFQ==')))).toBe('hello')
  })

  test('rejects data that is not zlib', () => {
    expect(() => inflateAll(Uint8Array.of(1, 2, 3, 4))).toThrow()
  })
})

describe('PNG', () => {
  for (const fixture of PNG_FIXTURES) {
    test(`decodes ${fixture.name} exactly`, () => {
      const { decoded, bitmap } = decodeFixture(fixture)
      expect(decoded.format).toBe('png')
      expect([decoded.width, decoded.height]).toEqual([fixture.width, fixture.height])
      expect(toBase64(bitmap.data)).toBe(fixture.rgba)
    })
  }
})

describe('Pillow-encoded files', () => {
  const tolerance: Record<string, number> = { jpeg: 4, webp: 4 }
  for (const fixture of PILLOW_FIXTURES) {
    test(`decodes ${fixture.name} like Pillow`, () => {
      const { decoded, bitmap } = decodeFixture(fixture)
      expect([bitmap.width, bitmap.height]).toEqual([fixture.width, fixture.height])
      const { mean, worst, alphaWorst } = difference(bitmap, fromBase64(fixture.rgba))
      const lossy = /^(jpeg|webp-lossy|webp-large-lossy)/.test(fixture.name)
      if (!lossy) {
        expect(worst).toBe(0)
        expect(alphaWorst).toBe(0)
      } else {
        const limit = (tolerance[decoded.format] ?? 0) * (fixture.isReduced ? 2 : 1)
        if (mean > limit) throw new Error(`${fixture.name}: mean difference ${mean.toFixed(2)} > ${limit}`)
        expect(alphaWorst <= 8).toBe(true)
      }
    })
  }
})

describe('sniff', () => {
  test('names formats by content and reads sizes from headers', () => {
    for (const fixture of [...PNG_FIXTURES, ...PILLOW_FIXTURES]) {
      const sniffed = sniff(fromBase64(fixture.data))
      expect(sniffed).toBeDefined()
      if (!fixture.isReduced && sniffed?.width !== undefined) {
        expect([sniffed.width, sniffed.height]).toEqual([fixture.width, fixture.height])
      }
    }
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))?.format).toBe('svg')
    expect(sniff(new TextEncoder().encode('plain text, not a picture'))).toBe(null)
  })
})

describe('GIF', () => {
  test('refuses a frame far larger than its canvas before allocating it', () => {
    const header = [...'GIF89a'].map(c => c.charCodeAt(0))
    // A 1x1 canvas with a two-color palette, then a 65535x65535 frame.
    const screen = [1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
    const frame = [0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 2, 0, 0x3b]
    expect(() => decodeImage(new Uint8Array([...header, ...screen, ...frame]), { maxSide: 64 })).toThrow(/too large/)
  })
})

describe('bitmap', () => {
  test('fits within a box without upscaling', () => {
    expect(fitWithin({ width: 1920, height: 1080 }, 320)).toEqual({ width: 320, height: 180 })
    expect(fitWithin({ width: 100, height: 50 }, 320)).toEqual({ width: 100, height: 50 })
  })

  test('averages by area and keeps transparent pixels from darkening edges', () => {
    const sampler = new BoxDownsampler(2, 2, 1, 1)
    sampler.addRow(0, Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0))
    sampler.addRow(1, Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0))
    expect(Array.from(sampler.result().data)).toEqual([255, 0, 0, 128])
  })

  test('orients by EXIF value', () => {
    // 2x1: red, green.
    const bitmap = { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255) }
    const turned = orient(bitmap, 6)
    expect([turned.width, turned.height]).toEqual([1, 2])
    expect(Array.from(turned.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
    expect(Array.from(orient(bitmap, 2).data)).toEqual([0, 255, 0, 255, 255, 0, 0, 255])
  })
})
