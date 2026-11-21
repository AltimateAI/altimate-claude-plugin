// A warehouse's settings as the CLI listed them, one field per setting, each read or not. This is what a kept
// baseline (and, where a fix is followed, a drafted fix) remembers; it becomes text only when a line is drawn.

import type { WarehouseConfig } from '../types'
import { oneLine } from './savings-text'

export type Setting = keyof WarehouseConfig

/** The settings the CLI lists for a warehouse, in the order a line names them. */
export const SETTINGS: readonly Setting[] = ['size', 'type']

/** A value as the CLI gave it, on one line; null when it gave none. */
const read = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? oneLine(value) || null : null)

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

/** The settings both reads know: the only ones a line may compare or name. */
export const comparable = (was: WarehouseConfig, now: WarehouseConfig) => SETTINGS.filter(setting => was[setting] !== null && now[setting] !== null)

/** The settings both reads know that differ. One read on one side only is no change. */
export const changedSettings = (was: WarehouseConfig, now: WarehouseConfig) => comparable(was, now).filter(setting => was[setting] !== now[setting])

/**
 * Whether `now` reads more than `was` without contradicting it: a setting `was` did not know is known, and no
 * setting known to both changed. A read after a change shows the warehouse as it is now, so it teaches nothing
 * about the state before.
 */
export const learns = (was: WarehouseConfig, now: WarehouseConfig) =>
  changedSettings(was, now).length === 0 && SETTINGS.some(setting => was[setting] === null && now[setting] !== null)

/** Whether `now` knows every setting `was` knows, so it can stand for `was` whole. */
export const covers = (was: WarehouseConfig, now: WarehouseConfig) => SETTINGS.every(setting => was[setting] === null || now[setting] !== null)

const shown: Record<Setting, (value: string) => string> = { size: value => value.replace(/_/g, '-'), type: value => value }

/** The named settings of a config as a line shows them, `X-SMALL PRO`; a setting it does not know is left out. */
export const configLabel = (config: WarehouseConfig, settings: readonly Setting[] = SETTINGS) =>
  settings
    .flatMap(setting => (config[setting] === null ? [] : [shown[setting](config[setting]!)]))
    .join(' ')
