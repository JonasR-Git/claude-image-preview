// The mod's working state for one session, apart from what lives in $.state:
// which draft was last described, the clipboard capture in hand, and the
// services behind the commands. The hooks module owns one and does the
// $-side (state writes, prompt fills, toasts) with what it returns.

import type { PreviewItem } from '../../../types'
import { FORMAT_LABEL, IMAGE_EXTENSIONS, extensionOf } from '../codec/sniff'
import type { ImageFormat } from '../codec/sniff'
import { parseDraft } from '../prompt/draft'
import type { Env } from '../platform/os'
import { isNetworkPath, join } from '../platform/paths'
import { powershell, psString } from '../platform/scripts'
import { copyToClipboard, readClipboard } from './clipboard'
import type { ClipboardRead } from './clipboard'
import { tryRun } from './host'
import type { Host } from './host'
import { Locator } from './locator'
import { PictureStore } from './pictures'
import type { Settings } from './settings'
import { System } from './system'
import { openInViewer } from './viewer'

/** How long a paste may take to appear on disk before it counts as missing. */
const PASTE_PATIENCE_MS = 20_000
const RECHECK_MS = 400
/** A clipboard capture is reused for a short while, so typing @clipboard does not capture per key. */
const CAPTURE_REUSE_MS = 8_000
const GALLERY_LIMIT = 60
const STALE_WORK_DIR_MS = 3 * 24 * 60 * 60 * 1000

export class PreviewSession {
  readonly locator: Locator
  readonly store: PictureStore
  private draftText: string | undefined
  private draftItems: PreviewItem[] = []
  private recheckAt = 0
  private pendingSince = 0
  private capture: { at: number; sessionId: string; result: Promise<ClipboardRead> } | undefined
  private sessionId = ''

  private constructor(
    readonly host: Host,
    readonly system: System,
    readonly cwd: string,
    readonly settings: Settings,
  ) {
    this.locator = new Locator(host, system, cwd)
    this.store = new PictureStore(host, system, this.locator, cwd, () => this.locator.workDir(this.sessionId), {
      thumbSide: 256,
      maxEntries: 40,
    })
  }

  static async start(host: Host, env: Env, cwd: string, settings: Settings): Promise<PreviewSession> {
    return new PreviewSession(host, await System.detect(host, env), cwd, settings)
  }

  /** Records the id of the session (a /clear starts a new one). */
  useSession(sessionId: string): void {
    this.sessionId = sessionId
  }

  /** Forgets the described draft, so the next refresh describes it again. */
  reset(): void {
    this.draftText = undefined
    this.draftItems = []
  }

  get items(): readonly PreviewItem[] {
    return this.draftItems
  }

  /**
   * Describes the pictures `text` refers to. Resolves the new list when it
   * differs from the last one, or null when nothing changed.
   */
  async refreshDraft(text: string): Promise<PreviewItem[] | null> {
    const now = await this.host.now()
    const isPending = this.draftItems.some(item => item.status === 'loading')
    if (text === this.draftText && !(isPending && now >= this.recheckAt)) return null
    if (text !== this.draftText) this.pendingSince = now
    this.draftText = text

    const items: PreviewItem[] = []
    for (const ref of parseDraft(text)) {
      const item = await this.store.describe(ref, this.sessionId)
      // A path written without @ may be just text: it shows when the file is there.
      if (ref.kind === 'mention' && text[ref.start] !== '@' && item.status === 'missing') continue
      items.push(item)
    }

    if (items.some(item => item.status === 'loading')) {
      this.recheckAt = now + RECHECK_MS
      if (now - this.pendingSince > PASTE_PATIENCE_MS) {
        for (const item of items) {
          if (item.status === 'loading')
            Object.assign(item, { status: 'missing', reason: 'Claude Code did not store this paste' })
        }
      }
    }
    const changed = JSON.stringify(items) !== JSON.stringify(this.draftItems)
    this.draftItems = items
    return changed ? items : null
  }

