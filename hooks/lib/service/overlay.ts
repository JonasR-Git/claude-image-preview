// Keeps the Windows helper that lays real pictures over the colored blocks
// (platform/overlay.cs): starts it with the session, so it is ready by the
// first paste, and writes the tiles it should cover. In a terminal it cannot
// place pictures in, it says so and is not started again.

import {
  OVERLAY_BROKEN,
  OVERLAY_NO_CONSOLE,
  OVERLAY_UNSUPPORTED,
  overlayState,
  windowsOverlay,
} from '../platform/overlay'
import type { OverlayTile } from '../platform/overlay'
import { join } from '../platform/paths'
import { powershell } from '../platform/scripts'
import type { Host } from './host'
import type { System } from './system'

export type { OverlayTile }

/** Runs `argv` until it exits and resolves its exit code; null when it could not start. */
export type Spawn = (argv: readonly string[]) => Promise<number | null>

/** Where the helper's files go: its state and log, and the compiled helper shared by sessions. */
export type OverlayPlaces = { dir: string; cache: string }

/** A helper that keeps failing is not started again after this many tries. */
const MAX_STARTS = 3
/** A run this long was healthy: its end does not count against the tries. */
const HEALTHY_RUN_MS = 2 * 60 * 1000

export class PictureOverlay {
  private places: Promise<OverlayPlaces> | undefined
  private written: string | null = null
  private isRunning = false
  private starts = 0
  private queue: Promise<void> = Promise.resolve()
  private stopped = 'not started'

  constructor(
    private readonly host: Host,
    private readonly system: System,
    /** The helper's C# source. */
    private readonly source: string,
    private readonly placesOf: () => Promise<OverlayPlaces>,
    private readonly spawn: Spawn,
  ) {}

  /** Starts the helper ahead of the first picture; it idles until there is one. */
  start(): void {
    if (!this.isWindows()) return
    this.queue = this.queue.then(() => this.launch()).catch(() => undefined)
  }

  /** The tiles drawn as blocks right now, in order; none hides every picture. */
  show(tiles: readonly OverlayTile[]): void {
    if (!this.isWindows()) return
    const state = overlayState(tiles)
    if (state === this.written) return
    this.written = state
    this.queue = this.queue
      .then(async () => {
        const { dir } = await this.place()
        await this.host.writeText(join(this.system.style, dir, 'overlay.tsv'), state)
        if (tiles.length > 0) await this.launch()
      })
      .catch(() => undefined)
  }

  /** One line for /image-preview status. */
  async describe(): Promise<string> {
    if (!this.isWindows()) return 'not on Windows'
    const { dir } = await this.place()
    const log = join(this.system.style, dir, 'overlay.log')
    return `${this.isRunning ? 'running' : this.stopped} (log: ${log})`
  }

  /** Waits for the writes and starts queued so far. */
  settled(): Promise<void> {
    return this.queue
  }

  private isWindows(): boolean {
    return this.system.platform === 'windows' && this.system.powershell !== null
  }

  /** The folders are fixed at the first use: a /clear changes the session, not the helper's files. */
  private place(): Promise<OverlayPlaces> {
    this.places ??= this.placesOf()
    return this.places
  }

  private async launch(): Promise<void> {
    if (this.isRunning || this.starts >= MAX_STARTS) return
    const style = this.system.style
    const { dir, cache } = await this.place()
    const state = join(style, dir, 'overlay.tsv')
    if (this.written === null) await this.host.writeText(state, overlayState([]))
    this.starts++
    this.isRunning = true
    const argv = powershell(this.system.powershell!, windowsOverlay(this.source, state, cache), true)
    const startedAt = await this.host.now()
    void this.spawn(argv).then(async code => this.ended(code, (await this.host.now()) - startedAt))
  }

  private ended(code: number | null, ranMs: number): void {
    this.isRunning = false
    if (ranMs >= HEALTHY_RUN_MS) this.starts = 0
    // None of these mends itself by starting again.
    const why =
      code === OVERLAY_UNSUPPORTED
        ? 'off: a terminal it cannot place pictures in (see the log)'
        : code === OVERLAY_NO_CONSOLE
          ? 'off: no console found'
          : code === OVERLAY_BROKEN
            ? 'off: the helper did not start (see the log)'
            : null
    if (why !== null) {
      this.starts = MAX_STARTS
      this.stopped = why
      return
    }
    this.stopped = this.starts >= MAX_STARTS ? `off: ended ${MAX_STARTS} times (exit ${code})` : `ended (exit ${code})`
    // The next change of tiles starts it again.
    this.written = null
  }
}
