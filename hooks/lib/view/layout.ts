// Sizes thumbnail tiles so a row of them fits the band above the prompt.
//
// A terminal cell is about twice as tall as it is wide, so a picture w x h
// pixels keeps its shape in c columns and r rows when c = 2r * w / h. Tiles
// shrink together until the row fits; when they would get too small to read,
// the row keeps the first ones and counts the rest.

export type Box2D = { width: number; height: number }
export type Cells = { columns: number; rows: number }

export type TileLayout = {
  /** One entry per tile shown, in order: the picture's box in cells. */
  tiles: Cells[]
  /** Items left out at the end of the row. */
  hidden: number
}

export type LayoutOptions = {
  /** Rows the band may take. */
  maxRows: number
  /** Columns the band may take. */
  maxColumns: number
  /** The picture height to aim for, in rows. */
  preferredRows: number
  /** Rows a tile takes inside its frame besides the picture: the row with its x, its label. */
  textRows: number
  /** The smallest picture height before tiles start to be left out. */
  minRows?: number
  /** Cell height over cell width; 2 for most terminal fonts. */
  cellAspect?: number
}

export const TILE_BORDER_COLUMNS = 2
export const TILE_BORDER_ROWS = 2
export const TILE_GAP = 1
const MIN_TILE_COLUMNS = 6
// Used while a picture's size is unknown: a screenshot's shape.
const UNKNOWN: Box2D = { width: 16, height: 10 }

/** The box of cells a picture fills at `rows` tall, keeping its shape within `maxColumns`. */
export function cellsFor(size: Box2D | null, rows: number, maxColumns: number, cellAspect = 2): Cells {
  const { width, height } = size !== null && size.width > 0 && size.height > 0 ? size : UNKNOWN
  let columns = Math.round((rows * cellAspect * width) / height)
  let fitted = rows
  if (columns > maxColumns) {
    // A wide picture: full width, fewer rows.
    columns = maxColumns
    fitted = Math.max(1, Math.round((maxColumns * height) / (cellAspect * width)))
  }
  return { columns: Math.max(MIN_TILE_COLUMNS, columns), rows: Math.min(fitted, rows) }
}

function rowWidth(tiles: readonly Cells[], hidden: number): number {
  const sum = tiles.reduce((total, tile) => total + tile.columns + TILE_BORDER_COLUMNS, 0)
  const gaps = TILE_GAP * Math.max(0, tiles.length - 1)
  const counter = hidden > 0 ? TILE_GAP + `+${hidden}`.length : 0
  return sum + gaps + counter
}

/** Lays out one row of tiles for pictures of `sizes` (null where unknown). */
export function layoutRow(sizes: readonly (Box2D | null)[], options: LayoutOptions): TileLayout {
  const aspect = options.cellAspect ?? 2
  const chrome = TILE_BORDER_ROWS + options.textRows
  const tallest = Math.min(options.preferredRows, options.maxRows - chrome)
  if (sizes.length === 0 || tallest < 1) return { tiles: [], hidden: sizes.length }
  const shortest = Math.min(tallest, Math.max(1, options.minRows ?? 3))
  // One picture may take the whole width; several shrink together below.
  const widest = Math.max(MIN_TILE_COLUMNS, options.maxColumns - TILE_BORDER_COLUMNS)

  for (let rows = tallest; rows >= shortest; rows--) {
    const tiles = sizes.map(size => cellsFor(size, rows, widest, aspect))
    if (rowWidth(tiles, 0) <= options.maxColumns) return { tiles, hidden: 0 }
  }
  // Too many to show readably: keep the first ones at the smallest height.
  const tiles = sizes.map(size => cellsFor(size, shortest, widest, aspect))
  let count = tiles.length
  while (count > 0 && rowWidth(tiles.slice(0, count), sizes.length - count) > options.maxColumns) count--
  return { tiles: tiles.slice(0, count), hidden: sizes.length - count }
}

const MAX_IMAGE_CELLS = 255

/** The largest box of cells within `limit` that keeps a picture's shape. */
export function fitCells(size: Box2D | null, limit: Cells, cellAspect = 2): Cells {
  const { width, height } = size !== null && size.width > 0 && size.height > 0 ? size : UNKNOWN
  // An Image is at most 255 cells either way.
  const most = { columns: Math.min(limit.columns, MAX_IMAGE_CELLS), rows: Math.min(limit.rows, MAX_IMAGE_CELLS) }
  let rows = most.rows
  let columns = Math.round((rows * cellAspect * width) / height)
  if (columns > most.columns) {
    columns = most.columns
    rows = Math.max(1, Math.round((columns * height) / (cellAspect * width)))
  }
  return { columns: Math.max(1, columns), rows: Math.max(1, Math.min(rows, most.rows)) }
}