  /** The gallery with `items` added or refreshed; null when nothing changed. */
  static mergeGallery(gallery: readonly PreviewItem[], items: readonly PreviewItem[]): PreviewItem[] | null {
    let next: PreviewItem[] | null = null
    for (const item of items) {
      if (item.status !== 'ready') continue
      const list: PreviewItem[] = next ?? [...gallery]
      const index = list.findIndex(other => other.key === item.key)
      if (index >= 0 && list[index]!.revision === item.revision) continue
      if (index >= 0) list.splice(index, 1)
      list.push(item)
      next = list
    }
    return next === null ? null : next.slice(-GALLERY_LIMIT)
  }

  workDir(): Promise<string> {
    return this.locator.workDir(this.sessionId)
  }

  /** Reads the clipboard's pictures; a capture younger than a few seconds is reused. */
  async clipboard(options: { reuse: boolean }): Promise<ClipboardRead> {
    const now = await this.host.now()
    if (
      options.reuse &&
      this.capture !== undefined &&
      this.capture.sessionId === this.sessionId &&
      now - this.capture.at < CAPTURE_REUSE_MS
    ) {
      return this.capture.result
    }
    const result = this.workDir().then(dir => readClipboard(this.system, dir))
    this.capture = { at: now, sessionId: this.sessionId, result }
    return result
  }

  formatOf(item: PreviewItem): ImageFormat | undefined {
    const cached = this.store.format(item.key)
    if (cached !== undefined) return cached
    const label = Object.entries(FORMAT_LABEL).find(([, name]) => name === item.format)?.[0] as ImageFormat | undefined
    return label ?? (item.path === null ? undefined : IMAGE_EXTENSIONS[extensionOf(item.path)])
  }

  async copy(item: PreviewItem): Promise<{ ok: boolean; reason?: string }> {
    if (item.path === null) return { ok: false, reason: 'the picture has no file yet' }
    return copyToClipboard(this.system, item.path, this.formatOf(item), await this.workDir())
  }

  async open(item: PreviewItem): Promise<{ ok: boolean; reason?: string }> {
    if (item.path === null) return { ok: false, reason: 'the picture has no file yet' }
    // The system opens a file by its name: a script named as a picture would run.
    if (!Object.hasOwn(IMAGE_EXTENSIONS, extensionOf(item.path)) || isNetworkPath(item.path))
      return { ok: false, reason: 'only local picture files are opened' }
    return openInViewer(this.system, item.path)
  }

  /** Removes work folders of sessions older than a few days; runs in the background. */
  async housekeeping(): Promise<void> {
    const root = await this.locator.workRoot()
    const now = await this.host.now()
    for (const entry of await this.host.list(root)) {
      if (entry.kind !== 'dir' || !/^[0-9a-f-]{16,64}$/i.test(entry.name) || entry.name === this.sessionId) continue
      const dir = join(this.system.style, root, entry.name)
      const stat = await this.host.stat(dir)
      if (stat === null || now - stat.mtimeMs < STALE_WORK_DIR_MS) continue
      const shell = this.system.powershell
      const argv =
        this.system.platform === 'windows' && shell !== null
          ? powershell(shell, `Remove-Item -LiteralPath ${psString(dir)} -Recurse -Force`)
          : ['rm', '-rf', '--', dir]
      await tryRun(this.host, argv, { timeoutMs: 20000 })
    }
  }

  /** A plain-text report for /image-preview status. */
  async diagnostics(renderer: string, version: string, overlay?: string): Promise<string> {
    const tools = [...(await this.system.tools())].sort()
    const pictures = this.draftItems.map(
      item => `${item.label} ${item.status}${item.reason === undefined ? '' : ` (${item.reason})`}`,
    )
    const lines = [
      `Claude Code: ${version}`,
      `platform: ${this.system.platform}`,
      `renderer: ${renderer} (setting: ${this.settings.renderer})`,
      ...(overlay === undefined ? [] : [`real pictures over the blocks: ${overlay}`]),
      `in the prompt: ${pictures.length === 0 ? 'no pictures' : pictures.join(', ')}`,
      ...(await this.locator.report(this.sessionId)),
      `work folder: ${await this.workDir()}`,
      `helper tools: ${tools.length === 0 ? (this.system.platform === 'windows' ? 'PowerShell (built in)' : 'none found') : tools.join(', ')}`,
      `decoded here: PNG, JPEG, GIF, BMP, WebP; others through a converter`,
    ]
    return lines.join('\n')
  }
}
