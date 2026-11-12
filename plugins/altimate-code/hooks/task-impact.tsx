// The end-of-task column impact: what a task changed in its dbt models, how far each changed column's
// value reaches, as one summary in the band, and a full offline report built when asked for. When a plan
// is put up for approval, the models it names, at the model level.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { PlanImpactView, TaskSummaryView } from '../types'
import { later, runAltimate } from './altimate-cli'
import {
  answerOf,
  changedColumns,
  columnReportData,
  type ColumnTrace,
  consumersOf,
  fingerprint,
  type ModelChange,
  modelLevelOf,
  openersFor,
  type Platform,
  planLines,
  reportData,
  reportHtml,
  summaryLines,
  summaryOf,
  WINDOWS_EXPLORER,
} from './impact-report'
import { projectLayout } from './lineage-graph'
import { modelsNamed, openPane, projectRoot, runTool, within } from './lineage'

export const REPORT_COMMAND = 'lineage-report'
// Under the project's target/, which dbt already keeps out of git.
const LINEAGE_DIR = 'target/.altimate-lineage'
// A task's copy of the manifest while it runs, and the last finished task's, kept for its report.
const RUNNING_MANIFEST = 'manifest-before.json'
const TASK_MANIFEST = 'task-manifest.json'
// What a report needs of the last finished task, so one can be built after a restart too.
const TASK_FILE = 'last-task.json'
// A report on one column, asked for by name; apart from the task's, which it never replaces.
const COLUMN_REPORT = 'column-report.html'
const REPORT_USAGE = 'Usage: /lineage-report for the last task\'s report, or /lineage-report <model>.<column> (say int_orders.amount) for where one column comes from and where it goes.'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
// The most changed models one task traces; the rest are named in the log.
const MAX_MODELS = 5
// Dirty files whose text is kept at a task's start, per project.
const MAX_DIRTY = 200
// The most impact_analysis calls running at once at a task's end.
const PARALLEL = 4
// Lines the band shows before pointing at the report.
const MAX_BAND_LINES = 8

const summaryAtom = atom({ plugin: 'altimate-code', key: 'lineageTaskSummary' } as const, null, { shape: 'lineage-task-summary-1' })
const planAtom = atom({ plugin: 'altimate-code', key: 'lineagePlanImpact' } as const, null, { shape: 'lineage-plan-impact-1' })
const hiddenAtom = atom({ plugin: 'altimate-code', key: 'isLineageSummaryHidden' } as const, false)

type Layout = { models: string[] }
type GitStart = { top: string; dirty: Map<string, string | null> }
type RootState = { snapshot: string | null; layout: Layout; git: GitStart | null }
type Task = { roots: Map<string, Promise<RootState>>; originals: Map<string, { root: string; text: string }> }

/** The last task that changed a model: all a report needs, frozen as the task ended. */
type Finished = {
  finishedAt: number
  changes: ModelChange[]
  /** Each project's copy of the manifest from the task's start; null when there was none. */
  manifests: Record<string, string | null>
  /** The downstream answers, once asked for; a restart loses them. */
  downs: Promise<ColumnTrace[]> | null
  /** Both directions, once a report asked for them. */
  full: Promise<ColumnTrace[]> | null
}

// The task under way: from a main-loop turn's start to its end.
let task: Task | null = null
let finished: Finished | null = null
let finishSeq = 0
let planSeq = 0

const newTask = (): Task => ({ roots: new Map(), originals: new Map() })
const relative = (root: string, path: string) => path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
const modelName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.sql$/i, '')

