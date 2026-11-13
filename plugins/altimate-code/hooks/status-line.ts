// The plugin's one status line, built from parts: the integrations part first, then each feature's,
// in the features' order. Each part is set by its owner; setting one draws the whole line again.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

export type FeatureId = 'runs' | 'defer' | 'toModel' | 'comments' | 'cost' | 'health' | 'sqlGraph' | 'docs' | 'cteProfile'
export type StatusPartId = 'integrations' | FeatureId

/** The order the parts are drawn in. */
export const STATUS_ORDER: readonly StatusPartId[] = ['integrations', 'runs', 'defer', 'toModel', 'comments', 'cost', 'health', 'sqlGraph', 'docs', 'cteProfile']

const parts = atom({ plugin: 'altimate-code', key: 'statusParts' } as const, {} as Record<string, string>)

/** The line the parts make: joined with ` · `; feature parts alone get the plugin's mark in front. */
export function statusLineOf(current: Record<string, string>): string | undefined {
  const shown = STATUS_ORDER.map(id => current[id]).filter((part): part is string => typeof part === 'string' && part !== '')
  if (shown.length === 0) return undefined
  if (!current.integrations) shown.unshift('⚡ Altimate')
  return shown.join(' · ')
}

/** Sets one part (null or empty removes it) and draws the status line again. */
export async function setStatusPart($: EngineInterface, id: StatusPartId, text: string | null) {
  await update($, parts, prev => {
    const next = { ...prev }
    if (text) next[id] = text
    else delete next[id]
    return next
  })
  $.ui.status(statusLineOf(await read($, parts)))
}
