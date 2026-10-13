// The one pixel format every decoder produces: 8-bit RGBA, straight alpha,
// rows top to bottom. Decoders feed rows into a BoxDownsampler so a large
// picture is reduced while it is decoded instead of after.

export type Bitmap = {
  width: number
  height: number
  /** width * height * 4 bytes: R, G, B, A. */
  data: Uint8Array
}

export type Size = { width: number; height: number }

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

/** The largest size within `maxSide` x `maxSide` with the same aspect ratio; never upscales. */
export function fitWithin(size: Size, maxSide: number): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= maxSide) return { width: size.width, height: size.height }
  const scale = maxSide / longest
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/**
 * Area-averaging downsampler. Each source pixel adds to the one target pixel
 * whose box it falls in; colors are averaged weighted by alpha, so transparent
 * pixels do not darken the edges of a cut-out.
 */
export class BoxDownsampler {
  private readonly sums: Float64Array
  private readonly columnTarget: Int32Array
  private readonly columnCount: Int32Array
  private readonly rowCount: Int32Array
  // Same size in and out: rows are copied as they are, colors of transparent pixels included.
  private readonly copy: Bitmap | null

  constructor(
    readonly sourceWidth: number,
    readonly sourceHeight: number,
    readonly width: number,
    readonly height: number,
  ) {
    const isSameSize = sourceWidth === width && sourceHeight === height
    this.copy = isSameSize ? createBitmap(width, height) : null
    this.sums = new Float64Array(isSameSize ? 0 : width * height * 4)
    this.columnTarget = new Int32Array(sourceWidth)
    this.columnCount = new Int32Array(width)
    this.rowCount = new Int32Array(height)
    for (let x = 0; x < sourceWidth; x++) {
      const target = Math.min(width - 1, Math.floor((x * width) / sourceWidth))
      this.columnTarget[x] = target
      this.columnCount[target]!++
    }
    for (let y = 0; y < sourceHeight; y++) this.rowCount[this.targetRow(y)]!++
  }

  private targetRow(y: number): number {
    return Math.min(this.height - 1, Math.floor((y * this.height) / this.sourceHeight))
  }

  /** Adds source row `y`, `sourceWidth` RGBA pixels starting at `offset`. */
  addRow(y: number, rgba: Uint8Array, offset = 0): void {
    if (this.copy !== null) {
      this.copy.data.set(rgba.subarray(offset, offset + this.sourceWidth * 4), y * this.sourceWidth * 4)
      return
    }
    const base = this.targetRow(y) * this.width * 4
    const sums = this.sums
    const columnTarget = this.columnTarget
    for (let x = 0, at = offset; x < this.sourceWidth; x++, at += 4) {
      const alpha = rgba[at + 3]!
      const to = base + columnTarget[x]! * 4
      sums[to] = sums[to]! + rgba[at]! * alpha
      sums[to + 1] = sums[to + 1]! + rgba[at + 1]! * alpha
      sums[to + 2] = sums[to + 2]! + rgba[at + 2]! * alpha
      sums[to + 3] = sums[to + 3]! + alpha
    }
  }

  result(): Bitmap {
    if (this.copy !== null) return this.copy
    const out = createBitmap(this.width, this.height)
    const data = out.data
    const sums = this.sums
    for (let ty = 0; ty < this.height; ty++) {
      for (let tx = 0; tx < this.width; tx++) {
        const at = (ty * this.width + tx) * 4
        const count = this.columnCount[tx]! * this.rowCount[ty]!
        const alpha = sums[at + 3]!
        if (count === 0 || alpha === 0) continue
        data[at] = Math.round(sums[at]! / alpha)
        data[at + 1] = Math.round(sums[at + 1]! / alpha)
        data[at + 2] = Math.round(sums[at + 2]! / alpha)
        data[at + 3] = Math.round(alpha / count)
      }
    }
    return out
  }
}

/** Downsamples a whole bitmap to fit `maxSide`; returns it unchanged when it already fits. */
export function shrink(bitmap: Bitmap, maxSide: number): Bitmap {
  const target = fitWithin(bitmap, maxSide)
  if (target.width === bitmap.width && target.height === bitmap.height) return bitmap
  const sampler = new BoxDownsampler(bitmap.width, bitmap.height, target.width, target.height)
  const stride = bitmap.width * 4
  for (let y = 0; y < bitmap.height; y++) sampler.addRow(y, bitmap.data, y * stride)
  return sampler.result()
}

/**
 * Applies an EXIF orientation (1-8) so the picture shows as a viewer shows it:
 * 2 mirror, 3 rotate 180, 4 flip, 5 transpose, 6 rotate 90 cw, 7 transverse,
 * 8 rotate 90 ccw. Any other value returns the bitmap unchanged.
 */
export function orient(bitmap: Bitmap, orientation: number): Bitmap {
  if (orientation < 2 || orientation > 8) return bitmap
  const { width, height, data } = bitmap
  const swaps = orientation >= 5
  const out = createBitmap(swaps ? height : width, swaps ? width : height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tx: number
      let ty: number
      switch (orientation) {
        case 2:
          tx = width - 1 - x
          ty = y
          break
        case 3:
          tx = width - 1 - x
          ty = height - 1 - y
          break
        case 4:
          tx = x
          ty = height - 1 - y
          break
        case 5:
          tx = y
          ty = x
          break
        case 6:
          tx = height - 1 - y
          ty = x
          break
        case 7:
          tx = height - 1 - y
          ty = width - 1 - x
          break
        default:
          tx = y
          ty = width - 1 - x
          break
      }
      const from = (y * width + x) * 4
      const to = (ty * out.width + tx) * 4
      out.data[to] = data[from]!
      out.data[to + 1] = data[from + 1]!
      out.data[to + 2] = data[from + 2]!
      out.data[to + 3] = data[from + 3]!
    }
  }
  return out
}