/** Whether a project-relative path is a model's SQL. */
function isModelFile(layout: Layout, rel: string): boolean {
  if (!/\.sql$/i.test(rel)) return false
  return layout.models.some(dir => {
    const clean = dir.replace(/^\.\//, '').replace(/\/+$/, '')
    return clean === '.' || clean === '' || rel.startsWith(`${clean}/`)
  })
}

async function git($: EngineInterface, args: string[]): Promise<string | null> {
  const result = await $.process.run(['git', ...args], { timeoutMs: 10_000 }).catch(() => null)
  return result && result.exitCode === 0 ? result.stdout : null
}

/** The project's model SQL that differs from HEAD, tracked or new, as absolute paths. */
async function changedSql($: EngineInterface, top: string, root: string, layout: Layout): Promise<string[]> {
  const tracked = (await git($, ['-C', top, 'diff', '--name-only', 'HEAD'])) ?? ''
  const fresh = (await git($, ['-C', top, 'ls-files', '--others', '--exclude-standard'])) ?? ''
  const paths = [...tracked.split('\n'), ...fresh.split('\n')].map(one => one.trim()).filter(Boolean)
  return [...new Set(paths.map(one => `${top}/${one}`))].filter(abs => abs.startsWith(`${root}/`) && isModelFile(layout, relative(root, abs)))
}

/**
 * A project the task works in, once per task: the manifest copied as it stands (so the answer reads
 * the SQL from before the task, even when Claude recompiles mid-task), the model folders, and the
 * text of each model file git already sees as changed (so only this task's changes are reported).
 */
function prepareRoot($: EngineInterface, t: Task, root: string): Promise<RootState> {
  const known = t.roots.get(root)
  if (known) return known
  const work = (async (): Promise<RootState> => {
    const layout = projectLayout(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
    // Models only: impact_analysis does not take a snapshot as the column's model.
    const models = { models: layout.models }
    let snapshot: string | null = null
    const manifest = `${root}/target/manifest.json`
    if (await $.fs.exists(manifest).catch(() => false)) {
      // The manifest can be far over the 4 MiB a plugin reads, so it is copied, never read.
      const dir = `${root}/${LINEAGE_DIR}`
      const made = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5_000 }).catch(() => null)
      const copied = made?.exitCode === 0 ? await $.process.run(['cp', manifest, `${dir}/${RUNNING_MANIFEST}`], { timeoutMs: 20_000 }).catch(() => null) : null
      if (copied?.exitCode === 0) snapshot = `${dir}/${RUNNING_MANIFEST}`
    }
    const top = (await git($, ['-C', root, 'rev-parse', '--show-toplevel']))?.trim()
    let gitStart: GitStart | null = null
    if (top) {
      const dirty = new Map<string, string | null>()
      for (const abs of (await changedSql($, top, root, models)).slice(0, MAX_DIRTY)) dirty.set(abs, await $.fs.read(abs).catch(() => null))
      gitStart = { top, dirty }
    }
    return { snapshot, layout: models, git: gitStart }
  })()
  t.roots.set(root, work)
  return work
}

/** Every model file the task changed, with its text before the task and now. */
async function collectChanges($: EngineInterface, t: Task): Promise<ModelChange[]> {
  const files = new Map<string, { root: string; original: string }>()
  for (const [file, one] of t.originals) files.set(file, { root: one.root, original: one.text })
  // Files changed some other way (a Bash sed, a script): git knows them, and HEAD or the start of the
  // task has their text before.
  for (const [root, pending] of t.roots) {
    const state = await pending.catch(() => null)
    if (!state?.git) continue
    for (const abs of await changedSql($, state.git.top, root, state.layout)) {
      if (files.has(abs)) continue
      const atStart = state.git.dirty.get(abs)
      // Dirty at the start but past the number kept: what it was is unknown, so it is left out.
      if (atStart === undefined && state.git.dirty.size >= MAX_DIRTY) continue
      const original = atStart !== undefined ? atStart : ((await git($, ['-C', state.git.top, 'show', `HEAD:${relative(state.git.top, abs)}`])) ?? '')
      if (original === null) continue
      files.set(abs, { root, original })
    }
  }
  const changes: ModelChange[] = []
  for (const [file, one] of files) {
    const state = await t.roots.get(one.root)?.catch(() => null)
    if (state && !isModelFile(state.layout, relative(one.root, file))) continue
    const current = await $.fs.read(file).catch(() => '')
    if (current === one.original) continue
    changes.push({ model: modelName(file), file: relative(one.root, file), root: one.root, columns: changedColumns(one.original, current), ended: fingerprint(current) })
  }
  if (changes.length > MAX_MODELS) $.ui.log(`lineage-summary · ${changes.length} models changed; tracing the first ${MAX_MODELS}`)
  return changes.slice(0, MAX_MODELS)
}

/** Runs the work items at most `limit` at a time, keeping their order. */
async function pool<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await items[i]!()
      }
    }),
  )
  return out
}

/** The copy of the manifest a project's answers read: the task's own, else the project's as it is now. */
const manifestOf = (done: Finished, root: string) => done.manifests[root] ?? `${root}/target/manifest.json`

