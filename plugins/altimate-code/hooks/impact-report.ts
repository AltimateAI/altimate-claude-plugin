// The end-of-task column impact: altimate-code's column answers read into a short summary for the band
// and a self-contained HTML report. Pure functions only; the hooks live in task-impact.tsx.

import type { PlanImpactView, Reach, TaskSummaryView } from '../types'
import { GRAPH_CSS, GRAPH_VIEW_JS, graphLayout } from './report-graph'
import { selectItems, touchedColumns } from './lineage-graph'

export type { PlanImpactView, Reach, TaskSummaryView }

/** One column answer from impact_analysis (`metadata.column_answer`, contract version 1). Any field may be absent. */
export type ColumnAnswer = {
  version?: number
  focus?: { model?: string; column?: string }
  direction?: string
  inputs?: { manifest?: unknown; sql?: string; catalog?: unknown; engine?: string; workarounds?: string[] }
  counts?: Record<string, unknown>
  nodes: { id?: string; name?: string; folder?: string; materialized?: string; contract?: boolean; tests?: number; exposures?: string[] }[]
  columns: { model: number; column: string; hop: number; end?: boolean; how?: string; how_from?: string; type?: string }[]
  /** [from, to, how], plus "name" when the how was inferred from matching names. */
  edges?: [number, number, string?, string?][]
  also_reads?: { model: number; columns?: string[]; downstream?: number }[]
  unresolved?: { model: number; reason?: string; downstream?: number }[]
  /** Models at the model level that do not carry the value: off the path, so not in `nodes`. */
  cleared?: { id?: string; name?: string }[]
  /** Exposures on the model or downstream, by what they read; `declared` counts the whole project's. */
  consumers?: { declared?: number; exposures?: RawExposure[] }
  flags?: { model: number; flag: string }[]
  truncated?: boolean
  next?: unknown
}

type RawExposure = { unique_id?: string; name?: string; label?: string; type?: string; url?: string; owner?: string; tier?: string; via?: string[] }

/** A model file the task changed, with the columns it changed (at most three). */
export type ModelChange = {
  model: string
  file: string
  root: string
  columns: { name: string; before: string | null; after: string | null }[]
  /** The file's fingerprint as the task ended, to tell whether it changed since. */
  ended?: string
}

export type ConsumerTier = 'carries' | 'may_carry' | 'cleared'
/** An exposure: `tier` says how the models it reads relate to the value; null when only a model was traced. */
export type Consumer = { id: string; label: string; type: string; url: string | null; owner: string | null; tier: ConsumerTier | null; via: string[]; columns: string[] }
/** `declared` is what the whole project declares; null when the answer did not say. */
export type ReportConsumers = { declared: number | null; error: string | null; list: Consumer[] }
/** Running text, with names set apart. */
export type Words = (string | { code: string })[]

/** A cheap fingerprint of a file's text. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

export const MAX_TASK_COLUMNS = 3
export const DEFAULT_LEVELS = 2
export const GLYPHS = ['=', '~', 'ƒ', 'Σ', '?'] as const
const RANK: Record<string, number> = { 'Σ': 4, 'ƒ': 3, '~': 2, '=': 1, '?': 0 }

/** A select item's expression for the header: the last scope's (the model's own select) when several share the name. */
const lastExpr = (items: Map<string, string>, name: string) => items.get(name)?.split('\u0000').pop()?.replace(/\s+/g, ' ').trim() ?? null

/**
 * The output columns one file's change touches, up to three, ranked as touchedColumns ranks them.
 * Empty when no output column changed (a filter, a join): the model-level count stands in.
 */
export function changedColumns(original: string, current: string): ModelChange['columns'] {
  const before = selectItems(original)
  const after = selectItems(current)
  // Only output columns whose select item was rewritten, added or removed: a column merely named on a
  // changed line (a filter, a join) keeps its value.
  const rewritten = [...new Set([...before.keys(), ...after.keys()])].filter(name => name !== '*' && before.get(name) !== after.get(name))
  return touchedColumns([original], [current], rewritten)
    .slice(0, MAX_TASK_COLUMNS)
    .map(name => ({ name, before: lastExpr(before, name), after: lastExpr(after, name) }))
}

/** The column answer in an impact_analysis result's metadata, or null when it carries none. */
export function answerOf(metadata: unknown): ColumnAnswer | null {
  const m = metadata as any
  const answer = m?.column_answer ?? (m?.version === 1 && m?.focus ? m : null)
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.columns) || !Array.isArray(answer.nodes)) return null
  return answer as ColumnAnswer
}

