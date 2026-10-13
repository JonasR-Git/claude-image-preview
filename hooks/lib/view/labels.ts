// Words under and beside pictures.

import type { PreviewItem } from '../../../types'

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Cuts `text` to `width` characters, marking the cut with an ellipsis. */
export function fitText(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const each = cellWidth(char)
    if (used + each > width - 1) break
    out += char
    used += each
  }
  return `${out}…`
}

/** Wide ranges: CJK, Hangul, fullwidth forms, emoji. */
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
] as const
/** Marks drawn on the character before them, and joiners. */
const ZERO = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
] as const

/** How many terminal cells `text` takes, close enough for labels. */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (ZERO.some(([from, to]) => code >= from && code <= to)) continue
    width += WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
  }
  return width
}

/** The facts about a picture, most important first. */
export function factsOf(item: PreviewItem): string[] {
  const parts = [item.label]
  if (item.width !== undefined && item.height !== undefined) parts.push(`${item.width}×${item.height}`)
  if (item.format !== undefined) parts.push(item.format)
  if (item.bytes !== undefined) parts.push(humanBytes(item.bytes))
  return parts
}

/** As many facts as fit in `width`, dropping the least important first. */
export function labelFor(item: PreviewItem, width: number, full = true): string {
  const parts = full ? factsOf(item) : [item.label]
  for (let count = parts.length; count >= 1; count--) {
    const text = parts.slice(0, count).join(' · ')
    if (cellWidth(text) <= width) return text
  }
  return fitText(parts[0]!, width)
}

/** A short reason shown in place of a picture that is not ready. */
export function placeholderFor(item: PreviewItem): string {
  switch (item.status) {
    case 'loading':
      return '…'
    case 'missing':
      return 'not found'
    case 'unsupported':
      return item.reason ?? 'unsupported'
    case 'error':
      return item.reason ?? 'unreadable'
    default:
      return ''
  }
}