/** One impact_analysis call for a change; null when it failed. */
async function ask($: EngineInterface, done: Finished, change: ModelChange, column: string | null, direction: 'downstream' | 'upstream') {
  // Known limit: the model goes by its file name, which misses a versioned model (x_v2.sql) or a file
  // named apart from its model.
  const args = { manifest_path: manifestOf(done, change.root), model: change.model, ...(column && { column }), change_type: 'modify', direction }
  // Through the CLI: nobody asked for these calls by name, and a call over MCP can raise a permission dialog.
  const result = await runTool($, 'impact_analysis', args, true).catch(() => null)
  return result?.ok ? result.metadata : null
}

/** What the band needs: each changed column's downstream answer, and the model-level count for a model with none. */
async function traceDown($: EngineInterface, done: Finished): Promise<ColumnTrace[]> {
  const jobs: (() => Promise<ColumnTrace>)[] = []
  for (const change of done.changes) {
    if (change.columns.length === 0) {
      jobs.push(async () => {
        const meta = await ask($, done, change, null, 'downstream')
        return { model: change.model, column: null, down: null, up: null, modelLevel: modelLevelOf(meta), failed: meta === null, consumers: consumersOf(meta) }
      })
    }
    for (const col of change.columns) {
      jobs.push(async () => {
        const meta = await ask($, done, change, col.name, 'downstream')
        const down = answerOf(meta)
        // An altimate-code from before the column answer gives neither the answer nor its error.
        const stale = !!meta && !down && (meta as any).column_answer === undefined && (meta as any).column_answer_error === undefined
        return { model: change.model, column: col.name, down, up: null, modelLevel: modelLevelOf(meta), failed: !down && !stale, stale, consumers: consumersOf(meta) }
      })
    }
  }
  return pool(jobs, PARALLEL)
}

