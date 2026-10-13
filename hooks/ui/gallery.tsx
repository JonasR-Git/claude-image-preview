// The /images pane: every picture of the session, one large at a time, with
// actions to open it, copy it as a picture, insert it into the prompt again,
// or copy its path.

import type { ButtonProps, ElementConstructor, RenderElement, TextProps, BoxProps } from 'claude-code'

import type { PreviewItem } from '../../types'
import { factsOf, fitText } from '../lib/view/labels'
import { fitCells } from '../lib/view/layout'
import type { Cells } from '../lib/view/layout'
import { pictureElement } from './band'
import type { Picture } from './band'
import type { Elements } from 'claude-code'

type Basic = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type GalleryActions = {
  select: (index: number) => void
  open: (item: PreviewItem) => void
  copy: (item: PreviewItem) => void
  insert: (item: PreviewItem) => void
  copyPath: (item: PreviewItem) => void
}

export type GalleryProps = {
  ui: Basic
  /** The terminal's table, where pictures can be drawn; absent elsewhere. */
  terminal?: Elements['terminal']
  items: readonly PreviewItem[]
  index: number
  bodyColumns: number
  bodyRows: number
  picture?: (item: PreviewItem, cells: Cells) => Picture
  actions: GalleryActions
}

const SOURCE_WORD: Record<PreviewItem['source'], string> = {
  paste: 'pasted',
  mention: 'mentioned',
  clipboard: 'from the clipboard',
  read: 'read by Claude',
}

export function gallery(props: GalleryProps): RenderElement {
  const { Box, Text, Button } = props.ui
  const { items, actions } = props
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No pictures in this session yet.</Text>
        <Text dimColor>Paste one (Ctrl+V, Alt+V on Windows), run /paste, or type @clipboard in the prompt.</Text>
      </Box>
    )
  }
  const index = Math.min(Math.max(0, props.index), items.length - 1)
  const item = items[index]!
  const width = Math.max(10, props.bodyColumns)
  // Header, actions and path take three rows.
  const room: Cells = { columns: width, rows: Math.max(3, props.bodyRows - 4) }
  const size = item.width !== undefined && item.height !== undefined ? { width: item.width, height: item.height } : null
  const cells = fitCells(size, room)

  let view: RenderElement
  if (props.terminal !== undefined && props.picture !== undefined) {
    view = pictureElement(props.terminal, props.picture(item, cells), cells, `[${item.label}]`)
  } else {
    view = (
      <Text dimColor>
        {item.status === 'ready' ? 'Pictures are drawn in the terminal.' : (item.reason ?? item.status)}
      </Text>
    )
  }

  const facts = [...factsOf(item), SOURCE_WORD[item.source]].join(' · ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="previous"
          plain
          hotkey="p"
          label="‹ prev"
          dimColor={index === 0}
          onPress={() => actions.select(index - 1)}
        />
        <Text bold>
          {index + 1}/{items.length}
        </Text>
        <Button
          key="next"
          plain
          hotkey="n"
          label="next ›"
          dimColor={index === items.length - 1}
          onPress={() => actions.select(index + 1)}
        />
        <Text wrap="truncate-end">{fitText(facts, Math.max(10, width - 30))}</Text>
      </Box>
      <Box width={width} justifyContent="center">
        {view}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="open" plain hotkey="o" label="open" onPress={() => actions.open(item)} />
        <Button key="copy" plain hotkey="c" label="copy picture" onPress={() => actions.copy(item)} />
        <Button key="insert" plain hotkey="i" label="insert into prompt" onPress={() => actions.insert(item)} />
        <Button key="path" plain hotkey="y" label="copy path" onPress={() => actions.copyPath(item)} />
      </Box>
      {item.path !== null && (
        <Text dimColor wrap="truncate-middle">
          {item.path}
        </Text>
      )}
    </Box>
  )
}