/** The model-level downstream count an impact_analysis result carries, with or without a column answer. */
export function modelLevelOf(metadata: unknown): number | null {
  const m = metadata as any
  const fromAnswer = num(answerOf(m)?.counts?.model_level)
  if (fromAnswer !== null) return fromAnswer
  const direct = num(m?.direct_count)
  const transitive = num(m?.transitive_count)
  return direct === null && transitive === null ? null : (direct ?? 0) + (transitive ?? 0)
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export type How = { glyph: string; byName: boolean }

/** A how as the contract spells it: its glyph, and whether the link was inferred from matching names rather than traced. */
export function parseHow(how: unknown, howFrom?: unknown): How {
  const text = typeof how === 'string' ? how : ''
  return { glyph: GLYPHS.find(one => text === one) ?? '?', byName: howFrom === 'name' }
}

/** The strongest derivation among several edges (aggregated, calculated, renamed, same, unknown); a traced one over one matched by name. */
function strongest(edges: NonNullable<ColumnAnswer['edges']>): How | null {
  const hows = edges.map(edge => parseHow(edge[2], edge[3]))
  const score = (one: How) => (RANK[one.glyph] ?? 0) * 2 + (one.byName ? 0 : 1)
  return hows.length ? hows.reduce((best, one) => (score(one) > score(best) ? one : best)) : null
}

/** How one column of an answer is derived: the edge that first reached it, else the strongest edge into it (downstream) or out of it (upstream). */
function howOf(answer: ColumnAnswer, index: number): How | null {
  const col = answer.columns[index]
  if (typeof col?.how === 'string' && col.how) return parseHow(col.how, col.how_from)
  const upstream = answer.direction === 'upstream'
  return strongest((answer.edges ?? []).filter(edge => Array.isArray(edge) && (upstream ? edge[0] === index : edge[1] === index)))
}

/** The focus column's own derivation, from the upstream answer: how it is made from what it reads. */
export function focusHow(upstream: ColumnAnswer | null): How | null {
  if (!upstream) return null
  const focus = upstream.columns.findIndex(one => one.hop === 0)
  if (focus < 0) return null
  return strongest((upstream.edges ?? []).filter(edge => Array.isArray(edge) && edge[1] === focus))
}

/** The downstream reach in counts, read from the answer's counts where it gives them, else counted. */
export function reachOf(answer: ColumnAnswer): Reach {
  const counts = answer.counts ?? {}
  const beyond = answer.columns.filter(one => one.hop > 0)
  const cleared = num(counts.cleared_models) ?? (Array.isArray(answer.cleared) ? answer.cleared.length : null)
  return {
    columns: num(counts.columns) ?? beyond.length,
    models: num(counts.models) ?? new Set(beyond.map(one => one.model)).size,
    ends: num(counts.ends) ?? beyond.filter(one => one.end).length,
    hops: num(counts.hops) ?? Math.max(0, ...answer.columns.map(one => one.hop)),
    mayCarry: num(counts.may_carry_models) ?? answer.also_reads?.length ?? 0,
    cleared,
    unresolved: num(counts.unresolved_models) ?? answer.unresolved?.length ?? 0,
    modelLevel: num(counts.model_level),
    truncated: answer.truncated === true,
  }
}

/** The downstream models that carry the value, each with the columns it lands in and its exposures, nearest first. */
export function carriersOf(answer: ColumnAnswer): { name: string; columns: string[]; exposures: string[] }[] {
  const byModel = new Map<number, { name: string; columns: string[]; exposures: string[]; hop: number }>()
  for (const col of answer.columns) {
    if (!(col.hop > 0)) continue
    const node = answer.nodes[col.model]
    const entry = byModel.get(col.model) ?? { name: String(node?.name ?? node?.id ?? col.model), columns: [], exposures: Array.isArray(node?.exposures) ? node!.exposures!.map(String) : [], hop: col.hop }
    if (!entry.columns.includes(String(col.column))) entry.columns.push(String(col.column))
    entry.hop = Math.min(entry.hop, col.hop)
    byModel.set(col.model, entry)
  }
  return [...byModel.values()].sort((a, b) => a.hop - b.hop || a.name.localeCompare(b.name)).map(({ hop: _hop, ...rest }) => rest)
}

/** What one impact_analysis result says about exposures, tiered when it carries a column answer. */
export function consumersOf(metadata: unknown): ReportConsumers {
  const m = metadata as any
  const answer = answerOf(m)
  const tiered = answer?.consumers?.exposures
  const raw: RawExposure[] = Array.isArray(tiered) ? tiered : Array.isArray(m?.exposures) ? m.exposures : []
  return {
    declared: num(answer?.consumers?.declared) ?? num(m?.exposures_declared),
    error: typeof m?.exposures_error === 'string' ? m.exposures_error : null,
    list: raw.map(one => ({
      id: String(one.unique_id ?? one.name ?? one.label ?? '?'),
      label: String(one.label ?? one.name ?? one.unique_id ?? '?'),
      type: String(one.type ?? 'exposure'),
      url: typeof one.url === 'string' && /^https?:\/\//i.test(one.url) ? one.url : null,
      owner: typeof one.owner === 'string' ? one.owner : null,
      tier: one.tier === 'carries' || one.tier === 'may_carry' || one.tier === 'cleared' ? one.tier : null,
      via: Array.isArray(one.via) ? one.via.map(String) : [],
      columns: [],
    })),
  }
}

const TIER_ORDER: (ConsumerTier | null)[] = ['carries', 'may_carry', 'cleared', null]

/** One list across every traced column: an exposure once, in its closest tier, naming the columns behind it. */
export function mergeConsumers(traces: ColumnTrace[]): ReportConsumers {
  const merged = new Map<string, Consumer>()
  for (const trace of traces) {
    for (const one of trace.consumers?.list ?? []) {
      const known = merged.get(one.id)
      const column = trace.column ? `${trace.model}.${trace.column}` : null
      if (!known || TIER_ORDER.indexOf(one.tier) < TIER_ORDER.indexOf(known.tier)) {
        merged.set(one.id, { ...one, columns: [...new Set([...(known?.columns ?? []), ...(column ? [column] : [])])] })
      } else if (column && !known.columns.includes(column)) {
        known.columns.push(column)
      }
    }
  }
  const declared = traces.map(one => one.consumers?.declared ?? null).filter((one): one is number => one !== null)
  return {
    declared: declared.length ? Math.max(...declared) : null,
    error: traces.map(one => one.consumers?.error ?? null).find(Boolean) ?? null,
    list: [...merged.values()].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.label.localeCompare(b.label)),
  }
}

/** The traced answers for one changed column: downstream and upstream, each null when not asked or failed. */
export type ColumnTrace = {
  model: string
  column: string | null
  down: ColumnAnswer | null
  up: ColumnAnswer | null
  modelLevel: number | null
  failed: boolean
  consumers?: ReportConsumers
}

/** The band's view of a finished task. */
export function summaryOf(changes: ModelChange[], traces: ColumnTrace[], report: string | null): TaskSummaryView {
  const unresolved = new Set<string>()
  let truncated = false
  const models = changes.map(change => {
    const mine = traces.filter(one => one.model === change.model)
    const modelLevel = mine.map(one => one.modelLevel ?? (one.down ? reachOf(one.down).modelLevel : null)).find(one => one !== null) ?? null
    const columns = mine
      .filter(one => one.column !== null)
      .map(one => {
        const reach = one.down ? reachOf(one.down) : null
        for (const entry of one.down?.unresolved ?? []) unresolved.add(one.down!.nodes[entry.model]?.id ?? one.down!.nodes[entry.model]?.name ?? String(entry.model))
        if (reach?.truncated) truncated = true
        return { name: one.column!, reach, failed: one.failed }
      })
    return { name: change.model, modelLevel, columns }
  })
  return { state: 'ready', models, unresolved: unresolved.size, truncated, report, openFailed: false }
}

/** The band's lines, as text: what the summary says, for the log and for tests. */
export function summaryLines(view: TaskSummaryView): string[] {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const lines = [`◆ Lineage after this task · ${plural(view.models.length, 'model')} changed`]
  for (const model of view.models) {
    lines.push(`${model.name}${model.modelLevel !== null ? ` · ${plural(model.modelLevel, 'downstream model')} at model level` : ''}`)
    if (model.columns.length === 0) lines.push('  no output column changed: the model-level count stands')
    for (const col of model.columns) {
      if (view.state === 'tracing' && !col.reach) lines.push(`  ${col.name}  tracing…`)
      else if (!col.reach) lines.push(`  ${col.name}  ${col.failed ? 'could not be traced' : 'no column answer'}`)
      else {
        const r = col.reach
        const parts = [`reaches ${plural(r.columns, 'column')} in ${plural(r.models, 'model')} (${plural(r.ends, 'end')})`]
        parts.push(`${r.mayCarry} may carry it`)
        if (r.cleared !== null) parts.push(`${r.cleared} cleared`)
        lines.push(`  ${col.name}  ${parts.join(' · ')}`)
      }
    }
  }
  if (view.unresolved > 0 || view.truncated) {
    const why = [view.unresolved ? `${plural(view.unresolved, 'model')} could not be read` : '', view.truncated ? 'the trace hit its limit' : ''].filter(Boolean).join('; ')
    lines.push(`⚠ Lower bound: ${why}`)
  } else if (view.state === 'ready' && view.models.some(one => one.columns.some(col => col.reach))) {
    lines.push('✓ Every downstream model was read')
  }
  return lines
}