/** What a report adds: where each changed column comes from. */
async function traceFull($: EngineInterface, done: Finished): Promise<ColumnTrace[]> {
  const downs = await (done.downs ??= traceDown($, done))
  const jobs = downs.map(trace => async () => {
    if (!trace.column) return trace
    const change = done.changes.find(one => one.model === trace.model)!
    return { ...trace, up: answerOf(await ask($, done, change, trace.column, 'upstream')) }
  })
  return pool(jobs, PARALLEL)
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** Moves each project's copy of the manifest out of the next task's way. */
async function freezeManifests($: EngineInterface, t: Task, changes: ModelChange[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const root of new Set(changes.map(one => one.root))) {
    const state = await t.roots.get(root)?.catch(() => null)
    if (!state?.snapshot) {
      out[root] = null
      continue
    }
    const frozen = `${root}/${LINEAGE_DIR}/${TASK_MANIFEST}`
    const moved = await $.process.run(['mv', '-f', state.snapshot, frozen], { timeoutMs: 5_000 }).catch(() => null)
    out[root] = moved?.exitCode === 0 ? frozen : state.snapshot
  }
  return out
}

const reportPathOf = (done: Finished) => `${done.changes[0]!.root}/${LINEAGE_DIR}/report.html`

/** At a task's end: what changed, traced downstream and summed up in the band. The report waits until it is asked for. */
async function finishTask($: EngineInterface, t: Task) {
  const seq = ++finishSeq
  const changes = await collectChanges($, t)
  if (changes.length === 0) return
  const tracing: TaskSummaryView = {
    state: 'tracing',
    models: changes.map(one => ({ name: one.model, modelLevel: null, columns: one.columns.map(col => ({ name: col.name, reach: null, failed: false })) })),
    unresolved: 0,
    truncated: false,
    report: null,
    openFailed: false,
  }
  await update($, summaryAtom, () => tracing)
  await update($, planAtom, () => null)
  await update($, hiddenAtom, () => false)
  const done: Finished = { finishedAt: await $.clock.now(), changes, manifests: await freezeManifests($, t, changes), downs: null, full: null }
  const root = changes[0]!.root
  // The last task's report is no longer the last task's.
  await $.process.run(['rm', '-f', reportPathOf(done)], { timeoutMs: 5_000 }).catch(() => null)
  finished = done
  await $.fs
    .write(`${root}/${LINEAGE_DIR}/${TASK_FILE}`, JSON.stringify({ version: 1, finishedAt: done.finishedAt, changes, manifests: done.manifests }))
    .catch(error => $.ui.log(`lineage-summary · the task could not be saved: ${String(error)}`, { to: 'debug' }))
  const traces = await (done.downs = traceDown($, done))
  // A newer task finished first: its summary stays.
  if (seq !== finishSeq) return
  const view = summaryOf(changes, traces, null)
  await update($, summaryAtom, () => view)
  reportEvent($, 'summary_shown')
  // One line: a log line draws a newline as a replacement glyph.
  $.ui.log(summaryLines(view).map(line => line.trim()).join(' · '))
}

export type ReportAction = 'summary_shown' | 'open_pressed' | 'command_run' | 'built' | 'build_failed' | 'no_browser'

/**
 * One usage event about the report, through altimate-code's telemetry (`tool report-event`), in the
 * background. It carries the action and this session's id only, and the CLI drops it under the telemetry
 * opt-out; an altimate-code without the command refuses it, and nothing else happens.
 */
export function reportEvent($: EngineInterface, action: ReportAction) {
  later($, async () => {
    const id = await $.session.id()
    await runAltimate($, ['tool', 'report-event', action, '--session', `claude:${id}`], 15_000).catch(() => null)
  })
}

/** The last task that changed a model: this session's, else the one a project's saved file names. */
async function lastTask($: EngineInterface): Promise<Finished | null> {
  if (finished) return finished
  const own = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
  if (!own) return null
  const text = await $.fs.read(`${own}/${LINEAGE_DIR}/${TASK_FILE}`).catch(() => null)
  if (!text) return null
  try {
    const saved = JSON.parse(text)
    if (saved?.version !== 1 || !Array.isArray(saved.changes) || saved.changes.length === 0) return null
    return (finished = { finishedAt: Number(saved.finishedAt), changes: saved.changes, manifests: saved.manifests ?? {}, downs: null, full: null })
  } catch {
    return null
  }
}

/** The files a task changed that differ now from how it left them. */
async function movedOn($: EngineInterface, done: Finished): Promise<string[]> {
  const out: string[] = []
  for (const change of done.changes) {
    const now = await $.fs.read(`${change.root}/${change.file}`).catch(() => '')
    if (change.ended && fingerprint(now) !== change.ended) out.push(change.file)
  }
  return out
}

/** Builds the report of a finished task; what it reads was frozen as the task ended, so later turns don't change it. */
async function buildReport($: EngineInterface, done: Finished): Promise<{ path: string } | { error: string }> {
  const missing: string[] = []
  for (const [root, frozen] of Object.entries(done.manifests)) {
    if (frozen && !(await $.fs.exists(frozen).catch(() => false))) {
      // Its copy is gone (`dbt clean`, say): the project's manifest as it is now, or nothing.
      done.manifests[root] = null
      done.downs = null
      done.full = null
    }
    if (!done.manifests[root] && !(await $.fs.exists(`${root}/target/manifest.json`).catch(() => false))) missing.push(root)
  }
  if (missing.length > 0) return { error: `The manifest this task was read from is gone. Run \`dbt compile\` and ask again.` }
  const traces = await (done.full ??= traceFull($, done))
  const allRead = traces.every(one => !one.column || (one.down && one.up))
  // A failed direction is asked again next time.
  if (!allRead) {
    done.full = null
    done.downs = null
  }
  const frozen = Object.values(done.manifests).every(Boolean)
  const data = reportData(done.changes, traces, {
    finishedAt: stamp(done.finishedAt),
    builtAt: stamp(await $.clock.now()),
    manifest: frozen ? 'the manifest as it was when the task started' : 'target/manifest.json as it is now, as the copy from the task\'s start is gone',
    movedOn: await movedOn($, done),
  })
  const path = reportPathOf(done)
  try {
    await $.fs.write(path, reportHtml(data))
    return { path }
  } catch (error) {
    return { error: `The report could not be written: ${String(error)}` }
  }
}

/** The models a plan names and what sits downstream of each, for the person deciding on it. Holds nothing back. */
async function planReady($: EngineInterface, e: { plan?: unknown; planFilePath?: unknown }) {
  const seq = ++planSeq
  // The engine hands the hook the plan's text, though the tool's input type leaves it out; its file is the fallback.
  const text = typeof e.plan === 'string' && e.plan ? e.plan : await $.fs.read(String(e.planFilePath ?? '')).catch(() => '')
  if (!text) return
  const root = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
  if (!root) return
  const named = (await modelsNamed($, text, root)).filter(one => one.id.startsWith('model.'))
  if (named.length === 0) return
  const shown = named.slice(0, MAX_MODELS)
  const models = shown.map(one => ({ name: one.name, modelLevel: null, tests: null, exposures: null, declared: null, failed: false }))
  const more = named.length - shown.length
  const tracing: PlanImpactView = { state: 'tracing', models, more }
  await update($, planAtom, () => tracing)
  await update($, hiddenAtom, () => false)
  const looked = await pool(
    shown.map(one => async () => {
      const args = { manifest_path: `${root}/target/manifest.json`, model: one.id, change_type: 'modify', direction: 'downstream' }
      // Through the CLI: over MCP this could raise a permission dialog on top of the plan's.
      const result = await runTool($, 'impact_analysis', args, true).catch(() => null)
      const meta = result?.ok ? (result.metadata as any) : null
      const consumers = consumersOf(meta)
      return {
        name: one.name,
        modelLevel: modelLevelOf(meta),
        tests: typeof meta?.test_count === 'number' ? meta.test_count : null,
        exposures: meta && !consumers.error ? consumers.list.length : null,
        declared: consumers.declared,
        failed: modelLevelOf(meta) === null,
      }
    }),
    PARALLEL,
  )
  if (seq !== planSeq) return
  const view: PlanImpactView = { state: 'ready', models: looked, more }
  await update($, planAtom, () => view)
  // In the transcript too: the band is not drawn while the approval dialog is up, and this line is.
  $.ui.log(planLines(view).map(line => line.trim()).join(' · '))
}

/** Which opener family this machine has: macOS, Linux, WSL (Linux under Windows), or Windows itself. */
async function platformOf($: EngineInterface): Promise<Platform> {
  // -r too: a WSL kernel's release names Microsoft, with no environment variable needed.
  const uname = await $.process.run(['uname', '-sr'], { timeoutMs: 5_000 }).catch(() => null)
  if (!uname || uname.exitCode !== 0) return 'windows'
  if (/darwin/i.test(uname.stdout)) return 'mac'
  if (/microsoft/i.test(uname.stdout)) return 'wsl'
  if (await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)) return 'wsl'
  return /microsoft/i.test(await $.fs.read('/proc/version').catch(() => '')) ? 'wsl' : 'linux'
}

