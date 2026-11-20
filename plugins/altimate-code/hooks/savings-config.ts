// A warehouse's settings as the CLI listed them, one field per setting, each read or not. This is what a kept
// baseline (and, where a fix is followed, a drafted fix) remembers; it becomes text only when a line is drawn.

import type { WarehouseConfig } from '../types'

export type Setting = keyof WarehouseConfig

/** The settings the CLI lists for a warehouse, in the order a line names them. */
export const SETTINGS: readonly Setting[] = ['size', 'type']

/** A value as the CLI gave it, on one line; null when it gave none. */
function read(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
  return text || null
}

/** A warehouse row's settings as this run read them. */
export const configOf = (row: Partial<Record<Setting, unknown>>): WarehouseConfig => ({ size: read(row.size), type: read(row.type) })

/**
 * A kept config back from the store. Only the object this version keeps is read; anything else, such as the
 * strings an older version kept, is fully unknown, so it claims nothing until a later read fills it.
 */
export function loadConfig(value: unknown): WarehouseConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return configOf({})
  return configOf(value as Partial<Record<Setting, unknown>>)
}

/** Per setting: a later read fills one that was unknown and never overwrites one that was known. */
export const mergeConfig = (was: WarehouseConfig, now: WarehouseConfig): WarehouseConfig => ({ size: was.size ?? now.size, type: was.type ?? now.type })

/** Whether a merge would teach `was` anything. */
export const learns = (was: WarehouseConfig, now: WarehouseConfig) => SETTINGS.some(setting => was[setting] === null && now[setting] !== null)

/** The settings both reads know: the only ones a line may compare or name. */
export const comparable = (was: WarehouseConfig, now: WarehouseConfig) => SETTINGS.filter(setting => was[setting] !== null && now[setting] !== null)

/** The settings both reads know that differ. One read on one side only is no change. */
export const changedSettings = (was: WarehouseConfig, now: WarehouseConfig) => comparable(was, now).filter(setting => was[setting] !== now[setting])

const shown: Record<Setting, (value: string) => string> = { size: value => value.replace(/_/g, '-'), type: value => value }

/** The named settings of a config as a line shows them, `X-SMALL PRO`; a setting it does not know is left out. */
export const configLabel = (config: WarehouseConfig, settings: readonly Setting[] = SETTINGS) =>
  settings
    .flatMap(setting => (config[setting] === null ? [] : [shown[setting](config[setting]!)]))
    .join(' ')

/** The settings a line names, as words: `size and type`, `size`. */
export const settingsNoun = (settings: readonly Setting[]) => settings.join(' and ')