/** The band's lines for a plan about to be approved or just approved: the models it names, at the model level. */
export function planLines(view: PlanImpactView): string[] {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const total = view.models.length + view.more
  const lines = [`◆ Before this plan · it names ${plural(total, 'dbt model')} · model level, nothing has changed yet`]
  for (const model of view.models) {
    if (view.state === 'tracing' && model.modelLevel === null && !model.failed) lines.push(`${model.name} · tracing…`)
    else if (model.failed) lines.push(`${model.name} · could not be read`)
    else {
      const parts = [`${plural(model.modelLevel ?? 0, 'downstream model')}`]
      if (model.tests !== null) parts.push(plural(model.tests, 'test'))
      if (model.exposures !== null) parts.push(model.exposures > 0 ? plural(model.exposures, 'exposure') : model.declared === 0 ? 'no exposures declared' : 'no exposures downstream')
      lines.push(`${model.name} · ${parts.join(' · ')}`)
    }
  }
  if (view.more > 0) lines.push(`… and ${view.more} more`)
  return lines
}

// ---------------------------------------------------------------------------------------------------
// The report: data the page draws from, then the page.

export type ReportColumn = { key: string; column: string; glyph: string; byName: boolean; end: boolean; type: string | null; hop: number }
export type ReportModel = {
  id: string
  name: string
  folder: string
  materialized: string
  contract: boolean
  tests: number
  exposures: string[]
  /** What the engine noted on the model, such as a filter it rewrote before analysis. */
  flags: string[]
  columns: ReportColumn[]
}
export type ReportSection = { hops: { hop: number; models: ReportModel[] }[]; truncated: boolean; error: string | null }
export type ReportFocus = {
  model: string
  column: string | null
  key: string | null
  glyph: string | null
  byName: boolean
  before: string | null
  after: string | null
  reach: Reach | null
  modelLevel: number | null
  /** What to expect downstream, in plain words. */
  impact: Words[]
  up: ReportSection
  down: ReportSection
  edges: [string, string, string][]
  alsoReads: { name: string; columns: string[]; downstream: number | null }[]
  unresolved: { name: string; reason: string; downstream: number | null }[]
  cleared: { names: string[]; count: number | null }
  inputs: { engine: string | null; workarounds: string[]; catalog: boolean; olderThanSql: boolean }
}
export type ReportData = {
  title: string
  finishedAt: string
  builtAt: string
  manifest: string
  /** Files that changed after the task ended. */
  movedOn: string[]
  defaultLevels: number
  changes: { model: string; file: string; columns: ModelChange['columns'] }[]
  focuses: ReportFocus[]
  consumers: ReportConsumers
}
/** When the task ended and the report was built, what was read, and what changed since. */
export type ReportTask = { finishedAt: string; builtAt: string; manifest: string; movedOn: string[] }

const keyOf = (answer: ColumnAnswer, index: number) => {
  const col = answer.columns[index]!
  const node = answer.nodes[col.model]
  return `${node?.id ?? node?.name ?? col.model}|${String(col.column).toLowerCase()}`
}
const nameOf = (answer: ColumnAnswer, index: number | undefined) => {
  const node = index === undefined ? undefined : answer.nodes[index]
  return String(node?.name ?? node?.id ?? index ?? '?')
}

/** One direction's columns beyond the focus, grouped by hop and then by model. */
export function sectionOf(answer: ColumnAnswer | null, failed = false): ReportSection {
  if (!answer) return { hops: [], truncated: false, error: failed ? 'This direction could not be traced.' : null }
  const byHop = new Map<number, Map<number, ReportModel>>()
  answer.columns.forEach((col, i) => {
    if (!(col.hop > 0)) return
    const node = answer.nodes[col.model] ?? {}
    const hop = byHop.get(col.hop) ?? new Map<number, ReportModel>()
    byHop.set(col.hop, hop)
    const model = hop.get(col.model) ?? {
      id: String(node.id ?? node.name ?? col.model),
      name: String(node.name ?? node.id ?? col.model),
      folder: String(node.folder ?? ''),
      materialized: String(node.materialized ?? ''),
      contract: node.contract === true,
      tests: num(node.tests) ?? 0,
      exposures: Array.isArray(node.exposures) ? node.exposures.map(String) : [],
      flags: [...new Set((answer.flags ?? []).filter(one => one?.model === col.model).map(one => String(one.flag).replace(/_/g, ' ')))],
      columns: [],
    }
    hop.set(col.model, model)
    const how = howOf(answer, i) ?? { glyph: '?', byName: false }
    model.columns.push({ key: keyOf(answer, i), column: String(col.column), glyph: how.glyph, byName: how.byName, end: col.end === true, type: col.type ?? null, hop: col.hop })
  })
  const hops = [...byHop.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hop, models]) => ({ hop, models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)) }))
  return { hops, truncated: answer.truncated === true, error: null }
}

const count = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

function namesList(names: string[], max = 5): Words {
  const shown = names.slice(0, max)
  const out: Words = []
  shown.forEach((name, i) => {
    if (i > 0) out.push(i === shown.length - 1 && names.length <= max ? ' and ' : ', ')
    out.push({ code: name })
  })
  if (names.length > max) out.push(` and ${names.length - max} more`)
  return out
}

