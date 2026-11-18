// How /savings writes money, days and platforms, shared by the pane, the tool-row note and the report.
import type { SavingsPlatform, SavingsView } from '../types'

export const PLATFORM_NAME: Record<SavingsPlatform, string> = { databricks: 'Databricks', snowflake: 'Snowflake' }
export const PLATFORMS: readonly SavingsPlatform[] = ['databricks', 'snowflake']
export const DAY_MS = 86_400_000

function money(value: number, cents: boolean): string {
  const rounded = cents ? Math.round(value * 100) / 100 : Math.round(value)
  const [whole, fraction] = rounded.toFixed(cents ? 2 : 0).split('.')
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`
}

export function dollars(value: number): string {
  return money(value, value < 100)
}

/** To the cent, whatever the amount: for a figure small amounts are compared by. */
export function cents(value: number): string {
  return money(value, true)
}

/** Two monthly amounts and the gap between them, as a sentence that compares them shows them: all
 * three to the cent when any of them is under $100, so the gap it states is the gap between the
 * amounts it shows ("$19.05 instead of $125.50, $106.45 less", not "$19.05 instead of $126, $106
 * less"), and a small gap between large amounts is not shown as $0. */
export function compared(was: number, now: number): { was: string; now: string; gap: string } {
  const inCents = Math.abs(was) < 100 || Math.abs(now) < 100 || Math.abs(was - now) < 100
  const round = (value: number) => (inCents ? Math.round(value * 100) / 100 : Math.round(value))
  return { was: money(was, inCents), now: money(now, inCents), gap: money(Math.abs(round(was) - round(now)), inCents) }
}

export function range(min: number, max: number): string {
  return dollars(min) === dollars(max) ? dollars(max) : `${dollars(min)}–${dollars(max)}`
}

/** Free text from the workspace on one line, with control and invisible characters gone: one of them can blank the pane. */
export const oneLine = (value: unknown) =>
  String(value ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()

/**
 * Text as it may be drawn: control and invisible characters gone, spacing otherwise left alone. Names,
 * skip reasons and driver errors all reach the screen, and one escape character can blank a whole pane.
 */
export const cleanText = (text: string) => text.replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')

/** A drawing with every text and button label in it cleaned: the one place the pane and the band pass through. */
export function cleanTree<T>(node: T): T {
  if (typeof node === 'string') return cleanText(node) as T
  if (Array.isArray(node)) return node.map(cleanTree) as T
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown } | null
  if (!element || typeof element !== 'object' || !['Box', 'Text', 'Button'].includes(String(element.type))) return node
  const clean: typeof element = { ...element }
  if ('children' in element) clean.children = cleanTree(element.children)
  if (typeof element.props?.label === 'string') clean.props = { ...element.props, label: cleanText(element.props.label) }
  return clean as T
}

/** A finding's monthly figure: its range, or that it has none. */
export const amount = (min: number, max: number) => (max > 0 ? `${range(min, max)} a month` : 'no dollar estimate')

/** A size as the pane writes it: `2X_SMALL` is `2X-SMALL`. */
export const size = (value: unknown) => String(value ?? '?').replace(/_/g, '-')

export const count = (value: unknown) => Math.round(Number(value) || 0).toLocaleString('en-US')

/** Days a window covers, from its YYYY-MM-DD ends; 7 when they cannot be read. */
export function windowDays(window: { start: string; end: string }): number {
  const days = Math.round((Date.parse(window.end) - Date.parse(window.start)) / DAY_MS)
  return Number.isFinite(days) && days > 0 ? days : 7
}

const ROW_LIMIT: Record<SavingsPlatform, string> = { databricks: '10,000', snowflake: '100,000' }

/** What a run read only part of, as a sentence; null when it read everything. */
export function limitedText(view: Pick<SavingsView, 'platform' | 'limited'>): string | null {
  if (view.limited.length === 0) return null
  if (view.platform !== 'snowflake') return `Only the first ${ROW_LIMIT[view.platform]} ${view.limited.join(' and ')} were read; any beyond them were not checked.`
  // SHOW WAREHOUSES stops at its own limit; every other Snowflake read is by rows.
  const parts = view.limited.map(what => (what === 'warehouses' ? 'the first 9,999 warehouses' : `the first ${ROW_LIMIT.snowflake} rows of ${what}`))
  return `Only ${parts.join(' and ')} were read; any beyond them were not checked.`
}

/** What several kept answers add up to a month: each resource once, at its largest saving, even when two connections read the same account. */
export function combinedTotal(views: readonly SavingsView[]): { min: number; max: number; resources: number } {
  if (views.length === 1) return views[0]!.total
  const best = new Map<string, { min: number; max: number }>()
  for (const view of views) {
    for (const one of view.findings) {
      if (one.monthlyMax <= 0) continue
      const key = `${view.platform}:${view.scope ?? ''}:${one.workspaceId ?? ''}:${one.resourceType}:${one.resourceId}`
      const held = best.get(key)
      if (!held || one.monthlyMax > held.max) best.set(key, { min: one.monthlyMin, max: one.monthlyMax })
    }
  }
  let min = 0
  let max = 0
  for (const one of best.values()) {
    min += one.min
    max += one.max
  }
  return { min, max, resources: best.size }
}
