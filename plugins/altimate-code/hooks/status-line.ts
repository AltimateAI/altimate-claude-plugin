// The plugin's one status line, built from parts: the integrations part first, then each feature's, in
// the features' order, then the altimate-code version notice, which is long, so it never hides the others.
// Each part is set by its owner; setting one draws the whole line again.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

/** The features, in the order the plugin calls them (features/index.ts calls each by name in this order). */
export const FEATURE_IDS = ['runs', 'defer', 'toModel', 'comments', 'cost', 'health', 'sqlGraph', 'docs', 'cteProfile'] as const
export type FeatureId = (typeof FEATURE_IDS)[number]
export type StatusPartId = 'integrations' | 'altimateCode' | FeatureId

/** The order the parts are drawn in. */
export const STATUS_ORDER: readonly StatusPartId[] = ['integrations', ...FEATURE_IDS, 'altimateCode']

const parts = atom({ plugin: 'altimate-code', key: 'statusParts' } as const, {} as Record<string, string>)

/** The line the parts make: joined with ` · `; feature parts alone get the plugin's mark in front. */
export function statusLineOf(current: Record<string, string>): string | undefined {
  const shown = STATUS_ORDER.map(id => current[id]).filter((part): part is string => typeof part === 'string' && part !== '')
  if (shown.length === 0) return undefined
  if (!current.integrations) shown.unshift('⚡ Altimate')
  return shown.join(' · ')
}

// The parts as last drawn: a /clear empties the session's state, and the line is the process's, so they are put back.
let drawnParts: Record<string, string> = {}
// The parts drawn when a /clear ended the conversation, until the next one has them back.
let beforeClear: Record<string, string> | null = null

/** Sets one part (null or empty removes it) and draws the status line again. */
export async function setStatusPart($: EngineInterface, id: StatusPartId, text: string | null) {
  // A part its owner removes after a /clear is not brought back with the parts kept from before it.
  if (beforeClear && !text) delete beforeClear[id]
  await update($, parts, prev => {
    const next = { ...prev }
    if (text) next[id] = text
    else delete next[id]
    return next
  })
  drawnParts = await read($, parts)
  $.ui.status(statusLineOf(drawnParts))
}

// The parts that describe the machine rather than the conversation: they hold after a /clear. A feature's part
// comes from its session state, which a /clear empties; the feature draws it again when it has it back.
const KEPT_ACROSS_CLEAR: readonly StatusPartId[] = ['integrations', 'altimateCode']

/** At a /clear: keeps the machine's parts drawn now, which a part set before restoreStatusParts must not replace. */
export function keepStatusParts() {
  const kept = Object.fromEntries(KEPT_ACROSS_CLEAR.filter(id => drawnParts[id]).map(id => [id, drawnParts[id]!]))
  beforeClear = { ...(beforeClear ?? {}), ...kept }
}

/** After a /clear: the parts drawn before it, under any the new conversation has set already. */
export async function restoreStatusParts($: EngineInterface) {
  if (!beforeClear) return
  // Read when the write applies, so a part removed while it waits stays removed; let go only once written.
  await update($, parts, prev => ({ ...(beforeClear ?? {}), ...prev }))
  beforeClear = null
  drawnParts = await read($, parts)
  $.ui.status(statusLineOf(drawnParts))
}

/**
 * Clears every part at a session's start: the parts outlive a session, so a part an earlier session
 * set is not drawn again before its owner has set it in this one.
 */
export async function clearStatusParts($: EngineInterface) {
  drawnParts = {}
  beforeClear = null
  await update($, parts, () => ({}))
  $.ui.status(undefined)
}
