// Finds the pictures a prompt draft refers to: pasted images, which Claude Code
// shows as `[Image #n]`, image files named after an `@`, quoted or not, and
// absolute image paths without one, as a terminal types them for a dropped
// file when Claude Code does not turn it into a paste (Git Bash's mintty).

import { looksLikeImagePath } from '../codec/sniff'
import { msysToWindows } from '../platform/paths'

export type DraftRef =
  | { kind: 'paste'; id: number; start: number; end: number }
  | { kind: 'mention'; path: string; start: number; end: number }

const PASTE = /\[Image #(\d+)\]/g
// A quoted mention, as Claude Code reads one: start of text or whitespace, @"...".
const QUOTED = /(^|\s)@"([^"]+)"/g
// An unquoted mention: @ then everything up to whitespace.
const BARE = /(^|\s)@([^\s"]+)/g
// An absolute path without @: a drive (C:\ or C:/) or a leading /, quoted or not.
const DROPPED_QUOTED = /(^|\s)(['"])((?:[A-Za-z]:[\\/]|\/)[^'"]+)\2/g
const DROPPED_BARE = /(^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s'"]+)/g

/** Strips a trailing line range (`#L10-20`) Claude Code accepts on a mention. */
function withoutLineRange(path: string): string {
  return path.replace(/#L\d+(?:-\d+)?$/, '')
}

/** Every picture reference in `text`, in the order they appear, each named once. */
export function parseDraft(text: string): DraftRef[] {
  const seen = new Set<string>()
  return findRefs(text).filter(ref => {
    const key = ref.kind === 'paste' ? `paste:${ref.id}` : `mention:${ref.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every picture reference in `text`, in the order they appear. */
function findRefs(text: string): DraftRef[] {
  const found: DraftRef[] = []
  for (const match of text.matchAll(PASTE)) {
    const id = Number(match[1])
    if (Number.isSafeInteger(id) && id > 0) {
      found.push({ kind: 'paste', id, start: match.index, end: match.index + match[0].length })
    }
  }
  const quotedSpans: [number, number][] = []
  for (const match of text.matchAll(QUOTED)) {
    const start = match.index + match[1]!.length
    const end = match.index + match[0].length
    quotedSpans.push([start, end])
    const path = withoutLineRange(match[2]!)
    if (looksLikeImagePath(path)) found.push({ kind: 'mention', path, start, end })
  }
  for (const match of text.matchAll(BARE)) {
    const start = match.index + match[1]!.length
    if (quotedSpans.some(([from, to]) => start >= from && start < to)) continue
    // Punctuation after the mention stays in the text, as for a dropped path below.
    const named = match[2]!.replace(/[),.;:!?]+$/, '')
    const path = withoutLineRange(named)
    if (looksLikeImagePath(path)) found.push({ kind: 'mention', path, start, end: start + 1 + named.length })
  }
  const taken = (start: number) => found.some(ref => start >= ref.start && start < ref.end)
  for (const match of text.matchAll(DROPPED_QUOTED)) {
    const start = match.index + match[1]!.length
    const end = match.index + match[0].length
    if (taken(start) || quotedSpans.some(([from, to]) => start >= from && start < to)) continue
    quotedSpans.push([start, end])
    if (looksLikeImagePath(match[3]!)) found.push({ kind: 'mention', path: match[3]!, start, end })
  }
  for (const match of text.matchAll(DROPPED_BARE)) {
    const start = match.index + match[1]!.length
    if (taken(start) || quotedSpans.some(([from, to]) => start >= from && start < to)) continue
    const path = match[2]!.replace(/[),.;:!?]+$/, '')
    // Punctuation after the path stays in the text: it is not part of the reference.
    if (looksLikeImagePath(path)) found.push({ kind: 'mention', path, start, end: start + path.length })
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * The paths in `text` when it is nothing but absolute image paths without an
 * `@`, as a terminal types files dropped on it; null for anything else.
 */
export function droppedPaths(text: string): (DraftRef & { kind: 'mention' })[] | null {
  const refs = findRefs(text).filter(
    (ref): ref is DraftRef & { kind: 'mention' } => ref.kind === 'mention' && text[ref.start] !== '@',
  )
  if (refs.length === 0) return null
  let rest = ''
  let at = 0
  for (const ref of refs) {
    rest += text.slice(at, ref.start)
    at = ref.end
  }
  rest += text.slice(at)
  return rest.trim() === '' ? refs : null
}

/**
 * Git Bash's mintty types a dropped picture as its POSIX path
 * ('/c/Users/.../shot.png'), which Claude Code leaves as text. As an
 * @-mention of the Windows path it reaches Claude as a picture. `before` and
 * `after` are the characters around where the paste goes, so the mentions
 * stand apart from them; an `@` typed just before becomes the first one's.
 * Null when `pasted` is anything else or names a file that is not there.
 */
export async function droppedAsMentions(
  pasted: string,
  before: string,
  after: string,
  isFile: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const refs = droppedPaths(pasted)
  if (refs === null) return null
  let text = pasted
  for (const ref of [...refs].reverse()) {
    const path = msysToWindows(ref.path)
    if (path === null || !(await isFile(path))) return null
    text = text.slice(0, ref.start) + mentionFor(path) + text.slice(ref.end)
  }
  if (before === '@') text = text.replace(/^\s*@/, '')
  else if (before !== '' && !/\s/.test(before) && !/^\s/.test(text)) text = ` ${text}`
  if (after !== '' && !/\s/.test(after) && !/\s$/.test(text)) text += ' '
  return text
}

/** `text` without `ref`, and without the space that would be left doubled. */
export function withoutRef(text: string, ref: DraftRef): string {
  let start = ref.start
  let end = ref.end
  if (/\s/.test(text[end] ?? '') && (start === 0 || /\s/.test(text[start - 1]!))) end++
  else if (start > 0 && /\s/.test(text[start - 1]!) && end === text.length) start--
  return text.slice(0, start) + text.slice(end)
}

/** How to name `path` after an `@` so Claude Code reads it as one mention. */
export function mentionFor(path: string): string {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`
}

/** Text to insert at `cursor` in `draft` so the mention stands apart from its neighbors. */
export function insertionFor(draft: string, cursor: number, mention: string): string {
  const before = cursor > 0 ? draft[cursor - 1]! : ''
  const after = cursor < draft.length ? draft[cursor]! : ''
  const lead = before === '' || /\s/.test(before) ? '' : ' '
  const trail = after !== '' && /\s/.test(after) ? '' : ' '
  return lead + mention + trail
}
