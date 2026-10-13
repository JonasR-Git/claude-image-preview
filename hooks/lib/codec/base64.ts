// Base64 for the hooks runtime. `$.fs.read` hands bytes over as base64 and the
// Image and Raster elements take base64, so both directions sit on hot paths.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const DECODE = (() => {
  const table = new Int16Array(256).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  // URL-safe spellings decode too.
  table['-'.charCodeAt(0)] = 62
  table['_'.charCodeAt(0)] = 63
  return table
})()

/** Decodes base64 (standard or URL-safe, padded or not); whitespace is skipped. */
export function fromBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3)
  let written = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 61) break // '='
    const value = code < 256 ? DECODE[code]! : -1
    if (value < 0) {
      if (code === 32 || code === 10 || code === 13 || code === 9) continue
      throw new Error(`invalid base64 character at ${i}`)
    }
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written++] = (acc >>> bits) & 0xff
    }
  }
  return out.subarray(0, written)
}

/** Encodes bytes as standard, padded base64. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const CHUNK = 0x3000 // a multiple of 3, so only the last chunk pads
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK)
    let chunk = ''
    let i = start
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
      chunk += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!
    }
    const rest = end - i
    if (rest === 1) {
      const n = bytes[i]! << 16
      chunk += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + '=='
    } else if (rest === 2) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
      chunk += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + '='
    }
    parts.push(chunk)
  }
  return parts.join('')
}