/** What to expect downstream of one changed column (or model), in plain words. */
export function impactWords(model: string, column: string | null, trace: ColumnTrace | undefined): Words[] {
  const down = trace?.down ?? null
  const level = trace?.modelLevel ?? (down ? reachOf(down).modelLevel : null)
  const downstream: Words = level === null ? [] : level === 0 ? ['Nothing sits downstream of ', { code: model }, '. '] : [{ code: model }, ` has ${count(level, 'model')} downstream. `]
  if (!column) {
    if (level === null) return [['The downstream count could not be read for ', { code: model }, '.']]
    return [[...downstream, ...(level > 0 ? ["No output column changed (a filter or a join, say), so this can't say which of them are affected."] : [])]]
  }
  if (!down) return [[...downstream, 'The column ', { code: column }, ' could not be traced.']]
  const r = reachOf(down)
  const lines: Words[] = []
  const value = [...new Set(down.columns.filter(one => one.hop > 0).map(one => one.model))].map(index => down.nodes[index]).filter(Boolean)
  if (r.models > 0) lines.push([...downstream, 'The value of ', { code: column }, ` flows into ${r.models} of them, in ${count(r.columns, 'column')}. Expect those to change with it: `, ...namesList(carriersOf(down).map(one => one.name)), '.'])
  else if (level !== 0) lines.push([...downstream, 'The value of ', { code: column }, " doesn't flow into any column of theirs."])
  else lines.push(downstream)
  if (r.mayCarry > 0) lines.push([`${r.mayCarry} more may change: ${r.mayCarry === 1 ? 'it uses' : 'they use'} the value in a way the trace can't follow (a filter or a join, say), ${r.mayCarry === 1 ? 'its' : 'their'} SQL couldn't be read, or ${r.mayCarry === 1 ? 'it reads' : 'they read'} from a model like that.`])
  if (r.cleared) lines.push([`${r.cleared} shouldn't change: ${r.cleared === 1 ? "it's" : "they're"} downstream of the model, but the value doesn't reach ${r.cleared === 1 ? 'it' : 'them'}.`])
  const self = down.nodes[down.columns.find(one => one.hop === 0)?.model ?? -1]
  if (self?.contract) lines.push([{ code: model }, ' enforces a contract, so a type change can fail its build.'])
  const contracts = value.filter(one => one!.contract).map(one => String(one!.name ?? one!.id))
  if (contracts.length > 0) lines.push([`${contracts.length === 1 ? 'One model it reaches enforces' : `${contracts.length} models it reaches enforce`} a contract, so a type change can fail the build there: `, ...namesList(contracts), '.'])
  const tests = value.reduce((sum, one) => sum + (num(one!.tests) ?? 0), 0)
  if (tests > 0) lines.push([`Tests on the models it reaches: ${tests}.`])
  const short = [r.unresolved ? `${count(r.unresolved, "model")} couldn't be read` : '', r.truncated ? 'the trace hit its limit' : ''].filter(Boolean).join(' and ')
  lines.push([short ? `${short.charAt(0).toUpperCase()}${short.slice(1)}, so the real numbers can only be higher.` : 'Every downstream model was read.'])
  return lines
}

/** The page's data for one changed column (or one model, when no column changed). */
export function focusOf(change: ModelChange, column: ModelChange['columns'][number] | null, trace: ColumnTrace | undefined): ReportFocus {
  const down = trace?.down ?? null
  const up = trace?.up ?? null
  const any = down ?? up
  const focusIndex = any ? any.columns.findIndex(one => one.hop === 0) : -1
  const how = focusHow(up)
  const edges: [string, string, string][] = []
  for (const answer of [up, down]) {
    if (!answer) continue
    for (const edge of answer.edges ?? []) {
      if (!Array.isArray(edge) || !answer.columns[edge[0]] || !answer.columns[edge[1]]) continue
      edges.push([keyOf(answer, edge[0]), keyOf(answer, edge[1]), String(edge[2] ?? '?')])
    }
  }
  const clearedNames = (Array.isArray(down?.cleared) ? down!.cleared : []).map(one => String(one?.name ?? one?.id ?? '?'))
  const reach = down ? reachOf(down) : null
  const manifestInput = (down?.inputs ?? up?.inputs)?.manifest as any
  return {
    model: change.model,
    column: column?.name ?? null,
    key: any && focusIndex >= 0 ? keyOf(any, focusIndex) : null,
    glyph: how?.glyph ?? null,
    byName: how?.byName ?? false,
    before: column?.before ?? null,
    after: column?.after ?? null,
    reach,
    modelLevel: trace?.modelLevel ?? reach?.modelLevel ?? null,
    impact: impactWords(change.model, column?.name ?? null, trace),
    up: sectionOf(up, !up && !!column),
    down: sectionOf(down, !down && !!column),
    edges,
    alsoReads: (down?.also_reads ?? []).map(one => ({ name: nameOf(down!, one.model), columns: (one.columns ?? []).map(String), downstream: num(one.downstream) })),
    unresolved: (down?.unresolved ?? []).map(one => ({ name: nameOf(down!, one.model), reason: String(one.reason ?? 'not read'), downstream: num(one.downstream) })),
    cleared: { names: clearedNames, count: reach?.cleared ?? (clearedNames.length || null) },
    inputs: {
      engine: (down?.inputs ?? up?.inputs)?.engine ?? null,
      workarounds: [...new Set([...(down?.inputs?.workarounds ?? []), ...(up?.inputs?.workarounds ?? [])])].map(String),
      catalog: !!(down?.inputs ?? up?.inputs)?.catalog,
      olderThanSql: manifestInput?.older_than_sql === true,
    },
  }
}

/** Everything the report draws, from the task's changes and their traces. */
export function reportData(changes: ModelChange[], traces: ColumnTrace[], task: ReportTask): ReportData {
  const focuses: ReportFocus[] = []
  for (const change of changes) {
    if (change.columns.length === 0) focuses.push(focusOf(change, null, traces.find(one => one.model === change.model && one.column === null)))
    for (const col of change.columns) focuses.push(focusOf(change, col, traces.find(one => one.model === change.model && one.column === col.name)))
  }
  const names = changes.map(one => one.model)
  return {
    title: `Column impact · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`,
    ...task,
    defaultLevels: DEFAULT_LEVELS,
    changes: changes.map(one => ({ model: one.model, file: one.file, columns: one.columns })),
    focuses,
    consumers: mergeConsumers(traces),
  }
}