/** Opens the report in the person's browser; false when no opener worked. */
export async function openReport($: EngineInterface, path: string): Promise<boolean> {
  const platform = await platformOf($)
  let wsl = {}
  if (platform === 'wsl') {
    const windows = await $.process.run(['wslpath', '-w', path], { timeoutMs: 5_000 }).catch(() => null)
    wsl = { windowsPath: windows?.exitCode === 0 ? windows.stdout.trim() || null : null, explorerAtC: await $.fs.exists(WINDOWS_EXPLORER).catch(() => false) }
  }
  // The first that starts and exits as it does on success; one that cannot start, or fails, gives way to the next.
  for (const opener of openersFor(platform, path, wsl)) {
    const result = await $.process.run(opener.argv, { timeoutMs: 15_000 }).catch(() => null)
    if (result && opener.okExits.includes(result.exitCode)) return true
  }
  return false
}

/** Builds the last task's report and opens it, for the button and the command; what to say about it. */
async function buildAndOpen($: EngineInterface): Promise<string> {
  const done = await lastTask($)
  if (!done) return 'No column impact report yet: one can be built after a task changes a dbt model.'
  await update($, summaryAtom, view => (view ? { ...view, building: true, openFailed: false } : view))
  const built = await buildReport($, done)
  if ('error' in built) {
    reportEvent($, 'build_failed')
    await update($, summaryAtom, view => (view ? { ...view, building: false } : view))
    $.ui.toast(built.error)
    return built.error
  }
  const opened = await openReport($, built.path)
  reportEvent($, opened ? 'built' : 'no_browser')
  await update($, summaryAtom, view => (view ? { ...view, building: false, report: built.path, openFailed: !opened } : view))
  return opened ? `Opened the column impact report for the task that finished at ${stamp(done.finishedAt)}: ${built.path}` : `No browser could be opened. The report is at ${built.path}`
}

