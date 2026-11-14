// Min, Default and Max sizes for the panes that draw wide content (query results, lineage). Claude Code
// seats a pane itself (docked beside a fullscreen transcript, else above the prompt) and has no call to
// maximise, minimise or move one, so a size is the `columns` (dock) and `rows` (inline) the pane asks for
// each time it opens; the person's own drag or keyed size still wins. The choice is kept per pane for
// the session and in the plugin store across sessions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

export type PaneSize = 'min' | 'default' | 'max'
export type PaneSizes = Record<PaneSize, { columns: number; rows: number }>

export const SIZE_ORDER: PaneSize[] = ['min', 'default', 'max']
const SIZE_LABEL: Record<PaneSize, string> = { min: 'Min', default: 'Default', max: 'Max' }
const SIZES_KEY = 'pane-sizes'

const sizeAtom = atom({ plugin: 'altimate-code', key: 'paneSizes' } as const, {} as Record<string, PaneSize>)

/** A pane's three sizes: its own default between a narrow minimum and a maximum the surface caps (a dock takes at most 45% of the terminal). */
export const sizesAround = (preferred: { columns: number; rows: number }): PaneSizes => ({
  min: { columns: 60, rows: 14 },
  default: preferred,
  max: { columns: 240, rows: 60 },
})

export async function loadPaneSizes($: EngineInterface) {
  const saved = await $.store.get(SIZES_KEY).catch(() => null)
  const valid = saved && typeof saved === 'object' ? Object.entries(saved as Record<string, unknown>).filter(([, one]) => SIZE_ORDER.includes(one as PaneSize)) : []
  await update($, sizeAtom, () => Object.fromEntries(valid) as Record<string, PaneSize>)
}

/** What a pane asks for when it opens: the size the person chose for it, else its default. */
export async function paneRequest($: EngineInterface, id: string, sizes: PaneSizes) {
  return sizes[(await read($, sizeAtom))[id] ?? 'default']
}

/** Remembers the choice and opens the pane again at that size; an open pane is resized in place. */
async function choose($: EngineInterface, id: string, title: string, sizes: PaneSizes, size: PaneSize) {
  await update($, sizeAtom, current => ({ ...current, [id]: size }))
  await $.store.set(SIZES_KEY, await read($, sizeAtom)).catch(() => {})
  await $.ui.open({ id, title, ...sizes[size], closeOnEscape: true })
}

/** The Min / Default / Max row of a pane, the pane's current size marked. */
export async function sizeControls($: EngineInterface, ui: { Box: any; Button: any; Text: any }, pane: { id: string; title: string; sizes: PaneSizes; keyPrefix: string }, later: (work: () => Promise<unknown>) => void) {
  const { Box, Button, Text } = ui
  const current = (await read($, sizeAtom))[pane.id] ?? 'default'
  return (
    <Box key={`${pane.keyPrefix}-size`} gap={1}>
      <Text dimColor>Size</Text>
      {SIZE_ORDER.map(size => (
        <Button key={`${pane.keyPrefix}-size-${size}`} plain label={`${current === size ? '●' : '○'} ${SIZE_LABEL[size]}`} onPress={() => later(() => choose($, pane.id, pane.title, pane.sizes, size))} />
      ))}
    </Box>
  )
}
