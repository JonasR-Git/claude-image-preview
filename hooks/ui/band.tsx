// The row of thumbnails above the prompt. A pure function of what to show:
// the hooks module decides the pixels and the presses.

import type { Elements, ImageSource, RenderElement } from 'claude-code'

import type { PreviewItem } from '../../types'
import { fitText, labelFor, placeholderFor } from '../lib/view/labels'
import { layoutRow } from '../lib/view/layout'
import type { Cells } from '../lib/view/layout'

export type Picture =
  | { kind: 'image'; key: string; source: ImageSource }
  | { kind: 'raster'; key: string; cells: string }
  | { kind: 'placeholder'; text: string }

export type BandProps = {
  ui: Elements['terminal']
  items: readonly PreviewItem[]
  maxRows: number
  maxColumns: number
  tileRows: number
  picture: (item: PreviewItem, cells: Cells, index: number) => Picture
  /** The label in a tile's title row: opens the picture in the gallery. */
  onPress: (item: PreviewItem) => void
  /** The x in a tile's title row: takes the picture out of the prompt. */
  onRemove: (item: PreviewItem) => void
}

export function pictureElement(ui: Elements['terminal'], picture: Picture, cells: Cells, alt: string): RenderElement {
  const { Box, Image, Raster, Text } = ui
  if (picture.kind === 'image') {
    return (
      <Image
        key={picture.key}
        source={picture.source}
        columns={cells.columns}
        rows={cells.rows}
        alt={fitText(alt, cells.columns)}
      />
    )
  }
  if (picture.kind === 'raster') {
    return <Raster key={picture.key} columns={cells.columns} rows={cells.rows} cells={picture.cells} />
  }
  return (
    <Box width={cells.columns} height={cells.rows} alignItems="center" justifyContent="center">
      <Text dimColor wrap="truncate-end">
        {fitText(picture.text, cells.columns * cells.rows)}
      </Text>
    </Box>
  )
}

/**
 * The tiles' frame color. The Windows overlay helper (platform/overlay.cs,
 * FRAME_RED and on) finds the frames on a screenshot by it where a terminal
 * tells nothing of its cells; light enough that terminals raising contrast
 * (VS Code) leave it as it is on a dark background. It stays the same under
 * the pointer, so the frames can be found while it rests on one.
 */
export const FRAME_COLOR = '#8b8b99'

/** Rows of a tile above its picture: the title row with its label and its x. */
export const ROWS_ABOVE_PICTURE = 1
/** Rows of a tile below its picture. */
export const ROWS_BELOW_PICTURE = 0

/** The band's tree, or null when nothing fits. */
export function band(props: BandProps): RenderElement | null {
  const { Box, Button, Text } = props.ui
  const layout = layoutRow(
    props.items.map(item =>
      item.width !== undefined && item.height !== undefined ? { width: item.width, height: item.height } : null,
    ),
    {
      maxRows: props.maxRows,
      maxColumns: props.maxColumns,
      preferredRows: props.tileRows,
      textRows: ROWS_ABOVE_PICTURE + ROWS_BELOW_PICTURE,
    },
  )
  if (layout.tiles.length === 0) return null
  const tallest = Math.max(...layout.tiles.map(tile => tile.rows))

  return (
    <Box flexDirection="row" columnGap={1} alignItems="flex-end">
      {layout.tiles.map((cells, index) => {
        const item = props.items[index]!
        const picture = props.picture(item, cells, index)
        return (
          <Box key={`tile-${index}`} flexDirection="column" borderStyle="round" borderColor={FRAME_COLOR}>
            <Box width={cells.columns} paddingX={1} justifyContent="space-between">
              <Button
                key={`open-${index}`}
                plain
                dimColor
                hover={{ color: 'cyan' }}
                label={labelFor(item, Math.max(1, cells.columns - 5))}
                onPress={() => props.onPress(item)}
              />
              <Button
                key={`remove-${index}`}
                plain
                dimColor
                hover={{ color: 'red' }}
                label="✕"
                onPress={() => props.onRemove(item)}
              />
            </Box>
            {pictureElement(props.ui, picture, cells, `[${item.label}]`)}
          </Box>
        )
      })}
      {layout.hidden > 0 && (
        <Box height={tallest + 2 + ROWS_ABOVE_PICTURE + ROWS_BELOW_PICTURE} alignItems="center">
          <Text dimColor>+{layout.hidden}</Text>
        </Box>
      )}
    </Box>
  )
}