/** JSON safe to place inside a script element: no tag can close it early. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The report as one offline HTML file: inline CSS and JS, no external resources. */
export function reportHtml(data: ReportData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<link rel="icon" href="data:,">
<title>${escapeHtml(data.title)}</title>
<style>${REPORT_CSS}${GRAPH_CSS}</style>
</head>
<body>
<div id="app" data-levels="${data.defaultLevels}"></div>
<noscript><p class="noscript">This report draws itself with JavaScript; turn it on to see the lineage.</p></noscript>
<script type="application/json" id="report-data">${scriptJson(data)}</script>
<script>${REPORT_JS}</script>
</body>
</html>
`
}

const REPORT_CSS = `
:root{
  --bg:#f7f7f5;--panel:#ffffff;--ink:#1d1d1b;--muted:#6b6b66;--faint:#9a9a93;--line:#e4e3de;--line-strong:#cfcdc6;
  --accent:#3b5bdb;--accent-soft:#e8edff;--focus:#fff4d6;--focus-line:#e6b84a;
  --same:#2f7d4f;--same-bg:#e3f3e9;--ren:#2c62b8;--ren-bg:#e3ecfb;--calc:#a35c00;--calc-bg:#fbefdc;--agg:#7a3fb0;--agg-bg:#f0e6fa;--unk:#6b6b66;--unk-bg:#eeeeea;
  --warn:#9a5b00;--warn-bg:#fff3dc;--del:#b42318;--del-bg:#fdecea;--add:#1f7a43;--add-bg:#e6f5ec;
  --shadow:0 1px 2px rgba(0,0,0,.05),0 2px 8px rgba(0,0,0,.04);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#151515;--panel:#1e1e1d;--ink:#ecebe6;--muted:#a3a29b;--faint:#76756f;--line:#2f2f2d;--line-strong:#454540;
  --accent:#8ea6ff;--accent-soft:#25293b;--focus:#3a3220;--focus-line:#b48a2c;
  --same:#6fcf97;--same-bg:#1c3326;--ren:#8fb6ff;--ren-bg:#1d2a40;--calc:#f0b35c;--calc-bg:#3a2a12;--agg:#c79bf2;--agg-bg:#2f2240;--unk:#a3a29b;--unk-bg:#2a2a28;
  --warn:#f0b35c;--warn-bg:#352a15;--del:#ff8a80;--del-bg:#3a1f1d;--add:#7ddc9f;--add-bg:#1b3325;
  --shadow:none;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}
.wrap{max-width:1040px;margin:0 auto;padding:20px 16px 64px}
header.top{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:14px}
header.top h1{font-size:20px;margin:0;font-weight:650;letter-spacing:-.01em}
header.top .when{color:var(--muted);font-size:12.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow)}
.changes,.impact,.consumers{padding:14px 16px;margin-bottom:14px}
.changes h2,.impact h2,.consumers h2,.section h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px;font-weight:600}
.change-model{margin:8px 0 2px;font-weight:600;overflow-wrap:anywhere}
.change-model .file{color:var(--faint);font-weight:400;margin-left:6px;font-size:12px}
.diff{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:6px 0 10px;align-items:start}
.diff .col-name{font-weight:600;grid-row:span 2;padding-top:2px}
.diff .was,.diff .now{border-radius:6px;padding:3px 8px;overflow-wrap:anywhere;white-space:pre-wrap}
.diff .was{background:var(--del-bg);color:var(--del)}
.diff .now{background:var(--add-bg);color:var(--add)}
.diff .none{opacity:.7;font-style:italic}
.diff .same{grid-column:2;color:var(--muted);font-size:12.5px}
.impact h3{font-size:13px;font-weight:600;margin:10px 0 4px;overflow-wrap:anywhere}
.impact ul{margin:0;padding-left:18px}
.impact li{margin:5px 0}
.impact code,.consumers code{overflow-wrap:anywhere}
.consumers .tier{font-size:12.5px;font-weight:600;margin:10px 0 2px}
.consumers ul{margin:0 0 4px;padding-left:18px}
.consumers li{margin:3px 0;overflow-wrap:anywhere}
.consumers .why{color:var(--muted)}
.consumers .foot{color:var(--muted);font-size:12.5px;margin:10px 0 0}
.consumers a{color:var(--accent)}
.deep{margin:26px 0 12px;padding-top:16px;border-top:1px solid var(--line-strong)}
.deep h2{font-size:15px;font-weight:650;margin:0 0 2px}
.deep p{margin:0;color:var(--muted);font-size:13px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.tab{appearance:none;border:1px solid var(--line-strong);background:var(--panel);color:var(--ink);border-radius:999px;padding:5px 12px;font:inherit;cursor:pointer}
.tab[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:#fff}
@media (prefers-color-scheme:dark){.tab[aria-selected=true]{color:#111}}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:92px}
.stat b{display:block;font-size:18px;line-height:1.2}
.stat span{color:var(--muted);font-size:12px}
.stat.dim b{color:var(--muted)}
.note{border-radius:8px;padding:8px 12px;margin:0 0 12px;font-size:13px}
.note.warn{background:var(--warn-bg);color:var(--warn)}
.note.ok{background:var(--same-bg);color:var(--same)}
.inputs{color:var(--muted);font-size:12px;margin:-4px 0 14px}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--muted);font-size:12px;margin:0 0 14px}
.legend .g{margin-right:4px}
.section{margin:0 0 12px}
.section-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:18px 0 8px}
.section-head h2{flex:1}
.section-head h2{margin:0}
.more{appearance:none;border:1px dashed var(--line-strong);background:transparent;color:var(--accent);border-radius:8px;padding:4px 10px;font:inherit;font-size:12.5px;cursor:pointer}
.more:hover{background:var(--accent-soft)}
.hop{margin:0 0 10px}
.hop-label{font-size:12px;color:var(--muted);margin:0 0 6px;display:flex;align-items:center;gap:8px}
.hop-label::after{content:"";flex:1;border-top:1px solid var(--line)}
.models{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:8px}
.model{padding:9px 10px 6px;transition:opacity .15s}
.model-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin-bottom:4px}
.model-name{font-weight:600;overflow-wrap:anywhere}
.badge{font-size:11px;border-radius:4px;padding:0 5px;border:1px solid var(--line-strong);color:var(--muted);line-height:17px}
.badge.c{border-color:var(--accent);color:var(--accent);font-weight:700}
.badge.x{border-color:var(--agg);color:var(--agg)}
.badge.f{border-color:var(--warn);color:var(--warn);background:var(--warn-bg)}
.model-meta{color:var(--faint);font-size:11.5px;margin-bottom:4px}
.col{display:flex;align-items:center;gap:7px;width:100%;appearance:none;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:3px 4px;border-radius:6px;cursor:pointer}
.col:hover{background:var(--accent-soft)}
.col .name{overflow-wrap:anywhere;flex:1}
.col .type{color:var(--faint);font-size:11.5px}
.col .end{font-size:10.5px;color:var(--muted);border:1px solid var(--line-strong);border-radius:4px;padding:0 4px}
.g{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:5px;font-weight:700;font-size:12.5px;flex:none}
.g.same{color:var(--same);background:var(--same-bg)}
.g.ren{color:var(--ren);background:var(--ren-bg)}
.g.calc{color:var(--calc);background:var(--calc-bg)}
.g.agg{color:var(--agg);background:var(--agg-bg)}
.g.unk{color:var(--unk);background:var(--unk-bg)}
.g.byname{outline:1.5px dashed currentColor;outline-offset:-1.5px;background:transparent;opacity:.7}
.col .g.byname+.name{opacity:.8}
.focus{padding:12px 14px;border:1.5px solid var(--focus-line);background:var(--focus);margin:6px 0}
.focus .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.focus .title{font-size:17px;font-weight:650;margin:2px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.focus .col{width:auto;padding:2px 6px;display:inline-flex}
.empty{color:var(--muted);font-size:13px;padding:6px 2px}
details.fold{margin:8px 0;padding:0 12px}
details.fold summary{cursor:pointer;padding:10px 0;font-weight:600}
details.fold summary span{color:var(--muted);font-weight:400}
details.fold ul{margin:0 0 10px;padding-left:18px}
details.fold li{margin:3px 0}
details.fold .why{color:var(--muted)}
.pathbar{position:sticky;top:0;z-index:5;display:none;align-items:center;gap:10px;flex-wrap:wrap;background:var(--accent);color:#fff;padding:8px 14px;border-radius:0 0 10px 10px;margin:-20px 0 12px;font-size:13px}
@media (prefers-color-scheme:dark){.pathbar{color:#111}}
.pathbar button{appearance:none;border:1px solid currentColor;background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font:inherit;cursor:pointer}
body.hl .pathbar{display:flex}
body.hl .col:not(.on){opacity:.28}
body.hl .model:not(.has-on){opacity:.45}
body.hl .col.on{background:var(--accent-soft)}
body.hl .col.sel{outline:2px solid var(--accent)}
.noscript{padding:16px}
@media (max-width:560px){
  .wrap{padding:14px 12px 48px}
  header.top h1{font-size:17px}
  .models{grid-template-columns:1fr}
  .stat{min-width:0;flex:1 1 40%}
}
`

const REPORT_JS = `
(function(){
var DATA=JSON.parse(document.getElementById('report-data').textContent);
var app=document.getElementById('app');
var GLYPH={'=':'same','~':'ren','\\u0192':'calc','\\u03a3':'agg','?':'unk'};
var HOW={'=':'same value','~':'renamed','\\u0192':'calculated','\\u03a3':'aggregated','?':'unknown'};
var state={focus:0,levels:[],expanded:[],views:[],list:false,selected:null};
DATA.focuses.forEach(function(){state.levels.push({up:DATA.defaultLevels,down:DATA.defaultLevels});state.expanded.push({});state.views.push(null)});
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
function plural(n,w){return n+' '+w+(n===1?'':'s')}
function glyph(g,byName){var s=el('span','g '+(GLYPH[g]||'unk')+(byName?' byname':''),g||'?');s.title=(HOW[g]||'unknown')+(byName?' (matched by name, not traced through SQL)':'');return s}
function graphOf(f){var fwd={},back={};f.edges.forEach(function(e){(fwd[e[0]]=fwd[e[0]]||[]).push(e[1]);(back[e[1]]=back[e[1]]||[]).push(e[0])});return{fwd:fwd,back:back}}
function walk(start,adj){var seen={},q=[start];seen[start]=1;while(q.length){var k=q.shift();(adj[k]||[]).forEach(function(n){if(!seen[n]){seen[n]=1;q.push(n)}})}return seen}
function pathOf(f,key){var g=graphOf(f),up=walk(key,g.back),down=walk(key,g.fwd),all={};Object.keys(up).forEach(function(k){all[k]=1});Object.keys(down).forEach(function(k){all[k]=1});return{all:all,up:Object.keys(up).length-1,down:Object.keys(down).length-1}}
function colButton(c){var b=el('button','col');b.type='button';b.dataset.key=c.key;b.appendChild(glyph(c.glyph,c.byName));b.appendChild(el('span','name mono',c.column));if(c.type)b.appendChild(el('span','type',c.type));if(c.end){var e=el('span','end','end');e.title='Nothing further downstream reads it';b.appendChild(e)}b.addEventListener('click',function(ev){ev.stopPropagation();select(c.key)});return b}
function modelCard(m){var card=el('div','panel model');var head=el('div','model-head');head.appendChild(el('span','model-name mono',m.name));if(m.contract){var c=el('span','badge c','C');c.title='Contract enforced: a change to this column can fail its build';head.appendChild(c)}if(m.tests){head.appendChild(el('span','badge',plural(m.tests,'test')))}m.exposures.forEach(function(x){var b=el('span','badge x','\\u25a3 '+x);b.title='Exposure (dashboard or app) on this model';head.appendChild(b)});(m.flags||[]).forEach(function(x){var b=el('span','badge f',x);b.title='Noted by the engine: the trace through this model is less certain';head.appendChild(b)});card.appendChild(head);var meta=[m.folder,m.materialized].filter(Boolean).join(' \\u00b7 ');if(meta)card.appendChild(el('div','model-meta',meta));m.columns.forEach(function(c){card.appendChild(colButton(c))});return card}
function hopBlock(h,dir){var d=el('div','hop');var cols=h.models.reduce(function(n,m){return n+m.columns.length},0);d.appendChild(el('div','hop-label',(dir==='up'?'Reads from \\u00b7 ':'')+plural(h.hop,'hop')+' '+(dir==='up'?'up':'down')+' \\u00b7 '+plural(h.models.length,'model')+' \\u00b7 '+plural(cols,'column')));var grid=el('div','models');h.models.forEach(function(m){grid.appendChild(modelCard(m))});d.appendChild(grid);return d}
function section(f,i,dir){var sec=f[dir],lv=state.levels[i][dir],s=el('section','section');var head=el('div','section-head');head.appendChild(el('h2',null,dir==='up'?'Upstream: where it comes from':'Downstream: where it goes'));var total=sec.hops.length,hidden=sec.hops.filter(function(h){return h.hop>lv}).length;if(hidden>0){var more=el('button','more',hidden===1?'Show 1 more level':'Show more levels ('+hidden+' hidden)');more.type='button';more.addEventListener('click',function(){state.levels[i][dir]=lv+1;render()});head.appendChild(more);if(hidden>1){var all=el('button','more','Show all');all.type='button';all.addEventListener('click',function(){state.levels[i][dir]=Infinity;render()});head.appendChild(all)}}else if(total>DATA.defaultLevels&&lv>DATA.defaultLevels){var less=el('button','more','Back to '+DATA.defaultLevels+' levels');less.type='button';less.addEventListener('click',function(){state.levels[i][dir]=DATA.defaultLevels;render()});head.appendChild(less)}s.appendChild(head);if(sec.error){s.appendChild(el('div','empty',sec.error));return s}var shown=sec.hops.filter(function(h){return h.hop<=lv});if(!shown.length)s.appendChild(el('div','empty',dir==='up'?'Nothing upstream was traced for this column.':'No downstream model carries this column\\u2019s value.'));if(dir==='up')shown=shown.slice().reverse();shown.forEach(function(h){s.appendChild(hopBlock(h,dir))});if(sec.truncated)s.appendChild(el('div','note warn','The trace stopped at its limit: more may sit beyond the last level.'));return s}
function stat(n,label,dim){var d=el('div','stat'+(dim?' dim':''));d.appendChild(el('b',null,n==null?'\\u2013':n));d.appendChild(el('span',null,label));return d}
function fold(title,count,items){var d=el('details','panel fold');var s=el('summary',null,title+' ');s.appendChild(el('span',null,'('+(count==null?'not reported':count)+')'));d.appendChild(s);var ul=el('ul');items.forEach(function(it){ul.appendChild(it)});if(!items.length)ul.appendChild(el('li','why',count==null?'Not reported by this altimate-code build.':count?'Only the count is known.':'None.'));d.appendChild(ul);return d}
function li(name,rest){var l=el('li');l.appendChild(el('span','mono',name));if(rest){l.appendChild(document.createTextNode(' '));l.appendChild(el('span','why',rest))}return l}
function words(parent,line){line.forEach(function(w){if(typeof w==='string')parent.appendChild(document.createTextNode(w));else parent.appendChild(el('code',null,w.code))});return parent}
function impactPanel(){var p=el('div','panel impact');p.appendChild(el('h2',null,'What to expect downstream'));DATA.focuses.forEach(function(g){if(DATA.focuses.length>1)p.appendChild(el('h3','mono',g.column?g.model+'.'+g.column:g.model));var ul=el('ul');g.impact.forEach(function(line){ul.appendChild(words(el('li'),line))});p.appendChild(ul)});return p}
function consumerItem(c){var l=el('li');if(c.url){var a=el('a',null,c.label);a.href=c.url;a.rel='noopener noreferrer';a.target='_blank';l.appendChild(a)}else l.appendChild(document.createTextNode(c.label));var bits=[c.type];if(c.via.length)bits.push('reads '+c.via.join(', '));if(c.owner)bits.push('owner: '+c.owner);if(DATA.focuses.length>1&&c.columns.length)bits.push('for '+c.columns.join(', '));l.appendChild(el('span','why',' \\u00b7 '+bits.join(' \\u00b7 ')));return l}
var TIERS=[['carries','Read a model the value reaches'],['may_carry','Read a model that may carry it'],['cleared',"Read only models the value doesn't reach"],[null,'Read this model or one downstream of it']];
function consumersPanel(){var c=DATA.consumers,p=el('div','panel consumers');p.appendChild(el('h2',null,'Who consumes it'));
  if(c.error)p.appendChild(el('div','empty','The project\\u2019s exposures could not be read: '+c.error));
  else if(c.declared===null)p.appendChild(el('div','empty','This version of altimate-code does not report exposures, so consumers are unknown.'));
  else if(c.declared===0)p.appendChild(el('div','empty','This dbt project declares no exposures, so no dashboards or other consumers can be named. That does not mean nothing reads these tables.'));
  else if(!c.list.length)p.appendChild(el('div','empty','This dbt project declares '+plural(c.declared,'exposure')+', but none reads this model or anything downstream of it.'));
  TIERS.forEach(function(t){var mine=c.list.filter(function(x){return x.tier===t[0]});if(!mine.length)return;p.appendChild(el('div','tier',t[1]+' ('+mine.length+')'));var ul=el('ul');mine.forEach(function(x){ul.appendChild(consumerItem(x))});p.appendChild(ul)});
  p.appendChild(el('p','foot',(c.list.length?'dbt records which models an exposure reads, not which columns, so each may or may not use this one. ':'')+'Only exposures a dbt project declares can appear here: other BI tools and backend services do not.'));return p}
function render(){
  var f=DATA.focuses[state.focus],i=state.focus;app.textContent='';
  var bar=el('div','pathbar');bar.id='pathbar';var wrap=el('div','wrap');wrap.appendChild(bar);
  var top=el('header','top');top.appendChild(el('h1',null,DATA.title));top.appendChild(el('span','when','Task finished '+DATA.finishedAt+' \\u00b7 report built '+DATA.builtAt+' \\u00b7 read from '+DATA.manifest));wrap.appendChild(top);
  if(DATA.movedOn.length)wrap.appendChild(el('div','note warn','\\u26a0 Since this task ended, '+DATA.movedOn.join(', ')+(DATA.movedOn.length===1?' has':' have')+' changed. This report describes the task, not the files as they are now.'));
  var ch=el('div','panel changes');ch.appendChild(el('h2',null,'What this task changed'));DATA.changes.forEach(function(c){var m=el('div','change-model mono',c.model);m.appendChild(el('span','file',c.file));ch.appendChild(m);if(!c.columns.length){ch.appendChild(el('div','empty','No output column changed (a filter or a join): only the model-level count applies.'));return}var d=el('div','diff');c.columns.forEach(function(col){d.appendChild(el('div','col-name mono',col.name));var was=el('div','was mono'+(col.before?'':' none'),col.before||'(not in the model before)');var now=el('div','now mono'+(col.after?'':' none'),col.after||'(removed)');if(col.before&&col.after&&col.before===col.after){d.appendChild(el('div','same','Expression unchanged; the column is named on a changed line.'));d.appendChild(el('div'))}else{d.appendChild(was);d.appendChild(now)}});ch.appendChild(d)});
  var page=el('div','page'),side=el('div','side'),main=el('div','main');page.appendChild(side);page.appendChild(main);
  side.appendChild(ch);side.appendChild(impactPanel());side.appendChild(consumersPanel());
  var deep=el('div','deep');deep.appendChild(el('h2',null,'Column by column'));deep.appendChild(el('p',null,'Two levels up and down, with more on request. Click any column to light up its path; the rest dims and stays on the page.'));main.appendChild(deep);
  if(DATA.focuses.length>1){var tabs=el('div','tabs');tabs.setAttribute('role','tablist');DATA.focuses.forEach(function(g,j){var t=el('button','tab',g.column?g.model+'.'+g.column:g.model+' (model)');t.type='button';t.setAttribute('role','tab');t.setAttribute('aria-selected',j===i?'true':'false');t.addEventListener('click',function(){state.focus=j;state.selected=null;render()});tabs.appendChild(t)});main.appendChild(tabs)}
  var r=f.reach,stats=el('div','stats');
  if(r){stats.appendChild(stat(r.columns,'columns downstream'));stats.appendChild(stat(r.models,'models carry it'));stats.appendChild(stat(r.ends,'end columns'));stats.appendChild(stat(r.mayCarry,'may carry it',!r.mayCarry));stats.appendChild(stat(r.cleared,'cleared',r.cleared==null))}
  stats.appendChild(stat(f.modelLevel,'downstream at model level',true));main.appendChild(stats);
  if(r&&(r.unresolved||r.truncated))main.appendChild(el('div','note warn','\\u26a0 Lower bound: '+[r.unresolved?plural(r.unresolved,'model')+' could not be read':'',r.truncated?'the trace hit its limit':''].filter(Boolean).join('; ')+'. See \\u201cNot resolved\\u201d below.'));
  else if(r)main.appendChild(el('div','note ok','\\u2713 Every downstream model was read.'));
  var inp=[];if(f.inputs.engine)inp.push('engine '+f.inputs.engine);inp.push(f.inputs.catalog?'with catalog types':'no catalog: types from the manifest');if(f.inputs.olderThanSql)inp.push('the manifest is older than the SQL');main.appendChild(el('div','inputs',inp.join(' \\u00b7 ')));
  var lg=el('div','legend');['=','~','\\u0192','\\u03a3','?'].forEach(function(g){var s=el('span');s.appendChild(glyph(g,false));s.appendChild(document.createTextNode(HOW[g]));lg.appendChild(s)});var bn=el('span');bn.appendChild(glyph('=',true));bn.appendChild(document.createTextNode('matched by name'));lg.appendChild(bn);var cb=el('span');cb.appendChild(el('span','badge c','C'));cb.appendChild(document.createTextNode(' contract enforced'));lg.appendChild(cb);main.appendChild(lg);
  var graph=null;if(!state.list){graph=graphPanel(f,i);main.appendChild(graph)}else{var lb=el('div','g-bar list-bar');lb.appendChild(el('span','g-title','Column list'));var gb=el('button','g-btn','Graph');gb.type='button';gb.addEventListener('click',function(){state.list=false;render()});lb.appendChild(gb);main.appendChild(lb);
  main.appendChild(section(f,i,'up'));
  var fc=el('div','panel focus');fc.appendChild(el('div','label','The changed column'));var ti=el('div','title');if(f.key){ti.appendChild(colButton({key:f.key,column:f.model+'.'+(f.column||''),glyph:f.glyph||'?',byName:f.byName,end:false,type:null}))}else ti.appendChild(el('span','mono',f.column?f.model+'.'+f.column:f.model));fc.appendChild(ti);var hw=f.glyph?HOW[f.glyph]||'unknown':'';fc.appendChild(el('div','empty',(hw?hw.charAt(0).toUpperCase()+hw.slice(1)+' from what it reads'+(f.byName?' (matched by name)':'')+'. ':'')+(f.key?'Click any column to light up its path.':'')));main.appendChild(fc);
  main.appendChild(section(f,i,'down'))}
  wrap.appendChild(page);
  wrap.appendChild(fold('Also reads it, outside the select',f.alsoReads.length,f.alsoReads.map(function(a){return li(a.name,'reads '+a.columns.join(', ')+(a.downstream!=null?' \\u00b7 '+plural(a.downstream,'model')+' downstream of it':''))})));
  wrap.appendChild(fold('Not resolved',f.unresolved.length,f.unresolved.map(function(u){return li(u.name,u.reason+(u.downstream!=null?' \\u00b7 '+plural(u.downstream,'model')+' downstream of it':''))})));
  wrap.appendChild(fold('Cleared: downstream, but does not carry it',f.cleared.count,f.cleared.names.map(function(n){return li(n,'')})));
  if(f.inputs.workarounds.length)wrap.appendChild(fold('How the engine read the SQL',f.inputs.workarounds.length,f.inputs.workarounds.map(function(w){var l=el('li','why',w);return l})));
  app.appendChild(wrap);if(graph)graph.afterMount();applyHighlight();
}
function select(key){state.selected=state.selected===key?null:key;applyHighlight()}
function applyHighlight(){var f=DATA.focuses[state.focus],bar=document.getElementById('pathbar');var cols=document.querySelectorAll('.col,.g-row');var edges=document.querySelectorAll('.g-edge');if(!state.selected){document.body.classList.remove('hl');cols.forEach(function(c){c.classList.remove('on','sel')});edges.forEach(function(e){e.classList.remove('on')});document.querySelectorAll('.model,.g-box').forEach(function(m){m.classList.remove('has-on')});bar.textContent='';return}
  var p=pathOf(f,state.selected);document.body.classList.add('hl');cols.forEach(function(c){var on=!!p.all[c.dataset.key];c.classList.toggle('on',on);c.classList.toggle('sel',c.dataset.key===state.selected)});document.querySelectorAll('.model,.g-box').forEach(function(m){m.classList.toggle('has-on',!!m.querySelector('.col.on,.g-row.on'))});
  edges.forEach(function(e){var on=(e.getAttribute('data-keys')||'').split(' ').some(function(k){var ab=k.split('>');return !!(p.all[ab[0]]&&p.all[ab[1]])});e.classList.toggle('on',on)});
  var shown={};cols.forEach(function(c){shown[c.dataset.key]=1});var hidden=Object.keys(p.all).filter(function(k){return!shown[k]}).length;
  bar.textContent='';bar.appendChild(el('span',null,'Path of '+state.selected.split('|')[0].split('.').pop()+'.'+state.selected.split('|').pop()+': '+plural(p.up,'column')+' upstream, '+plural(p.down,'column')+' downstream'+(hidden?' \\u00b7 '+hidden+' more on hidden levels or folded models':'')));var clr=el('button',null,'Clear');clr.type='button';clr.addEventListener('click',function(){select(state.selected)});bar.appendChild(clr)}
${graphLayout.toString()}
${GRAPH_VIEW_JS}
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&state.selected)select(state.selected)});
render();
})();
`

/** The commands that may open a file in the person's browser, per platform, in the order to try them. */
export type Platform = 'mac' | 'linux' | 'wsl' | 'windows'
export type Opener = { argv: string[]; okExits: number[] }
export function openersFor(platform: Platform, path: string, wsl: { windowsPath?: string | null; explorerAtC?: boolean } = {}): Opener[] {
  if (platform === 'mac') return [{ argv: ['open', path], okExits: [0] }]
  if (platform === 'linux') return [{ argv: ['xdg-open', path], okExits: [0] }]
  if (platform === 'windows') return [{ argv: ['cmd', '/c', 'start', '', path], okExits: [0] }]
  // WSL: wslview when installed; else Windows' explorer.exe on the Windows form of the path, by name
  // (on PATH when Windows' folders are appended) and then where Windows keeps it; xdg-open last.
  // explorer.exe exits 1 even when it opened the file.
  const explorer = (bin: string): Opener => ({ argv: [bin, wsl.windowsPath!], okExits: [0, 1] })
  return [
    { argv: ['wslview', path], okExits: [0] },
    ...(wsl.windowsPath ? [explorer('explorer.exe'), ...(wsl.explorerAtC ? [explorer(WINDOWS_EXPLORER)] : [])] : []),
    { argv: ['xdg-open', path], okExits: [0] },
  ]
}
export const WINDOWS_EXPLORER = '/mnt/c/Windows/explorer.exe'