/** What /lineage-report was asked for: the last task's report, one column's, or something it can't read. */
export function reportRequest(args: string): { kind: 'task' } | { kind: 'column'; model: string; column: string } | { kind: 'usage' } {
  const text = args.trim()
  if (!text) return { kind: 'task' }
  // The column is what follows the last dot, so the model can be a name or a unique id (model.shop.int_orders).
  const dot = text.lastIndexOf('.')
  if (/\s/.test(text) || dot <= 0 || dot === text.length - 1) return { kind: 'usage' }
  return { kind: 'column', model: text.slice(0, dot), column: text.slice(dot + 1) }
}

/** Traces one column both ways in the project's manifest as it is now and writes its report; a plain error when it can't. */
async function buildColumnReport($: EngineInterface, model: string, column: string): Promise<{ path: string; name: string } | { error: string }> {
  const root = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
  if (!root) return { error: 'No dbt project here: /lineage-report <model>.<column> reads the target/manifest.json of the dbt project this session runs in.' }
  const manifest = `${root}/target/manifest.json`
  if (!(await $.fs.exists(manifest).catch(() => false))) return { error: 'This project has no target/manifest.json yet. Run `dbt parse` or `dbt compile`, then ask again.' }
  const args = { manifest_path: manifest, model, column, change_type: 'modify' }
  // Through the CLI, as for a task: nobody asked for these calls by name.
  const [down, up] = await Promise.all((['downstream', 'upstream'] as const).map(direction => runTool($, 'impact_analysis', { ...args, direction }, true).catch(() => null)))
  for (const result of [down, up]) {
    const meta = result?.metadata as any
    // The model isn't in the manifest: the CLI's own words, which name some that are.
    if (meta?.success === false && result?.text) return { error: result.text.split('\n')[0]! }
    if (typeof meta?.column_answer_error === 'string') return { error: meta.column_answer_error }
  }
  if (!down?.ok || !up?.ok) return { error: `The lineage of ${model}.${column} could not be traced${down?.text || up?.text ? `: ${(down?.text || up?.text)!.split('\n')[0]}` : ''}.` }
  const downAnswer = answerOf(down.metadata)
  const upAnswer = answerOf(up.metadata)
  if (!downAnswer && !upAnswer) return { error: 'This altimate-code traces no single column. Update it to use /lineage-report <model>.<column>.' }
  const name = typeof (down.metadata as any)?.model === 'string' ? String((down.metadata as any).model) : model
  const trace: ColumnTrace = { model: name, column, down: downAnswer, up: upAnswer, modelLevel: modelLevelOf(down.metadata), failed: false, consumers: consumersOf(down.metadata) }
  const data = columnReportData(name, column, trace, { builtAt: stamp(await $.clock.now()), manifest: 'target/manifest.json as it is now' })
  const path = `${root}/${LINEAGE_DIR}/${COLUMN_REPORT}`
  try {
    await $.process.run(['mkdir', '-p', `${root}/${LINEAGE_DIR}`], { timeoutMs: 5_000 }).catch(() => null)
    await $.fs.write(path, reportHtml(data))
    return { path, name: `${name}.${column}` }
  } catch (error) {
    return { error: `The report could not be written: ${String(error)}` }
  }
}

/** /lineage-report <model>.<column>: builds that column's report and opens it; what to say about it. Leaves the band alone. */
async function openColumnReport($: EngineInterface, model: string, column: string): Promise<string> {
  $.ui.toast(`Tracing ${model}.${column} both ways…`)
  const built = await buildColumnReport($, model, column)
  if ('error' in built) {
    reportEvent($, 'build_failed')
    return built.error
  }
  const opened = await openReport($, built.path)
  reportEvent($, opened ? 'built' : 'no_browser')
  return opened ? `Opened the column lineage report for ${built.name}: ${built.path}` : `No browser could be opened. The report is at ${built.path}`
}

/** Registers /lineage-report; called from the plugin's one session.start hook. */
export async function startTaskImpact($: EngineInterface) {
  task = null
  finished = null
  await update($, summaryAtom, () => null)
  await update($, planAtom, () => null)
  await $.command.register({
    name: REPORT_COMMAND,
    description: 'Open the column impact report of the last task that changed a dbt model, or with model.column, where that column comes from and where it goes',
    argumentHint: '[model.column]',
  })
}

type Ui = { Box: any; Button: any; Text: any; Link?: any }

