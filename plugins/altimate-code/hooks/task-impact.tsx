// The end-of-task column impact: what a task changed in its dbt models, how far each changed column's
// value reaches, as one summary in the band, and a full offline report that opens in the browser.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { TaskSummaryView } from '../types'
import { later } from './altimate-cli'
import {
  answerOf,
  changedColumns,
  type ColumnTrace,
  type ModelChange,
  modelLevelOf,
  openersFor,
  type Platform,
  reportData,
  reportHtml,
  summaryLines,
  summaryOf,
  WINDOWS_EXPLORER,
} from './impact-report'
import { projectLayout } from './lineage-graph'
import { openPane, projectRoot, runTool, within } from './lineage'

export const REPORT_COMMAND = 'lineage-report'
// Under the project's target/, which dbt already keeps out of git.
const LINEAGE_DIR = 'target/.altimate-lineage'
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
const hiddenAtom = atom({ plugin: 'altimate-code', key: 'isLineageSummaryHidden' } as const, false)

type Layout = { models: string[] }
type GitStart = { top: string; dirty: Map<string, string | null> }
type RootState = { snapshot: string | null; layout: Layout; git: GitStart | null }
type Task = { roots: Map<string, Promise<RootState>>; originals: Map<string, { root: string; text: string }> }

// The task under way: from a main-loop turn's start to its end.
let task: Task | null = null
let lastReport: string | null = null
let finishSeq = 0

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
      const copied = made?.exitCode === 0 ? await $.process.run(['cp', manifest, `${dir}/manifest-before.json`], { timeoutMs: 20_000 }).catch(() => null) : null
      if (copied?.exitCode === 0) snapshot = `${dir}/manifest-before.json`
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
    changes.push({ model: modelName(file), file: relative(one.root, file), root: one.root, columns: changedColumns(one.original, current) })
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

/** Downstream and upstream answers for each changed column; the model-level count for a model with none. */
async function traceChanges($: EngineInterface, t: Task, changes: ModelChange[]): Promise<ColumnTrace[]> {
  const ask = async (change: ModelChange, column: string | null, direction: 'downstream' | 'upstream') => {
    const state = await t.roots.get(change.root)?.catch(() => null)
    const manifest = state?.snapshot ?? `${change.root}/target/manifest.json`
    // Known limit: the model goes by its file name, which misses a versioned model (x_v2.sql) or a file
    // named apart from its model.
    const args = { manifest_path: manifest, model: change.model, ...(column && { column }), change_type: 'modify', direction }
    const result = await runTool($, 'impact_analysis', args).catch(() => null)
    return result?.ok ? result.metadata : null
  }
  const jobs: (() => Promise<ColumnTrace>)[] = []
  for (const change of changes) {
    if (change.columns.length === 0) {
      jobs.push(async () => {
        const meta = await ask(change, null, 'downstream')
        return { model: change.model, column: null, down: null, up: null, modelLevel: modelLevelOf(meta), failed: meta === null }
      })
    }
    for (const col of change.columns) {
      jobs.push(async () => {
        const [down, up] = await Promise.all([ask(change, col.name, 'downstream'), ask(change, col.name, 'upstream')])
        const downAnswer = answerOf(down)
        return { model: change.model, column: col.name, down: downAnswer, up: answerOf(up), modelLevel: modelLevelOf(down), failed: !downAnswer }
      })
    }
  }
  return pool(jobs, PARALLEL / 2)
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** At a task's end: what changed, traced, summed up in the band, and written as the report. */
async function finishTask($: EngineInterface, t: Task) {
  const seq = ++finishSeq
  const changes = await collectChanges($, t)
  if (changes.length === 0) return
  const tracing: TaskSummaryView = {
    state: 'tracing',
    models: changes.map(one => ({ name: one.model, modelLevel: null, columns: one.columns.map(col => ({ name: col.name, how: null, reach: null, failed: false })) })),
    unresolved: 0,
    truncated: false,
    report: null,
    openFailed: false,
  }
  await update($, summaryAtom, () => tracing)
  await update($, hiddenAtom, () => false)
  const traces = await traceChanges($, t, changes)
  const root = changes[0]!.root
  const state = await t.roots.get(root)?.catch(() => null)
  const data = reportData(changes, traces, stamp(await $.clock.now()), state?.snapshot ? 'the manifest as it was when the task started' : 'target/manifest.json')
  const path = `${root}/${LINEAGE_DIR}/report.html`
  let report: string | null = null
  try {
    await $.fs.write(path, reportHtml(data))
    report = path
    lastReport = path
  } catch (error) {
    $.ui.log(`lineage-summary · the report could not be written: ${String(error)}`)
  }
  // A newer task finished first: its summary stays.
  if (seq !== finishSeq) return
  const view = summaryOf(changes, traces, report)
  await update($, summaryAtom, () => view)
  // One line: a log line draws a newline as a replacement glyph.
  $.ui.log(summaryLines(view).map(line => line.trim()).join(' · '))
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

async function openAndSay($: EngineInterface, path: string): Promise<boolean> {
  const opened = await openReport($, path)
  if (!opened) await update($, summaryAtom, view => (view && view.report === path ? { ...view, openFailed: true } : view))
  return opened
}

/** Registers /lineage-report; called from the plugin's one session.start hook. */
export async function startTaskImpact($: EngineInterface) {
  task = null
  lastReport = null
  await update($, summaryAtom, () => null)
  await $.command.register({
    name: REPORT_COMMAND,
    description: 'Open the last column impact report (what a task changed in dbt models and what it reaches) in the browser',
  })
}

type Ui = { Box: any; Button: any; Text: any; Link?: any }

/** The summary of the last task that changed a model; drawn by the plugin's one band hook. */
export async function taskBand($: EngineInterface, ui: Ui): Promise<RenderElement | null> {
  const view = await read($, summaryAtom)
  if (!view || (await read($, hiddenAtom))) return null
  const { Box, Button, Link, Text } = ui
  const lines = summaryLines(view)
  const shown = lines.length > MAX_BAND_LINES ? [...lines.slice(0, MAX_BAND_LINES - 1), `… ${lines.length - MAX_BAND_LINES + 1} more lines in the report`] : lines
  const report = view.report
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
      {report && view.openFailed ? (
        <Text dimColor>
          No browser opened. Report: {Link ? <Link href={`file://${report}`}>{report}</Link> : report}
        </Text>
      ) : null}
      <Box>
        {report ? <Button key="lineage-report-open" label="Open report" onPress={() => later($, () => openAndSay($, report))} /> : null}
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
  const own = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
  if (own) await within($, 20_000, prepareRoot($, t, own))
}

/** Before an edit lands: the model file's text as it was, the first time the task touches it. */
export async function taskBeforeTool($: EngineInterface, e: any) {
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

/** /lineage-report: opens the last report. */
export function registerTaskImpact(on: On) {
  on('command.run', { command: REPORT_COMMAND }, async $ => {
    let path = lastReport
    if (!path) {
      const own = await projectRoot($, await $.session.root().catch(() => '.'), false).catch(() => null)
      const candidate = own ? `${own}/${LINEAGE_DIR}/report.html` : null
      if (candidate && (await $.fs.exists(candidate).catch(() => false))) path = candidate
    }
    if (!path) return { text: 'No column impact report yet: one is written when a task changes a dbt model.' }
    const opened = await openAndSay($, path)
    return { text: opened ? `Opened the column impact report: ${path}` : `No browser could be opened. The report is at ${path}` }
  })
}
