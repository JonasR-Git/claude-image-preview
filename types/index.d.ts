// The values the mod keeps in $.state, which survive a reload of the hooks
// module and reset with /clear. Pixels are not here: they stay in the module's
// own cache, and a drawing asks for them by `key` and `revision`.

/** Where a picture came from. */
export type PreviewSource = 'paste' | 'mention' | 'clipboard' | 'read'

/** `ready` has pixels; the others say why not. */
export type PreviewStatus = 'ready' | 'loading' | 'missing' | 'unsupported' | 'error'

export type PreviewItem = {
  /** `paste:<n>` for `[Image #n]`, `file:<absolute path>` otherwise. */
  key: string
  /** `#3` for a paste, the file name otherwise. */
  label: string
  source: PreviewSource
  /** The file the pixels come from, once known. */
  path: string | null
  status: PreviewStatus
  /** Why there is no picture, for a status other than `ready`. */
  reason?: string
  /** `PNG`, `JPEG`, ... */
  format?: string
  /** The picture's own size, as a viewer shows it. */
  width?: number
  height?: number
  /** File size in bytes. */
  bytes?: number
  /** Changes when the pixels behind the key change, so a drawing redraws. */
  revision: string
}

/** How pictures are drawn: real pictures where the terminal can, colored half blocks elsewhere. */
export type RendererState = {
  mode: 'pictures' | 'blocks'
  /** True once a probe confirmed the mode on this terminal. */
  isConfirmed: boolean
  /** Whether the terminal reads PNG files itself or needs the pixels sent. */
  source: 'file' | 'bytes'
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': {
      /** The pictures the prompt draft refers to, in order. */
      band: PreviewItem[]
      /** Every picture seen this session, newest last. */
      gallery: PreviewItem[]
      /** The gallery's selected key. */
      selected: string | null
      renderer: RendererState | null
      /** The band was hidden with /image-preview off. */
      isHidden: boolean
    }
  }
}