/** The summary of the last task that changed a model, or a plan's models; drawn by the plugin's one band hook. */
export async function taskBand($: EngineInterface, ui: Ui): Promise<RenderElement | null> {
  if (await read($, hiddenAtom)) return null
  const view = await read($, summaryAtom)
  const plan = await read($, planAtom)
  if (!view && !plan) return null
  const { Box, Button, Link, Text } = ui
  const lines = view ? summaryLines(view) : planLines(plan!)
  const shown = lines.length > MAX_BAND_LINES ? [...lines.slice(0, MAX_BAND_LINES - 1), `… ${lines.length - MAX_BAND_LINES + 1} more lines in the report`] : lines
  const report = view?.report ?? null
  return (
    <Box key="lineage-summary" flexDirection="column">
      {shown.map((line, i) => (
        <Text
          key={`lineage-summary-${i}`}
          color={i === 0 ? 'claude' : line.startsWith('⚠') ? 'warning' : line.startsWith('✓') ? 'success' : undefined}
          bold={i === 0 || (!line.startsWith(' ') && !line.startsWith('⚠') && !line.startsWith('✓') && !line.startsWith('…'))}
          dimColor={line.startsWith('…')}
        >
          {line}
        </Text>
      ))}
      {view?.building ? <Text dimColor>Building the report…</Text> : null}
      {report && view?.openFailed ? (
        <Text dimColor>
          No browser opened. Report: {Link ? <Link href={`file://${report}`}>{report}</Link> : report}
        </Text>
      ) : null}
      <Box>
        {view?.state === 'ready' ? <Button key="lineage-report-open" label="Open report" onPress={() => (reportEvent($, 'open_pressed'), later($, async () => void (await buildAndOpen($))))} /> : null}
        <Button key="lineage-open" label="Open lineage" onPress={() => later($, () => openPane($))} />
        <Button key="lineage-summary-dismiss" label="Dismiss" onPress={() => update($, hiddenAtom, () => true)} />
      </Box>
    </Box>
  )
}

// The task's share of the lineage hooks' events: registerLineage owns turn.start, tool.call and
// turn.complete, since a plugin hooks each event once.

/** A main-loop turn is one task: its start copies the manifest and notes what git already sees changed. */
export async function taskTurnStart($: EngineInterface) {
  const t = newTask()
  task = t
  await update($, summaryAtom, () => null)
  await update($, planAtom, () => null)
  const own = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
  if (own) await within($, 20_000, prepareRoot($, t, own))
}

/** Before an edit lands: the model file's text as it was, the first time the task touches it. */
export async function taskBeforeTool($: EngineInterface, e: any) {
  // A plan is about to go up for approval: `next(e)` is what opens the dialog, and this does not hold it.
  if (e.tool === 'ExitPlanMode' && !e.agentId) later($, () => planReady($, e).catch(error => $.ui.log(`lineage-summary · plan: ${String(error)}`, { to: 'debug' })))
  const file = EDIT_TOOLS.has(e.tool) && 'file_path' in e ? String(e.file_path) : null
  if (!file || !/\.sql$/i.test(file)) return
  const t = (task ??= newTask())
  if (t.originals.has(file)) return
  const root = await projectRoot($, file, true).catch(() => null)
  if (!root) return
  // A project first touched mid-task has its manifest copied now, before the edit.
  await within($, 20_000, prepareRoot($, t, root))
  if (!t.originals.has(file)) t.originals.set(file, { root, text: await $.fs.read(file).catch(() => '') })
}

/** A main-loop turn ended: trace what it changed, after the answer is out. */
export function taskTurnComplete($: EngineInterface, e: { agentId?: string }) {
  if (e.agentId || !task) return
  const done = task
  task = null
  later($, () => finishTask($, done).catch(error => $.ui.log(`lineage-summary · failed: ${String(error)}`)))
}

/** /lineage-report: builds the last finished task's report and opens it; with model.column, that column's. */
export function registerTaskImpact(on: On) {
  on('command.run', { command: REPORT_COMMAND }, async ($, e) => {
    const asked = reportRequest(String(e.args ?? ''))
    if (asked.kind === 'usage') return { text: REPORT_USAGE }
    reportEvent($, 'command_run')
    return { text: asked.kind === 'column' ? await openColumnReport($, asked.model, asked.column) : await buildAndOpen($) }
  })
}
