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

/** What a pane keeps of its own: the rows it asks for inline by default. Its width is the dock's, whatever the terminal. */
export type PaneSpec = { rows: number }

// The most a dock takes of the terminal, the least a request can name, and a width no terminal's 45% reaches.
const DOCK_CAP = 0.45
const DOCK_FLOOR = 24
const WIDEST = 240
// The terminal's width as the last terminal drawing or command saw it; null until one has.
let terminalColumns: number | null = null

/** Records the terminal's width, read from a terminal drawing's viewport or a command's presentation. */
export const noteTerminal = (columns: number | undefined) => {
  if (typeof columns === 'number' && columns > 0) terminalColumns = columns
}

/**
 * A pane's three sizes. Default is the widest dock (the 45% the surface allows, or, before the width is
 * known, a request wide enough that the surface caps it to the same), so it does not change when the width
 * becomes known. Min is a quarter of the width. Max is as wide and as tall as an inline pane may be.
 */
export function paneSizes(spec: PaneSpec): PaneSizes {
  const widest = terminalColumns ? Math.max(DOCK_FLOOR, Math.floor(terminalColumns * DOCK_CAP)) : WIDEST
  return {
    min: { columns: terminalColumns ? Math.max(DOCK_FLOOR, Math.floor(terminalColumns * 0.25)) : 60, rows: 14 },
    default: { columns: widest, rows: spec.rows },
    max: { columns: widest, rows: 60 },
  }
}

/** Reads the saved sizes into the session. A store read that fails leaves the sizes as they are: it says nothing about what was saved. */
export async function loadPaneSizes($: EngineInterface) {
  terminalColumns = null
  const read = await $.store.get(SIZES_KEY).then(
    saved => ({ saved }),
    () => null,
  )
  if (!read) return
  const { saved } = read
  const valid = saved && typeof saved === 'object' ? Object.entries(saved as Record<string, unknown>).filter(([, one]) => SIZE_ORDER.includes(one as PaneSize)) : []
  await update($, sizeAtom, () => Object.fromEntries(valid) as Record<string, PaneSize>)
}

// One load per session: the lineage and the dbt halves both start in it and share the saved sizes.
let loading: Promise<void> | null = null

/** A new session reads the saved sizes again. */
export function forgetPaneSizes() {
  loading = null
}

/** loadPaneSizes once for the session, however many halves ask; never rejects, so a failing store cannot stop a start. */
export function loadPaneSizesOnce($: EngineInterface): Promise<void> {
  loading ??= loadPaneSizes($).catch(() => {})
  return loading
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
