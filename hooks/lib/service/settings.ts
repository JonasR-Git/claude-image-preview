// The mod's options, from the manifest's userConfig (set in /config or
// /plugin), with IMAGE_PREVIEW_RENDERER in the environment as an override.

import type { Env } from '../platform/os'

export type RendererSetting = 'auto' | 'pictures' | 'blocks' | 'off'

export type Settings = {
  renderer: RendererSetting
  /** Picture height in the band, in rows; the band's own height limits it further. */
  tileRows: number
  /** Thumbnails under the pictures Claude reads, and those pictures in the gallery. */
  readPreviews: boolean
  /** On Windows, the real picture laid over its blocks in a window of its own. */
  overlay: boolean
}

/** The tallest a thumbnail may be. As tall as the band allows shows the most detail, so it is the default. */
export const MAX_TILE_ROWS = 32

export const DEFAULTS: Settings = {
  renderer: 'auto',
  tileRows: MAX_TILE_ROWS,
  readPreviews: true,
  overlay: true,
}

const RENDERERS: readonly RendererSetting[] = ['auto', 'pictures', 'blocks', 'off']

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

export function parseSettings(options: Readonly<Record<string, unknown>>, env: Env): Settings {
  const rows = Number(options.tile_rows)
  const fromEnv = env.IMAGE_PREVIEW_RENDERER?.toLowerCase()
  // Older spellings of the override still work.
  const override = fromEnv === 'image' ? 'pictures' : fromEnv
  return {
    renderer: pick(override, RENDERERS, pick(options.renderer, RENDERERS, DEFAULTS.renderer)),
    tileRows: Number.isFinite(rows) && rows >= 2 ? Math.min(MAX_TILE_ROWS, Math.round(rows)) : DEFAULTS.tileRows,
    readPreviews: typeof options.read_previews === 'boolean' ? options.read_previews : DEFAULTS.readPreviews,
    overlay: typeof options.overlay === 'boolean' ? options.overlay : DEFAULTS.overlay,
  }
}
