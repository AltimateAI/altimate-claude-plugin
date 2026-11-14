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

/** What a pane asks for by default: columns (docked) and rows (inline), and the share of the terminal its Default takes where the width is known. */
export type PaneSpec = { columns: number; rows: number; share: number }
export const sizesAround = (spec: PaneSpec): PaneSpec => spec

// The most a dock takes of the terminal, and the least a request can name.
const DOCK_CAP = 0.45
const DOCK_FLOOR = 24
// The terminal's width as the last pane drawing or command saw it; null until one has.
let terminalColumns: number | null = null

/** Records the terminal's width, read from a drawing's viewport or a command's presentation. */
export const noteTerminal = (columns: number | undefined) => {
  if (typeof columns === 'number' && columns > 0) terminalColumns = columns
}

/**
 * A pane's three sizes. With the terminal's width known they are shares of it (a quarter, the pane's
 * own share, the dock's 45% cap), so they differ when docked; unknown, they are absolute requests that
 * the surface caps.
 */
export function paneSizes(spec: PaneSpec): PaneSizes {
  const width = terminalColumns
  if (!width) return { min: { columns: 60, rows: 14 }, default: { columns: spec.columns, rows: spec.rows }, max: { columns: 240, rows: 60 } }
  const share = (part: number) => Math.max(DOCK_FLOOR, Math.floor(width * part))
  return {
    min: { columns: share(0.25), rows: 14 },
    default: { columns: Math.min(spec.columns, share(spec.share)), rows: spec.rows },
    max: { columns: share(DOCK_CAP), rows: 60 },
  }
}

export async function loadPaneSizes($: EngineInterface) {
  terminalColumns = null
  const saved = await $.store.get(SIZES_KEY).catch(() => null)
  const valid = saved && typeof saved === 'object' ? Object.entries(saved as Record<string, unknown>).filter(([, one]) => SIZE_ORDER.includes(one as PaneSize)) : []
  await update($, sizeAtom, () => Object.fromEntries(valid) as Record<string, PaneSize>)
}

/** What a pane asks for when it opens: the size the person chose for it, else its default. */
export async function paneRequest($: EngineInterface, id: string, spec: PaneSpec) {
  return paneSizes(spec)[(await read($, sizeAtom))[id] ?? 'default']
}

/** Remembers the choice and opens the pane again at that size; an open pane is resized in place. */
async function choose($: EngineInterface, id: string, title: string, spec: PaneSpec, size: PaneSize) {
  await update($, sizeAtom, current => ({ ...current, [id]: size }))
  await $.store.set(SIZES_KEY, await read($, sizeAtom)).catch(() => {})
  await $.ui.open({ id, title, ...paneSizes(spec)[size], closeOnEscape: true })
}

/** The Min / Default / Max row of a pane, the pane's current size marked. */
export async function sizeControls($: EngineInterface, ui: { Box: any; Button: any; Text: any }, pane: { id: string; title: string; spec: PaneSpec; keyPrefix: string; terminal?: number }, later: (work: () => Promise<unknown>) => void) {
  const { Box, Button, Text } = ui
  noteTerminal(pane.terminal)
  const current = (await read($, sizeAtom))[pane.id] ?? 'default'
  return (
    <Box key={`${pane.keyPrefix}-size`} gap={1}>
      <Text dimColor>Size</Text>
      {SIZE_ORDER.map(size => (
        <Button key={`${pane.keyPrefix}-size-${size}`} plain label={`${current === size ? '●' : '○'} ${SIZE_LABEL[size]}`} onPress={() => later(() => choose($, pane.id, pane.title, pane.spec, size))} />
      ))}
    </Box>
  )
}
