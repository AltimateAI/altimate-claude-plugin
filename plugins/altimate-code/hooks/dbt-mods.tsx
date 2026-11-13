// dbt Power User's everyday helpers, beside Claude: compile-and-validate after each model edit, Explain
// and Fix on a failed dbt run, a results pane for `dbt show`, the manifest's facts on a model Claude
// reads, and an environment doctor at session start. Each runs the project's own dbt; none calls a model.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { CheckView, DoctorCheck, DoctorView, FailureView, QueryResult, SavedQuery } from '../types'
import { later } from './altimate-cli'
import {
  cellText,
  columnDrift,
  columnWidths,
  dbtCommand,
  doctorNote,
  explainPrompt,
  failuresFrom,
  failuresFromText,
  fixPrompt,
  logErrors,
  modelContext,
  modelContextNote,
  modelPaths,
  nodeForFile,
  projectPaths,
  replayArgv,
  saysFailed,
  targetPath,
  showPreview,
  stripAnsi,
  textTable,
  versionInfo,
  debugInfo,
} from './dbt-mods-core'

const RESULTS_PANE = 'altimate-results'
const RESULTS_TITLE = 'dbt results'
const DOCTOR_PANE = 'altimate-doctor'
const DOCTOR_TITLE = 'dbt doctor'
const CHECK_PANE = 'altimate-check'
const CHECK_TITLE = 'dbt check'
const SHOW_COMMAND = 'dbt-show'
const DOCTOR_COMMAND = 'dbt-doctor'
const HISTORY_KEY = 'dbt-results-history'
// The tools that write a file in this Claude Code build (MultiEdit is not one of them).
const EDIT_TOOLS = new Set(['Edit', 'Write'])
// How long an edit's result waits for compile-and-validate before it goes back to Claude without it;
// a later answer rides on Claude's next tool result.
const CHECK_HOLD_MS = 30_000
const DBT_TIMEOUT_MS = 120_000
const SHOW_LIMIT = 50
const HISTORY_SIZE = 20
// $.fs.read refuses files over 4 MiB.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
// The most files the doctor's freshness check looks at.
const MAX_SCANNED = 3000
// The history the results pane lists: every saved query, most recent first.
const HISTORY_SHOWN = HISTORY_SIZE

const checkAtom = atom({ plugin: 'altimate-code', key: 'dbtCheck' } as const, null as CheckView | null)
const failureAtom = atom({ plugin: 'altimate-code', key: 'dbtFailure' } as const, null as FailureView | null)
const doctorAtom = atom({ plugin: 'altimate-code', key: 'dbtDoctor' } as const, null as DoctorView | null)
const resultAtom = atom({ plugin: 'altimate-code', key: 'dbtResult' } as const, null as QueryResult | null)
const historyAtom = atom({ plugin: 'altimate-code', key: 'dbtHistory' } as const, [] as SavedQuery[])
const resultBusyAtom = atom({ plugin: 'altimate-code', key: 'dbtResultBusy' } as const, null as string | null)

// Notes for Claude that missed their own tool result (a slow check): they ride on the next tool result of
// the same agent, while their check is still the newest one in this conversation.
const pendingNotes: { note: string; agentId: string | null; current: () => boolean }[] = []
// Model context given this turn, by model and manifest revision: once a turn, as context may be compacted.
const contextGiven = new Set<string>()
// The doctor's note goes with the first prompt after it lands, once a session.
let doctorNoteDue: string | null = null
// Every dbt the plugin starts in a project waits for the one before it: DuckDB and SQLite projects
// lock their database file for a whole invocation.
const queues = new Map<string, Promise<unknown>>()
// The newest check per model: an older one landing late does not overwrite it.
const checkSeq = new Map<string, number>()
let seq = 0
// Bumped when a conversation ends (/clear): work started in the last one lands nowhere in this one.
let generation = 0
/** Gives Claude the doctor's note with its next prompt, unless the conversation that asked for it has ended. */
function noteDoctor(root: string, view: DoctorView, asked: number) {
  if (generation === asked) doctorNoteDue = doctorNote(root, view.checks)
}
// Slices of manifests too big to read here, by manifest path, file and revision.
const slices = new Map<string, Promise<any>>()
const MAX_SLICES = 16

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path
const relative = (root: string, path: string) => path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
const quoteName = (name: string) => JSON.stringify(name)

function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: T | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    $.clock.after(ms, () => settle(null))
    work.then(settle, () => settle(null))
  })
}

/** `a/./b/../c` → `a/c`: two spellings of one folder are one project, one queue, one identity. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

/** The closest folder above a file or folder that holds dbt_project.yml, spelled one way. */
async function projectRoot($: EngineInterface, start: string, isFile: boolean): Promise<string | null> {
  let dir = normalize(isFile ? dirname(start) : start)
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** The session's dbt project: the session folder's own, else one a level or two below it. */
async function sessionProject($: EngineInterface): Promise<string | null> {
  const root = await $.session.root().catch(() => null)
  if (!root) return null
  const own = await projectRoot($, root, false)
  if (own) return own
  let level = [root]
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = []
    for (const dir of level) {
      for (const entry of await $.fs.list(dir).catch(() => [])) {
        if (entry.kind !== 'dir' || entry.name.startsWith('.') || ['node_modules', 'target', 'dbt_packages'].includes(entry.name)) continue
        const sub = `${dir}/${entry.name}`
        if (await $.fs.exists(`${sub}/dbt_project.yml`).catch(() => false)) return sub
        next.push(sub)
      }
    }
    level = next.slice(0, 200)
  }
  return null
}

/** The project's dbt: its virtual environment's when it has one, else the one on PATH. */
async function dbtBinary($: EngineInterface, root: string): Promise<string> {
  // Only the project's own folders: never a dbt found above the folder the person opened.
  for (const candidate of [`${root}/.venv/bin/dbt`, `${root}/venv/bin/dbt`, `${root}/.venv/Scripts/dbt.exe`, `${root}/venv/Scripts/dbt.exe`]) {
    if (await $.fs.exists(candidate).catch(() => false)) return candidate
  }
  return 'dbt'
}

// What a run that was no longer wanted when its turn came answers: it never started.
const SKIPPED = { exitCode: -2, stdout: '', stderr: 'skipped: a newer check replaced it' }

/**
 * Runs a command in a project, after any dbt this plugin already started there. `wanted` is asked
 * when its turn comes: a check a newer edit replaced runs no warehouse query.
 */
function runQueued($: EngineInterface, root: string, argv: () => Promise<string[]>, options: { cwd?: string; timeoutMs?: number; wanted?: () => boolean } = {}) {
  const before = queues.get(root) ?? Promise.resolve()
  const run = before
    .catch(() => {})
    .then(async () => {
      if (options.wanted && !options.wanted()) return SKIPPED
      return $.process.run(await argv(), { cwd: options.cwd ?? root, timeoutMs: options.timeoutMs ?? DBT_TIMEOUT_MS })
    })
  queues.set(root, run.catch(() => {}))
  return run
}

/** Runs the project's dbt in the project, after any dbt this plugin already started there. */
function runDbt($: EngineInterface, root: string, args: string[], timeoutMs = DBT_TIMEOUT_MS, wanted?: () => boolean) {
  return runQueued($, root, async () => [await dbtBinary($, root), ...args], { timeoutMs, wanted })
}

// Reads a manifest too big for $.fs.read with the project's Python, and prints only what the helpers need
// about one file's node: the node, its tests, and the graph above and below it, names only.
const MANIFEST_SLICE = `import json, sys
m = json.load(open(sys.argv[1]))
rel = sys.argv[2]
nodes = m.get('nodes') or {}
pm = m.get('parent_map') or {}
cm = m.get('child_map') or {}
if not pm:
    for k, n in nodes.items():
        pm[k] = (n.get('depends_on') or {}).get('nodes') or []
        for p in pm[k]:
            cm.setdefault(p, []).append(k)
project = sys.argv[3] if len(sys.argv) > 3 else ''
hit = [k for k, n in nodes.items() if n.get('original_file_path') == rel and n.get('resource_type') != 'test' and (not project or not n.get('package_name') or n.get('package_name') == project)]
keep = set(hit)
for graph in (pm, cm):
    todo = list(hit)
    while todo and len(keep) < 20000:
        for x in graph.get(todo.pop(), []):
            if len(keep) >= 20000:
                break
            if x not in keep:
                keep.add(x)
                todo.append(x)
tests = [c for h in hit for c in cm.get(h, []) if c.startswith('test.')]
keep.update(tests)
full = set(hit) | set(tests)
fields = ('name', 'package_name', 'resource_type', 'original_file_path', 'relation_name', 'description', 'config', 'tags', 'columns', 'column_name', 'test_metadata', 'depends_on', 'patch_path')
out = {'nodes': {}, 'parent_map': {}, 'child_map': {}, 'metadata': {'project_name': project or (m.get('metadata') or {}).get('project_name')}}
for k in keep:
    n = nodes.get(k)
    if n is not None:
        out['nodes'][k] = {f: n.get(f) for f in fields} if k in full else {'name': n.get('name'), 'resource_type': n.get('resource_type')}
    out['parent_map'][k] = pm.get(k, [])
    out['child_map'][k] = cm.get(k, [])
print(json.dumps(out))
`

/** The project's name in dbt_project.yml: which manifest nodes are its own, not an installed package's. */
async function projectName($: EngineInterface, root: string): Promise<string | null> {
  return /^name:\s*['"]?([\w-]+)/m.exec(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))?.[1] ?? null
}

/** The project's artifact folder (`target-path` in dbt_project.yml): absolute, or under the project. */
async function targetOf($: EngineInterface, root: string): Promise<string> {
  const path = targetPath(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
  return normalize(path.startsWith('/') ? path : `${root}/${path}`)
}

/** The Python beside the project's dbt, else the one on PATH. */
async function pythonFor($: EngineInterface, root: string): Promise<string> {
  const dbt = await dbtBinary($, root)
  if (dbt !== 'dbt') {
    const beside = dbt.replace(/dbt(\.exe)?$/, (_, exe) => (exe ? 'python.exe' : 'python'))
    if (await $.fs.exists(beside).catch(() => false)) return beside
  }
  return 'python3'
}

/**
 * The manifest of a project, parsed, with its modification time; null when absent or unreadable. A
 * manifest over 4 MiB (more than $.fs.read takes) is read for one file's node only, `rel`, through the
 * project's Python, as the lineage half reads one through altimate-code.
 */
async function readManifest($: EngineInterface, root: string, rel?: string): Promise<{ manifest: any; mtimeMs: number } | null> {
  const path = `${await targetOf($, root)}/manifest.json`
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat || stat.kind !== 'file') return null
  try {
    if (stat.size <= MAX_MANIFEST_BYTES) return { manifest: JSON.parse(await $.fs.read(path)), mtimeMs: stat.mtimeMs }
    if (!rel) return null
    // One slice per file and manifest revision: a re-read in the same turn, and an edit's checks, reuse it.
    const key = JSON.stringify([path, rel, stat.mtimeMs])
    const cached = slices.get(key)
    if (cached) return { manifest: await cached, mtimeMs: stat.mtimeMs }
    const slicing = (async () => {
      const python = await pythonFor($, root)
      const project = (await projectName($, root)) ?? ''
      const run = await $.process.run([python, '-c', MANIFEST_SLICE, path, rel, project], { cwd: root, timeoutMs: 60_000 })
      if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error('manifest slice failed')
      return JSON.parse(run.stdout)
    })()
    // Only the newest revision of each file is kept, and at most a few files.
    for (const old of [...slices.keys()]) if (JSON.parse(old)[1] === rel && JSON.parse(old)[0] === path) slices.delete(old)
    while (slices.size >= MAX_SLICES) slices.delete(slices.keys().next().value!)
    slices.set(key, slicing)
    slicing.catch(() => slices.delete(key))
    return { manifest: await slicing, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Takes the notes that missed their own tool result, for this agent: they go with this one. */
function withPending<T extends { context?: string[] }>(result: T, agentId: string | null): T {
  const mine = pendingNotes.filter(one => one.agentId === agentId)
  if (mine.length === 0) return result
  for (const one of mine) pendingNotes.splice(pendingNotes.indexOf(one), 1)
  const notes = mine.filter(one => one.current()).map(one => one.note)
  return notes.length ? { ...result, context: [...(result.context ?? []), ...notes] } : result
}

function addContext<T extends { context?: string[] }>(result: T, note: string | null): T {
  return note ? { ...result, context: [...(result.context ?? []), note] } : result
}

// ─── 07 · Compile and validate, on every edit ─────────────────────────────────────────────────────

/** The project-relative schema file a manifest node's columns come from (`patch_path`), when it names one. */
const schemaOf = (node: any): string | null => (typeof node?.patch_path === 'string' ? node.patch_path.replace(/^[^:]*:\/\//, '') : null)

/** Compiles the model and runs it against the warehouse (one row), then holds its columns to schema.yml. */
async function compileAndValidate($: EngineInterface, root: string, file: string, mineGeneration = generation): Promise<{ view: CheckView; note: string; current: () => boolean }> {
  const rel = relative(root, file)
  // The newest check per project file, in this conversation: an older one, or one from before /clear, lands nowhere.
  const mine = ++seq
  const fileKey = `${root}\u0000${rel}`
  checkSeq.set(fileKey, mine)
  const current = () => checkSeq.get(fileKey) === mine && generation === mineGeneration
  // Changes made from here on are newer than this check: the next recheck sees them.
  const started = await $.clock.now()
  // The model's own name, from the manifest when it knows the file (shown to the person; dbt selects by path).
  const before = await readManifest($, root, rel)
  const known = before ? nodeForFile(before.manifest, rel, await projectName($, root)) : null
  const model = typeof known?.node?.name === 'string' ? known.node.name : basename(file).replace(/\.sql$/i, '')
  const blank = { model, root, file: rel, errors: [], missing: [], undocumented: [], columns: null, returned: [], documented: [], reason: null, ran: false, schema: schemaOf(known?.node), target: await targetOf($, root) }
  await setCheck($, { ...blank, status: 'running', ms: 0, at: started }, current)
  // The file itself, by path (a name can be a version's or another package's), and only it: dbt's eager
  // indirect selection would also run its tests, and show a test's failure as the model's.
  const run = await runDbt($, root, ['show', '--select', `path:${rel}`, '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'], DBT_TIMEOUT_MS, current).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  // A newer edit replaced this check before its turn: nothing ran, nothing to report.
  if (run === SKIPPED) return { view: { ...blank, status: 'partial', reason: 'a newer check replaced this one', ms: 0, at: started }, note: '', current }
  // dbt show re-parsed the project: the manifest now holds the model and schema.yml as they are.
  const after = await readManifest($, root, rel)
  const node = after ? nodeForFile(after.manifest, rel, await projectName($, root)) : null
  const named = typeof node?.node?.name === 'string' ? node.node.name : null
  const ms = (await $.clock.now()) - started
  const preview = run.exitCode === 0 ? showPreview(run.stdout) : null
  const errors = run.exitCode === 0 ? [] : logErrors(run.stdout)
  if (run.exitCode !== 0 && errors.length === 0) errors.push(stripAnsi(run.stderr || run.stdout).trim().split('\n').slice(-6).join('\n') || `dbt exited ${run.exitCode}`)
  // dbt exited 0 but showed nothing. A model the manifest still lists is a failure; a file it does not
  // list (a model just disabled, not a model at all) was not checked.
  const nothingShown = run.exitCode === 0 && !preview
  if (nothingShown && node) errors.push(`dbt show selected nothing for ${rel} (the model ${named ?? model}), so nothing was compiled or run. ${stripAnsi(run.stdout).split('\n').map(line => line.trim()).filter(Boolean).slice(-1)[0] ?? ''}`.trim())
  const documented = node ? Object.values<any>(node.node.columns ?? {}).map(column => String(column.name)) : []
  const returned = preview && preview.rows.length > 0 ? preview.columns : null
  const drift = returned && documented.length ? columnDrift(documented, returned) : { missing: [], undocumented: [] }
  // Agreement is claimed only when both sides were read: else it says what was not checked.
  const reason = errors.length
    ? null
    : nothingShown
      ? 'dbt has no model for this file (disabled, or not a model), so nothing was compiled or run'
      : !returned
        ? 'the query returned no row, so its columns could not be read'
        : !node
          ? 'the manifest has no entry for this file, so the documented columns could not be read'
          : documented.length === 0
            ? 'schema.yml documents no columns for this model'
            : null
  const status: CheckView['status'] = errors.length ? 'error' : reason ? 'partial' : drift.missing.length || drift.undocumented.length ? 'warn' : 'ok'
  const view: CheckView = { ...blank, model: named ?? model, schema: node ? schemaOf(node.node) : blank.schema, status, reason, ran: !errors.length && !nothingShown, errors: errors.map(one => one.slice(0, 1500)), missing: drift.missing, undocumented: drift.undocumented, columns: returned ? returned.length : null, returned: returned ?? [], documented, ms, at: started }
  await setCheck($, view, current)
  // An edit of a schema file or macro that came while this ran checks it again now.
  if (forcedWhileBusy && current() && !rechecking) {
    const waiting = forcedWhileBusy
    forcedWhileBusy = null
    later($, () => recheck($, waiting))
  }
  // A problem opens the whole answer beside the chat: the band has room for one line of dbt's error.
  if ((view.status === 'warn' || view.status === 'error') && current()) await openCheck($, false).catch(() => null)
  return { view, note: checkNote(view), current }
}

async function setCheck($: EngineInterface, view: CheckView, current: () => boolean) {
  if (!current()) return
  await update($, checkAtom, () => view)
}

// A recheck in flight: a burst of shell commands starts one.
let rechecking = false
// A forced recheck asked for while one ran: it runs once that one ends.
let forcedWhileBusy: string | null = null

/**
 * Checks the model the band reports on again when its file or its schema file changed since its check (a
 * fix altimate-code made), or when `edited` names a .yml or .sql of its project that Claude just edited (a
 * schema file documenting it for the first time, a macro). A deleted model drops its check. A dbt command
 * that only rewrote the manifest changes nothing here, and starts no warehouse query.
 */
async function recheck($: EngineInterface, edited: string | null = null) {
  // The conversation that asked: one that ends while this waits gets nothing from it.
  const asked = generation
  const check = await read($, checkAtom)
  if (!check) return
  // Busy (a check or recheck running): a forced recheck waits for it, so a schema.yml written meanwhile is not missed.
  if (check.status === 'running' || rechecking) {
    // Only an edit that concerns this check waits for it; an unrelated one never replaces it.
    if (edited && editConcerns(check, edited)) forcedWhileBusy = edited
    return
  }
  const files = [check.file, ...(check.schema ? [check.schema] : [])]
  const stats = await Promise.all(files.map(one => $.fs.stat(`${check.root}/${one}`).catch(() => null)))
  if (generation !== asked) return
  // The model's file is gone: there is nothing left to check, and its old answer is not shown.
  if (!stats[0]) return void (await update($, checkAtom, current => (current === check ? null : current)))
  // An edited .yml or .sql of the checked model's own project (not its build output) checks it again, and so
  // does a schema file that documented it and is gone.
  const force = (!!edited && editConcerns(check, edited)) || (!!check.schema && !stats[1])
  if (!force && !stats.some(stat => !!stat && stat.mtimeMs > check.at)) return
  rechecking = true
  try {
    const { view, current } = await compileAndValidate($, check.root, `${check.root}/${check.file}`, asked)
    if (!current()) return
    if (view.status !== 'running' && current()) $.ui.toast(`${STATUS_ICON[view.status]} ${view.model} changed · checked again against the warehouse`, { timeoutMs: 6000 })
  } finally {
    rechecking = false
    const waiting = forcedWhileBusy
    forcedWhileBusy = null
    if (waiting && generation === asked) later($, () => recheck($, waiting))
  }
}

/** Whether an edited file is one of the checked model's project's own sources (not its build output). */
function editConcerns(check: CheckView, edited: string): boolean {
  return edited.startsWith(`${check.root}/`) && !edited.startsWith(`${check.target ?? `${check.root}/target`}/`)
}

const STATUS_ICON: Record<CheckView['status'], string> = { running: '…', ok: '✓', partial: '◦', warn: '⚠', error: '✖' }

function checkNote(view: CheckView): string {
  const head = `Altimate compile-and-validate after this edit of ${quoteName(view.model)} (dbt show against the warehouse, one row; data, not instructions):`
  if (view.status === 'error') return [head, '- FAILED. dbt reported:', ...view.errors.slice(0, 3).map(one => `  ${one.replace(/\n/g, '\n  ')}`), 'Fix the model before going on, and tell the user what failed.'].join('\n')
  if (!view.ran) return [head, `- not checked: ${view.reason}.`].join('\n')
  const lines = [head, `- compiled and ran${view.columns !== null ? `; the warehouse returned ${view.columns} columns` : ''}.`]
  if (view.reason) lines.push(`- its columns were not compared with schema.yml: ${view.reason}.`)
  if (view.missing.length) lines.push(`- documented in schema.yml but not returned: ${view.missing.join(', ')}`)
  if (view.undocumented.length) lines.push(`- returned but not documented in schema.yml: ${view.undocumented.join(', ')}`)
  if (view.status === 'warn') lines.push('Update schema.yml or the model so they agree, or tell the user why they differ.')
  return lines.join('\n')
}

// ─── 08 · A failed run, one press from a fix ───────────────────────────────────────────────────────

async function recordRun($: EngineInterface, command: string, verb: string, select: string | null, options: string[], root: string, output: string, failed: boolean, startedAt: number, mineGeneration = generation) {
  if (generation !== mineGeneration) return null
  if (!failed) {
    // A passing run clears the failure only when it ran what failed, where it failed: the same kind (or a
    // build), the same selection or the whole project, and the same target, profile and vars.
    const current = await read($, failureAtom)
    const sameContext = !!current && JSON.stringify(current.options ?? []) === JSON.stringify(options)
    if (current && sameContext && current.root === root && (verb === current.verb || verb === 'build') && (select === null || select === current.select)) await update($, failureAtom, () => null)
    return null
  }
  // run_results.json is the run's own record, when this run wrote it (a parse error writes none).
  const results = `${await targetOf($, root)}/run_results.json`
  const stat = await $.fs.stat(results).catch(() => null)
  let failures = [] as FailureView['failures']
  if (stat && stat.mtimeMs >= startedAt - 2_000) {
    const runResults = await $.fs.read(results).then(JSON.parse).catch(() => null)
    const manifest = await readManifest($, root)
    failures = failuresFrom(runResults, manifest?.manifest)
  }
  if (failures.length === 0) failures = failuresFromText(output)
  // Nothing dbt itself reported (a command the permission check refused, a missing binary): no band.
  if (failures.length === 0) return null
  const view: FailureView = { command, root, verb, select, options, failures, at: await $.clock.now() }
  // A run that finished after a /clear belongs to the conversation that ran it.
  if (generation !== mineGeneration) return null
  await update($, failureAtom, () => view)
  const names = failures.map(one => one.name)
  $.ui.toast(`✖ dbt ${verb} failed · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} · Explain or Fix above the prompt`, { timeoutMs: 8000 })
  return view
}

// ─── 09 · Query results in a pane ───────────────────────────────────────────────────────────────────

async function loadHistory($: EngineInterface) {
  const saved = await $.store.get(HISTORY_KEY).catch(() => null)
  await update($, historyAtom, () => (Array.isArray(saved) ? (saved as SavedQuery[]) : []))
}

/** Saves the history atom to the store, as it stands after the update that called this. */
async function persistHistory($: EngineInterface) {
  await $.store.set(HISTORY_KEY, await read($, historyAtom)).catch(() => {})
}

/** Keeps a query in the history, newest first. Each update builds on the history as it is then, so two at once both land. */
async function remember($: EngineInterface, result: QueryResult) {
  await update($, historyAtom, history => {
    const kept = history.find(one => one.id === result.id)
    const entry: SavedQuery = { ...result, rows: result.rows.slice(0, SHOW_LIMIT), bookmarked: kept?.bookmarked ?? false }
    const next = [entry, ...history.filter(one => one.id !== result.id)]
    // Bookmarks are never pushed out by newer queries.
    const plain = next.filter(one => !one.bookmarked).slice(0, HISTORY_SIZE)
    return next.filter(one => one.bookmarked || plain.includes(one))
  })
  await persistHistory($)
}

async function toggleBookmark($: EngineInterface, id: string) {
  await update($, historyAtom, history => history.map(one => (one.id === id ? { ...one, bookmarked: !one.bookmarked } : one)))
  await persistHistory($)
}

/** Forgets the saved rows of every query that is not bookmarked. */
async function clearHistory($: EngineInterface) {
  await update($, historyAtom, history => history.filter(one => one.bookmarked))
  await persistHistory($)
}

/** The id a query keeps across runs: the same model or exact SQL, with the same options, in the same project. */
const queryId = (root: string, select: string | null, inline: string | null, options: string[]) => JSON.stringify([root, select, inline?.trim() ?? null, options])
const titleOf = (select: string | null, inline: string | null) => select ?? (inline ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)

async function showResult($: EngineInterface, result: QueryResult, open: boolean) {
  await update($, resultAtom, () => result)
  await remember($, result)
  if (open) await $.ui.open({ id: RESULTS_PANE, title: RESULTS_TITLE, columns: 110, rows: 30, closeOnEscape: true }).catch(() => null)
}

/** Runs a dbt show and puts its rows in the pane: /dbt-show's query, or a re-run of one in the history. */
async function runShowWith($: EngineInterface, base: Omit<QueryResult, 'columns' | 'rows' | 'ms' | 'at' | 'error'>, run: () => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  await update($, resultBusyAtom, () => `Running ${base.title}…`)
  try {
    const started = await $.clock.now()
    const done = await run().catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    const ms = (await $.clock.now()) - started
    const preview = done.exitCode === 0 ? showPreview(done.stdout) : null
    const error = preview ? null : (logErrors(done.stdout)[0] ?? (stripAnsi(done.stderr || done.stdout).trim().split('\n').slice(-4).join('\n') || 'dbt show returned no rows'))
    const result: QueryResult = { ...base, columns: preview?.columns ?? [], rows: preview?.rows ?? [], ms, at: await $.clock.now(), error }
    await showResult($, result, true)
    return result
  } finally {
    await update($, resultBusyAtom, () => null)
  }
}

/** /dbt-show's query: a model or SQL, 50 rows, with the project's dbt and default target. */
function runShow($: EngineInterface, root: string, select: string | null, inline: string | null, limit = SHOW_LIMIT) {
  const args = ['show', ...(select ? ['--select', select, '--indirect-selection', 'empty'] : ['--inline', inline ?? '']), '--limit', String(limit), '--output', 'json', '--log-format', 'json']
  return runShowWith($, { id: queryId(root, select, inline, []), title: titleOf(select, inline), root, select, inline, options: [], argv: null, cwd: null, limit, by: 'you' }, () => runDbt($, root, args))
}

/**
 * Runs a query from the pane again: Claude's own invocation exactly as it ran (its executable, flags and
 * folder, with JSON output and the same limit), or /dbt-show's query.
 */
async function rerun($: EngineInterface, query: QueryResult) {
  if (!query.argv) return runShow($, query.root, query.select, query.inline, query.limit)
  const [bin, ...args] = replayArgv(query.argv, query.limit)
  // Claude's shell may have been elsewhere (a `cd` in an earlier command): a folder or executable that is not
  // there now falls back to the project and its own dbt.
  const cwd = query.cwd && (await $.fs.stat(query.cwd).catch(() => null))?.kind === 'dir' ? query.cwd : query.root
  const written = bin!.includes('/') ? (bin!.startsWith('/') ? bin! : `${cwd.replace(/\/+$/, '')}/${bin}`) : null
  // A bare `dbt` was found on Claude's PATH (an activated venv, `uv run`): here that is the project's dbt.
  const executable = written && (await $.fs.exists(written).catch(() => false)) ? written : await dbtBinary($, query.root)
  return runShowWith($, query, () => runQueued($, query.root, async () => [executable, ...args], { cwd }))
}

// ─── 12 · Model context, before Claude guesses ───────────────────────────────────────────────────────

async function modelNote($: EngineInterface, file: string, agentId?: string): Promise<{ note: string; toast: string } | null> {
  const root = await projectRoot($, file, true)
  if (!root) return null
  const read = await readManifest($, root, relative(root, file))
  if (!read) return null
  const found = nodeForFile(read.manifest, relative(root, file), await projectName($, root))
  if (!found || found.node.resource_type !== 'model') return null
  // Per project (two checkouts share node ids), manifest revision, and agent (a subagent's context is its own).
  const key = JSON.stringify([root, found.id, read.mtimeMs, agentId ?? null])
  if (contextGiven.has(key)) return null
  const context = modelContext(read.manifest, found.id)
  if (!context) return null
  contextGiven.add(key)
  const sqlStat = await $.fs.stat(file).catch(() => null)
  const stale = !!sqlStat && sqlStat.mtimeMs > read.mtimeMs
  const tests = context.tests.length + context.columns.reduce((sum, one) => sum + one.tests.length, 0)
  return {
    note: modelContextNote(context, stale),
    toast: `◆ model context · ${context.name}: ${context.materialized ?? 'model'} · ${context.columns.length} columns · ${tests} tests · depth ${context.upstreamDepth}↑ ${context.downstreamDepth}↓`,
  }
}

// ─── 15 · An environment doctor at session start ───────────────────────────────────────────────────

/** The project's files changed after its manifest was written, newest first. */
async function changedSince($: EngineInterface, root: string, mtimeMs: number): Promise<{ files: string[]; complete: boolean }> {
  const changed: { path: string; mtimeMs: number }[] = []
  let scanned = 0
  // A folder that exists but could not be read leaves the answer unknown, never "current".
  let complete = true
  for (const top of ['dbt_project.yml', 'packages.yml', 'dependencies.yml']) {
    const stat = await $.fs.stat(`${root}/${top}`).catch(() => null)
    if (stat && stat.mtimeMs > mtimeMs) changed.push({ path: top, mtimeMs: stat.mtimeMs })
  }
  // The folders dbt_project.yml names (model-paths and the rest), not dbt's default names.
  const paths = projectPaths(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
  // A path of '.' is the project folder itself, which holds every other: walk it once.
  let level = paths.includes('') ? [root] : paths.map(dir => `${root}/${dir}`)
  const seen = new Set(changed.map(one => one.path))
  while (level.length && scanned <= MAX_SCANNED) {
    const next: string[] = []
    for (const dir of level) {
      // A default folder the project does not have is not a source.
      if (!(await $.fs.exists(dir).catch(() => false))) continue
      const entries = await $.fs.list(dir).catch(() => null)
      if (!entries) {
        complete = false
        continue
      }
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) break
        const path = `${dir}/${entry.name}`
        if (entry.kind === 'dir') {
          // A path of '.' walks the project folder: its builds, packages and logs are not its sources.
          if (!entry.name.startsWith('.') && !['target', 'dbt_packages', 'dbt_modules', 'logs', 'node_modules', 'venv'].includes(entry.name)) next.push(path)
          continue
        }
        if (!/\.(sql|ya?ml|csv|py|md)$/i.test(entry.name)) continue
        const stat = await $.fs.stat(path).catch(() => null)
        if (!stat) complete = false
        else if (stat.mtimeMs > mtimeMs && !seen.has(relative(root, path))) changed.push({ path: relative(root, path), mtimeMs: stat.mtimeMs })
      }
    }
    level = next
  }
  // A file of this project the manifest lists that is gone (a deleted model, a whole deleted folder) makes it
  // stale too. Installed packages' files live under dbt_packages, so only the project's own files are looked at.
  // A manifest over 4 MiB is not read here: deletions are then not looked for (changed files still are).
  const manifest = await readManifest($, root)
  if (manifest) {
    // The project's name from the manifest, else dbt_project.yml's (older manifests do not record it).
    const project = manifest.manifest.metadata?.project_name ?? (await projectName($, root))
    // Every file of the project the manifest names: nodes (models, seeds, snapshots, analyses, singular tests),
    // the schema files that document them, sources' and macros' files.
    const own = (one: any) => !project || !one?.package_name || one.package_name === project
    const files = (group: any) => Object.values<any>(group ?? {}).filter(own)
    const listed = [
      ...files(manifest.manifest.nodes).map(one => (one?.resource_type === 'test' && one?.test_metadata ? null : one?.original_file_path)),
      ...files(manifest.manifest.nodes).map(one => (typeof one?.patch_path === 'string' ? one.patch_path.replace(/^[^:]*:\/\//, '') : null)),
      ...files(manifest.manifest.sources).map(one => one?.original_file_path),
      ...files(manifest.manifest.macros).map(one => one?.original_file_path),
    ].filter((one): one is string => typeof one === 'string' && one.length > 0)
    for (const path of [...new Set(listed)].slice(0, MAX_SCANNED)) {
      if (!(await $.fs.exists(`${root}/${path}`).catch(() => true))) changed.push({ path: `${path} (deleted)`, mtimeMs: Number.MAX_SAFE_INTEGER })
    }
  }
  return { files: changed.sort((a, b) => b.mtimeMs - a.mtimeMs).map(one => one.path), complete: complete && scanned <= MAX_SCANNED }
}

/** The adapter type the project's profile names, from the profiles.yml dbt itself would read. */
async function profileType($: EngineInterface, root: string): Promise<string | null> {
  const project = await $.fs.read(`${root}/dbt_project.yml`).catch(() => '')
  const profile = /^profile:\s*['"]?([\w-]+)/m.exec(project)?.[1]
  if (!profile) return null
  const env = async (name: string) => $.process.run(['printenv', name], { timeoutMs: 5_000 }).then(one => one.stdout.trim()).catch(() => '')
  // dbt reads one profiles.yml: DBT_PROFILES_DIR's, else the project folder's when it has one, else ~/.dbt's.
  const home = await env('HOME')
  // A relative DBT_PROFILES_DIR is the project's (dbt runs there); `~` is the home folder.
  const rawDir = await env('DBT_PROFILES_DIR')
  const expanded = rawDir.startsWith('~') && home ? `${home}${rawDir.slice(1)}` : rawDir
  const profilesDir = expanded && !expanded.startsWith('/') ? normalize(`${root}/${expanded}`) : expanded
  const local = `${root}/profiles.yml`
  const path = profilesDir ? `${profilesDir}/profiles.yml` : (await $.fs.exists(local).catch(() => false)) ? local : home ? `${home}/.dbt/profiles.yml` : null
  if (!path) return null
  const text = await $.fs.read(path).catch(() => null)
  if (!text) return null
  const at = text.search(new RegExp(`^['"]?${profile}['"]?:\\s*$`, 'm'))
  // The profile is not in the file dbt reads: dbt fails there too.
  if (at < 0) return null
  const body = text.slice(at).split('\n').slice(1)
  const end = body.findIndex(line => /^\S/.test(line))
  const block = (end < 0 ? body : body.slice(0, end)).join('\n')
  const target = /^\s+target:\s*['"]?([\w-]+)/m.exec(block)?.[1]
  const types = [...block.matchAll(/^\s+type:\s*['"]?([\w-]+)/gm)].map(one => one[1]!)
  if (target) {
    const output = new RegExp(`^(\\s+)${target}:\\s*$`, 'm').exec(block)
    if (output) {
      const type = /^\s+type:\s*['"]?([\w-]+)/m.exec(block.slice(output.index + output[0].length))?.[1]
      if (type) return type
    }
  }
  return types[0] ?? null
}

async function runDoctor($: EngineInterface, root: string, connection = false): Promise<DoctorView> {
  const previous = await read($, doctorAtom)
  await update($, doctorAtom, () => ({ root, checks: previous?.root === root ? previous.checks : [], at: previous?.at ?? 0, staleFiles: previous?.staleFiles ?? [], busy: connection ? 'Testing the connection…' : 'Checking the dbt environment…' }))
  const checks: DoctorCheck[] = []
  const dbt = await dbtBinary($, root)
  const version = await runDbt($, root, ['--version'], 60_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  const info = versionInfo(`${version.stdout}\n${version.stderr}`)
  if (version.exitCode !== 0 && !info.core) {
    checks.push({ id: 'dbt', label: 'dbt', status: 'fail', detail: `could not run ${dbt}: ${stripAnsi(version.stderr || version.stdout).trim().split('\n').pop() ?? ''}`.slice(0, 300), fix: 'install dbt-core and your adapter (pip install dbt-core dbt-<adapter>), or create the project\'s .venv' })
  } else {
    checks.push({ id: 'dbt', label: 'dbt', status: 'ok', detail: `dbt-core ${info.core ?? 'unknown'} (${dbt === 'dbt' ? 'on PATH' : relative(root, dbt) || dbt})`, fix: null })
  }

  // Python: the interpreter dbt's own launcher names.
  const launcher = dbt === 'dbt' ? await $.process.run(['which', 'dbt'], { timeoutMs: 5_000 }).then(one => one.stdout.trim()).catch(() => '') : dbt
  const shebang = launcher ? /^#!\s*(\S+)/.exec((await $.fs.read(launcher).catch(() => '')).slice(0, 300))?.[1] : undefined
  const python = shebang ? await $.process.run([shebang, '--version'], { timeoutMs: 10_000 }).catch(() => null) : null
  const pythonVersion = python ? /Python\s+(\S+)/.exec(`${python.stdout}${python.stderr}`)?.[1] : null
  if (pythonVersion) {
    const [major, minor] = pythonVersion.split('.').map(Number)
    const old = major! < 3 || (major === 3 && minor! < 9)
    checks.push({ id: 'python', label: 'Python', status: old ? 'warn' : 'ok', detail: `${pythonVersion}${old ? ' (dbt needs 3.9 or newer)' : ''}`, fix: old ? 'use Python 3.9+ for dbt' : null })
  } else {
    checks.push({ id: 'python', label: 'Python', status: 'warn', detail: 'could not tell which Python runs dbt', fix: null })
  }

  // Adapter: the profile's type, installed beside dbt-core.
  const type = await profileType($, root)
  const installed = info.adapters.map(one => one.name)
  if (!type) checks.push({ id: 'adapter', label: 'Adapter', status: 'warn', detail: `no profile found for this project${installed.length ? `; installed: ${installed.join(', ')}` : ''}`, fix: 'add the profile to profiles.yml (or set DBT_PROFILES_DIR)' })
  // dbt-core's version unread (dbt Fusion bundles its adapters, a broken install): nothing to hold the profile to.
  else if (installed.length === 0 && !info.core) checks.push({ id: 'adapter', label: 'Adapter', status: 'warn', detail: `the profile uses ${type}; could not tell which adapters are installed`, fix: null })
  else if (installed.length === 0) checks.push({ id: 'adapter', label: 'Adapter', status: 'fail', detail: `the profile uses ${type}, but no dbt adapter is installed beside dbt-core`, fix: `pip install dbt-${type}` })
  else if (!installed.includes(type)) checks.push({ id: 'adapter', label: 'Adapter', status: 'fail', detail: `the profile uses ${type}, but only ${installed.join(', ')} ${installed.length === 1 ? 'is' : 'are'} installed`, fix: `pip install dbt-${type}` })
  else {
    const adapter = info.adapters.find(one => one.name === type)
    checks.push({ id: 'adapter', label: 'Adapter', status: 'ok', detail: `${type}${adapter ? ` ${adapter.version}` : ''}`, fix: null })
  }

  // Packages: packages.yml without dbt_packages/ fails every parse.
  const wantsPackages = (await $.fs.exists(`${root}/packages.yml`).catch(() => false)) || (await $.fs.exists(`${root}/dependencies.yml`).catch(() => false))
  if (wantsPackages) {
    const has = (await $.fs.list(`${root}/dbt_packages`).catch(() => [])).length > 0
    checks.push({ id: 'packages', label: 'Packages', status: has ? 'ok' : 'fail', detail: has ? 'dbt_packages installed' : 'packages.yml is not installed', fix: has ? null : 'dbt deps' })
  }

  // Manifest freshness.
  const target = await targetOf($, root)
  const stat = await $.fs.stat(`${target}/manifest.json`).catch(() => null)
  let staleFiles: string[] = []
  const shown = target.startsWith(`${root}/`) ? relative(root, target) : target
  if (!stat) checks.push({ id: 'manifest', label: 'Manifest', status: 'warn', detail: `${shown}/manifest.json is missing: lineage, model context and docs need it`, fix: 'dbt parse' })
  else {
    const scan = await changedSince($, root, stat.mtimeMs)
    staleFiles = scan.files
    const age = Math.round(((await $.clock.now()) - stat.mtimeMs) / 60_000)
    const ageText = age < 60 ? `${age} min` : age < 2880 ? `${Math.round(age / 60)} h` : `${Math.round(age / 1440)} days`
    checks.push(
      staleFiles.length
        ? { id: 'manifest', label: 'Manifest', status: 'warn', detail: `stale: ${staleFiles.length} file${staleFiles.length === 1 ? '' : 's'} changed since it was written ${ageText} ago (${staleFiles.slice(0, 3).join(', ')}${staleFiles.length > 3 ? ', …' : ''})`, fix: 'dbt parse' }
        : scan.complete
          ? { id: 'manifest', label: 'Manifest', status: 'ok', detail: `current (written ${ageText} ago)`, fix: null }
          : { id: 'manifest', label: 'Manifest', status: 'warn', detail: `no change found, but not every project file could be checked (over ${MAX_SCANNED} files, or a folder could not be read), so it may be stale (written ${ageText} ago)`, fix: 'dbt parse' },
    )
  }

  // The connection test opens a warehouse session: only when asked for.
  if (connection) {
    const debug = await runDbt($, root, ['debug'], 120_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    const parsed = debugInfo(`${debug.stdout}\n${debug.stderr}`)
    checks.push(
      debug.exitCode === 0 && parsed.connection !== 'failed'
        ? { id: 'connection', label: 'Connection', status: 'ok', detail: `${parsed.adapterType ?? type ?? 'warehouse'} connection test passed`, fix: null }
        : { id: 'connection', label: 'Connection', status: 'fail', detail: (parsed.detail ?? stripAnsi(debug.stdout || debug.stderr).trim().split('\n').slice(-3).join(' ')).slice(0, 300), fix: 'check profiles.yml credentials; run dbt debug' },
    )
  } else if (previous?.root === root) {
    const kept = previous.checks.find(one => one.id === 'connection')
    if (kept) checks.push(kept)
  }

  const view: DoctorView = { root, checks, at: await $.clock.now(), staleFiles, busy: null }
  await update($, doctorAtom, () => view)
  return view
}

async function parseNow($: EngineInterface, root: string) {
  const asked = generation
  const current = await read($, doctorAtom)
  if (current) await update($, doctorAtom, () => ({ ...current, busy: 'Running dbt parse…' }))
  const run = await runDbt($, root, ['parse'], 300_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (run.exitCode !== 0) {
    const reason = stripAnsi(run.stdout || run.stderr).trim().split('\n').slice(-3).join(' ').slice(0, 200)
    $.ui.toast(`✖ dbt parse failed · ${reason}`, { timeoutMs: 10000 })
  } else $.ui.toast('✓ dbt parse finished · the manifest is current', { timeoutMs: 6000 })
  const view = await runDoctor($, root)
  // Claude hears the manifest is current again on its next prompt.
  noteDoctor(root, view, asked)
}

function doctorSummary(view: DoctorView) {
  const bad = view.checks.filter(one => one.status !== 'ok')
  return { bad, text: bad.length === 0 ? `${view.checks.length} checks passed` : bad.map(one => `${one.label} ${one.status === 'fail' ? 'failed' : 'needs attention'}`).join(' · ') }
}

// Opened inside the press itself, so Claude Code counts it as the person's: a pane opened later, on the
// clock, is one the plugin asked for, and a narrow terminal leaves those unplaced.
async function openCheck($: EngineInterface, focus: boolean) {
  await $.ui.open({ id: CHECK_PANE, title: CHECK_TITLE, columns: 100, rows: 24, closeOnEscape: true, ...(focus ? { focus: true as const } : {}) })
}

async function openDoctor($: EngineInterface) {
  await $.ui.open({ id: DOCTOR_PANE, title: DOCTOR_TITLE, columns: 90, rows: 20, focus: true, closeOnEscape: true })
}

// ─── Start, the band, the hooks ─────────────────────────────────────────────────────────────────────

export async function startDbtMods($: EngineInterface, isInteractive: boolean) {
  contextGiven.clear()
  pendingNotes.splice(0)
  doctorNoteDue = null
  await loadHistory($)
  await $.command.register({ name: SHOW_COMMAND, description: 'Run dbt show for a model or a SQL query and open the rows in the results pane', argumentHint: '<model> | <select …>' })
  await $.command.register({ name: DOCTOR_COMMAND, description: 'Check the dbt environment: Python, dbt, adapter, packages, manifest freshness and the warehouse connection' })
  // The doctor at session start: a -p run or the SDK has nobody to show the band to, and no dbt to wait on.
  if (!isInteractive) return
  const asked = generation
  later($, async () => {
    const root = await sessionProject($)
    if (!root) return
    const view = await runDoctor($, root)
    const { bad, text } = doctorSummary(view)
    noteDoctor(root, view, asked)
    $.ui.toast(`${bad.length ? '⚕' : '✓'} dbt doctor · ${text}`, { timeoutMs: 8000 })
  })
}

/** The band lines: a failed run's Explain and Fix, the last compile-and-validate, the doctor's findings. */
export async function dbtModsBand($: EngineInterface, ui: { Box: any; Button: any; Text: any }): Promise<RenderElement | null> {
  const { Box, Button, Text } = ui
  const failure = await read($, failureAtom)
  const check = await read($, checkAtom)
  const doctor = await read($, doctorAtom)
  const rows: RenderElement[] = []

  if (failure) {
    const first = failure.failures[0]!
    const firstLine = first.message.split('\n').find(line => line.trim() && !/^(Compilation|Database|Runtime) Error$/.test(line.trim())) ?? first.message
    rows.push(
      <Box key="dbt-failure" flexDirection="column">
        <Text>
          <Text color="error">✖ dbt failed </Text>
          <Text bold>{failure.failures.map(one => one.name).slice(0, 3).join(', ')}</Text>
          {failure.failures.length > 3 ? <Text dimColor> +{failure.failures.length - 3}</Text> : null}
          <Text dimColor>  {firstLine.trim().slice(0, 140)}</Text>
        </Text>
        <Box>
          <Button key="dbt-explain" label="Explain" onPress={() => later($, async () => {
            await update($, failureAtom, () => null)
            await $.prompt.submit({ text: explainPrompt(failure.command, failure.failures) })
          })} />
          <Button key="dbt-fix" label="Fix with Altimate Code" onPress={() => later($, async () => {
            await update($, failureAtom, () => null)
            // The plugin's /altimate-code:altimate routes the fix through altimate-code; a plugin runs a
            // command with command.run, never a prompt that starts with "/".
            const task = fixPrompt(failure.command, failure.failures)
            await $.command.run({ command: 'altimate-code:altimate', args: task }).catch(() => $.prompt.submit({ text: `Use altimate-code (the altimate-code plugin) for this. ${task}` }))
          })} />
          <Button key="dbt-failure-dismiss" label="Dismiss" onPress={() => update($, failureAtom, () => null)} />
        </Box>
      </Box>,
    )
  }

  if (check) {
    const color = { running: 'subtle', ok: 'success', partial: 'subtle', warn: 'warning', error: 'error' }[check.status]
    const icon = STATUS_ICON[check.status]
    const detail =
      check.status === 'running'
        ? 'compiling and checking against the warehouse…'
        : check.status === 'partial'
          ? `${check.ran ? 'compiled and ran · columns not compared' : 'not checked'}: ${check.reason} · ${(check.ms / 1000).toFixed(1)}s`
        : check.status === 'error'
          ? (check.errors[0] ?? 'failed').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 160)
          : [
              check.columns !== null ? `${check.columns} columns` : 'no row returned',
              check.missing.length ? `missing ${check.missing.join(', ')}` : null,
              check.undocumented.length ? `undocumented ${check.undocumented.join(', ')}` : null,
              check.status === 'ok' && check.columns !== null ? 'match schema.yml' : null,
              `${(check.ms / 1000).toFixed(1)}s`,
            ]
              .filter(Boolean)
              .join(' · ')
    rows.push(
      <Box key="dbt-check">
        <Text>
          <Text color={color}>{icon} Compile & validate </Text>
          <Text bold>{check.model}</Text>
          <Text dimColor>  {detail}  </Text>
        </Text>
        {check.status !== 'running' ? <Button key="dbt-check-details" label="Details" onPress={() => openCheck($, true).catch(() => {})} /> : null}
        {check.status !== 'running' ? <Button key="dbt-check-dismiss" label="Dismiss" onPress={() => update($, checkAtom, () => null)} /> : null}
      </Box>,
    )
  }

  if (doctor && !doctor.busy) {
    const { bad } = doctorSummary(doctor)
    if (bad.length) {
      const stale = doctor.checks.find(one => one.id === 'manifest' && one.status !== 'ok')
      const deps = doctor.checks.find(one => one.id === 'packages' && one.status !== 'ok')
      rows.push(
        <Box key="dbt-doctor" flexDirection="column">
          <Text>
            <Text color="warning">⚕ dbt doctor </Text>
            <Text dimColor>{bad.map(one => `${one.label}: ${one.detail}`).join(' · ').slice(0, 200)}</Text>
          </Text>
          <Box>
            {deps ? <Button key="dbt-doctor-deps" label="Run dbt deps" onPress={() => later($, async () => {
              await runDbt($, doctor.root, ['deps'], 300_000).catch(() => null)
              await parseNow($, doctor.root)
            })} /> : null}
            {stale ? <Button key="dbt-doctor-parse" label="Run dbt parse" onPress={() => later($, () => parseNow($, doctor.root))} /> : null}
            <Button key="dbt-doctor-details" label="Details" onPress={() => openDoctor($).catch(() => {})} />
            <Button key="dbt-doctor-dismiss" label="Dismiss" onPress={() => update($, doctorAtom, () => ({ ...doctor, checks: doctor.checks.filter(one => one.status === 'ok') }))} />
          </Box>
        </Box>,
      )
    }
  } else if (doctor?.busy) {
    rows.push(
      <Box key="dbt-doctor-busy">
        <Text dimColor>⚕ {doctor.busy}</Text>
      </Box>,
    )
  }

  if (rows.length === 0) return null
  return (
    <Box key="dbt-mods-band" flexDirection="column">
      {rows}
    </Box>
  )
}

/** Claude's reads, edits and dbt commands: model context, compile-and-validate, failed runs, results. */
async function dbtToolCall($: EngineInterface, e: any, next: (e: any) => Promise<any>): Promise<any> {
  // One spelling of the file (`a/../b` → `b`), so its path inside the project is read right.
  const file = (EDIT_TOOLS.has(e.tool) || e.tool === 'Read') && 'file_path' in e ? normalize(String((e as any).file_path)) : null
  const isSql = !!file && /\.sql$/i.test(file)
  const command = e.tool === 'Bash' && 'command' in e ? String((e as any).command) : null
  const dbt = command ? dbtCommand(command) : null
  const agentId: string | null = (e as { agentId?: string }).agentId ?? null
  // The conversation this tool call belongs to: one that ends (/clear) while it runs gets nothing from it.
  const asked = generation
  const startedAt = await $.clock.now()
  const result = await next(e)
  if (result.deny) return result

  // 12 · A model Claude reads: the manifest's facts go with the file.
  if (isSql && e.tool === 'Read' && !result.isError) {
    const found = await modelNote($, file!, agentId ?? undefined).catch(() => null)
    if (found) {
      $.ui.toast(found.toast, { timeoutMs: 6000 })
      $.ui.log(`model-context · added to Claude's context: ${basename(file!)}`)
      return withPending(addContext(result, found.note), agentId)
    }
    return withPending(result, agentId)
  }

  // 07 · A model Claude edits: compile it and run it against the warehouse, then check its columns.
  if (isSql && EDIT_TOOLS.has(e.tool) && !result.isError) {
    const root = await projectRoot($, file!, true)
    // Only a file under the project's model-paths is a model dbt can show.
    const folders = root ? modelPaths(await $.fs.read(`${root}/dbt_project.yml`).catch(() => '')) : []
    const inModels = !!root && folders.some(folder => (folder === '' ? !/^(target|dbt_packages|dbt_modules|logs)\//.test(relative(root, file!)) : relative(root, file!).startsWith(`${folder}/`)))
    if (root && inModels) {
      const check = compileAndValidate($, root, file!, asked)
      const landed = await within($, CHECK_HOLD_MS, check)
      // Landed, and still the newest check of this file in this conversation.
      if (landed && landed.current()) {
        $.ui.toast(
          landed.view.status === 'error'
            ? `✖ ${landed.view.model} · dbt could not compile or run it · see the band`
            : landed.view.status === 'partial'
              ? `◦ ${landed.view.model} · ${landed.view.ran ? 'compiled and ran; columns not compared' : 'not checked: dbt has no model for this file'}`
              : `${STATUS_ICON[landed.view.status]} ${landed.view.model} · compiled and validated against the warehouse`,
          { timeoutMs: 6000 },
        )
        return withPending(addContext(result, landed.note), agentId)
      }
      // Too slow for this result: its answer rides on this agent's next one, if it is still the newest.
      if (!landed) check.then(done => void (done.current() && pendingNotes.push({ note: done.note, agentId, current: done.current }))).catch(() => {})
      return withPending(result, agentId)
    }
  }

  // A shell command, or an edit of another file (schema.yml), may have changed the checked model.
  // An edit of a .yml (a schema file documenting the model for the first time) or of another .sql (a macro
  // the model calls) can change its answer though neither watched file did: check it again regardless.
  const forced = !!file && EDIT_TOOLS.has(e.tool) && !result.isError && /\.(ya?ml|sql)$/i.test(file)
  if (command || forced) later($, () => recheck($, forced ? file : null))

  // 08 and 09 · Claude's own dbt commands.
  if (command && dbt) {
    const raw = (result as any).result
    const output = typeof raw?.stdout === 'string' ? `${raw.stdout}\n${raw.stderr ?? ''}` : String(result.text ?? '')
    // Where it ran: the `cd`s before the dbt invocation; its project: --project-dir, else the folder's.
    const dir = cdTarget(command.slice(0, dbt.at), (await $.session.root().catch(() => '.')) as string)
    // A `cd ~/x` or `cd $DIR` leaves the folder unknown: nothing is filed under a guessed project.
    if (dir === null) return withPending(result, agentId)
    const projectDir = dbt.options.reduce<string | null>((found, value, i) => (dbt.options[i - 1] === '--project-dir' ? value : found), null)
    const root = await projectRoot($, projectDir ? (projectDir.startsWith('/') ? projectDir : `${dir.replace(/\/+$/, '')}/${projectDir}`) : dir, false)
    if (root && ['run', 'test', 'build', 'seed', 'snapshot'].includes(dbt.verb)) {
      const failed = !!result.isError || saysFailed(output)
      // Where it ran includes the environment set for it in the same command (`DBT_TARGET=prod dbt run`).
      await recordRun($, command.trim().slice(0, 300), dbt.verb, dbt.select, [...dbt.options, ...dbt.env.map(one => `env:${one}`)], root, output, failed, startedAt, asked).catch(() => null)
    }
    if (root && dbt.verb === 'show' && !result.isError) {
      const table = showPreview(output) ?? textTable(output)
      if (table) {
        const select = dbt.select
        const inline = select ? null : dbt.inline
        // A re-run runs Claude's own invocation again, from where it ran: same flags, same order.
        const replay = replayArgv(dbt.argv, 0).slice(0, -6)
        // A command that depended on its shell (variables, `~`, globs, other commands before it) cannot be
        // repeated word for word: it is kept in the pane, with no Re-run.
        await showResult(
          $,
          { id: JSON.stringify([root, dir, replay, dbt.env]), title: titleOf(select, inline) || 'dbt show', root, select, inline, options: dbt.options, argv: dbt.replayable ? dbt.argv : null, cwd: dir, replayable: dbt.replayable, columns: table.columns, rows: table.rows, limit: dbt.limit ?? 5, ms: (await $.clock.now()) - startedAt, at: await $.clock.now(), error: null, by: 'claude' },
          true,
        ).catch(() => null)
      }
    }
  }
  return withPending(result, agentId)
}

/**
 * A conversation ended (a /clear): its notes, context, check and failed run are not the next one's.
 * Called from the plugin's one session.end hook. A check still running lands nowhere.
 */
export async function endDbtMods($: EngineInterface) {
  generation++
  slices.clear()
  forcedWhileBusy = null
  contextGiven.clear()
  pendingNotes.splice(0)
  doctorNoteDue = null
  await update($, checkAtom, () => null)
  await update($, failureAtom, () => null)
}

/** A main-conversation turn started: the model context may have been compacted, so it is given again. */
export function newTurnDbtMods() {
  contextGiven.clear()
}

export function registerDbtMods(on: On) {

  // The doctor's findings go with the first prompt after they land.
  on('prompt.submit', async ($, e, next) => {
    if (!doctorNoteDue) return next(e)
    const note = doctorNoteDue
    doctorNoteDue = null
    $.ui.log('dbt-doctor · added to Claude\'s context: the dbt environment check')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // One hook per tool it watches: the plugin's lineage half hooks every tool call without a matcher.
  on('tool.call', { tool: 'Read' }, dbtToolCall)
  on('tool.call', { tool: 'Edit' }, dbtToolCall)
  on('tool.call', { tool: 'Write' }, dbtToolCall)
  on('tool.call', { tool: 'Bash' }, dbtToolCall)

  on('command.run', { command: SHOW_COMMAND }, async ($, e) => {
    const root = await sessionProject($)
    if (!root) return { text: 'No dbt project here: start Claude Code in a dbt project (a folder with dbt_project.yml).' }
    const args = e.args.trim()
    try {
      await $.ui.open({ id: RESULTS_PANE, title: RESULTS_TITLE, columns: 110, rows: 30, focus: true, closeOnEscape: true })
    } catch (error) {
      return { text: `Could not open the results pane: ${String(error)}` }
    }
    if (!args) return { text: 'dbt results are open. Run /dbt-show <model> or /dbt-show select … to query.' }
    const isSql = /\s/.test(args) || /^(select|with)\b/i.test(args)
    later($, () => runShow($, root, isSql ? null : args, isSql ? args : null))
    return { text: `Running dbt show for ${isSql ? 'your query' : args}; the rows open in the results pane.` }
  })

  on('command.run', { command: DOCTOR_COMMAND }, async ($, e) => {
    const root = await sessionProject($)
    if (!root) return { text: 'No dbt project here: start Claude Code in a dbt project (a folder with dbt_project.yml).' }
    try {
      await openDoctor($)
    } catch (error) {
      return { text: `Could not open the dbt doctor: ${String(error)}` }
    }
    const asked = generation
    later($, async () => {
      const view = await runDoctor($, root, true)
      noteDoctor(root, view, asked)
    })
    return { text: 'Checking the dbt environment, the warehouse connection included; the results are in the dbt doctor pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: RESULTS_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const result = await read($, resultAtom)
    const history = await read($, historyAtom)
    const busy = await read($, resultBusyAtom)
    // The pane's border and scrollbar take a few of its columns.
    const width = Math.max(30, ((e.props as any).bodyColumns ?? 100) - 4)
    const saved = result ? history.find(one => one.id === result.id) : null
    const marks = history.filter(one => one.bookmarked)
    const recent = history.filter(one => !one.bookmarked && one.id !== result?.id).slice(0, HISTORY_SHOWN)
    // Clear history is offered while any query that is not bookmarked is kept, the one shown included.
    const clearable = history.some(one => !one.bookmarked)

    const table = (() => {
      if (!result) return <Text dimColor>Run /dbt-show &lt;model&gt;, or ask Claude to `dbt show` a model.</Text>
      if (result.error) return <Text color="error">{result.error.slice(0, 600)}</Text>
      if (result.rows.length === 0) return <Text dimColor>No rows.</Text>
      const widths = columnWidths(result, width)
      const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join(' │ ')
      return (
        <Box flexDirection="column">
          <Text bold>{line(result.columns.map((name, i) => cellText(name, widths[i]!)))}</Text>
          <Text dimColor>{widths.map(one => '─'.repeat(one)).join('─┼─')}</Text>
          {result.rows.map((row, r) => (
            <Text key={`row-${r}`}>{line(row.map((cell, i) => cellText(cell, widths[i]!)))}</Text>
          ))}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>{result ? result.title : 'dbt results'}</Text>
            {result && !result.error ? (
              <Text dimColor>
                {'  '}
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'} · {result.columns.length} columns{result.ms !== null ? ` · ${(result.ms / 1000).toFixed(1)}s` : ''} · {result.by === 'claude' ? "Claude's dbt show" : 'your query'}
              </Text>
            ) : null}
          </Text>
          {busy ? <Text color="suggestion">{busy}</Text> : null}
          {result ? (
            <Box>
              <Button key="results-bookmark" label={saved?.bookmarked ? '★ Bookmarked' : '☆ Bookmark'} onPress={() => later($, () => toggleBookmark($, result.id))} />
              {!busy && result.replayable !== false ? <Button key="results-rerun" label="Re-run" onPress={() => later($, async () => void (await rerun($, result)))} /> : null}
              {result.replayable === false ? <Text dimColor>  Re-run is off: Claude's command depended on its shell (variables, `~`, other commands before it)</Text> : null}
            </Box>
          ) : null}
        </Box>
        {table}
        {marks.length ? (
          <Box flexDirection="column">
            <Text bold>Bookmarks</Text>
            {marks.map(one => (
              <Button key={`mark-${one.id}`} plain label={`★ ${one.title}  (${one.rows.length} rows)`} onPress={() => later($, () => update($, resultAtom, () => one))} />
            ))}
          </Box>
        ) : null}
        {recent.length ? (
          <Box flexDirection="column">
            <Text bold>History</Text>
            {recent.map(one => (
              <Button key={`hist-${one.id}`} plain label={`${one.title}  (${one.error ? 'error' : `${one.rows.length} rows`} · ${one.by === 'claude' ? 'Claude' : 'you'})`} onPress={() => later($, () => update($, resultAtom, () => one))} />
            ))}
          </Box>
        ) : null}
        {clearable ? (
          <Box>
            <Button key="results-clear" label="Clear history" onPress={() => later($, () => clearHistory($))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHECK_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const check = await read($, checkAtom)
    if (!check) return (
      <Box flexDirection="column">
        <Text dimColor>No check yet. The plugin checks a model each time Claude edits it.</Text>
      </Box>
    )
    const color = { running: 'subtle', ok: 'success', partial: 'subtle', warn: 'warning', error: 'error' }[check.status]
    const verdict = {
      running: 'Compiling and running it against the warehouse…',
      ok: 'Compiles, runs, and its columns match schema.yml',
      partial: check.ran ? `Compiles and runs; columns not compared: ${check.reason}` : `Not checked: ${check.reason}`,
      warn: 'Compiles and runs, but its columns differ from schema.yml',
      error: 'dbt could not compile or run it',
    }[check.status]
    const missing = new Set(check.missing.map(one => one.toLowerCase()))
    const extra = new Set(check.undocumented.map(one => one.toLowerCase()))
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>Compile & validate · {check.model}</Text>
            <Text dimColor>  {check.file}{check.status !== 'running' ? ` · ${(check.ms / 1000).toFixed(1)}s` : ''}</Text>
          </Text>
          <Text color={color} bold>{verdict}</Text>
        </Box>
        {check.errors.length ? (
          <Box flexDirection="column">
            <Text bold>dbt said</Text>
            {check.errors.slice(0, 3).flatMap((one, i) => one.split('\n').filter(line => line.trim()).slice(0, 12).map((line, j) => (
              <Text key={`err-${i}-${j}`} color="error">{line}</Text>
            )))}
          </Box>
        ) : null}
        {check.status === 'ok' || check.status === 'warn' || (check.status === 'partial' && check.returned.length > 0) ? (
          <Box flexDirection="column">
            <Text bold>{check.status === 'partial' ? 'Columns the warehouse returned' : 'Columns · warehouse vs schema.yml'}</Text>
            {check.columns === null ? <Text dimColor>The query returned no row, so its columns could not be read.</Text> : null}
            {check.returned.map(name => (
              <Text key={`col-${name}`}>
                {check.status === 'partial' ? <Text dimColor>· </Text> : <Text color={extra.has(name.toLowerCase()) ? 'warning' : 'success'}>{extra.has(name.toLowerCase()) ? '+ ' : '✓ '}</Text>}
                <Text>{name}</Text>
                {extra.has(name.toLowerCase()) ? <Text dimColor>  returned, not documented</Text> : null}
              </Text>
            ))}
            {check.documented.filter(name => missing.has(name.toLowerCase())).map(name => (
              <Text key={`miss-${name}`}>
                <Text color="error">- </Text>
                <Text>{name}</Text>
                <Text dimColor>  documented, not returned</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {check.status !== 'running' ? (
          <Box>
            <Button key="check-again" label="Check again" onPress={() => later($, async () => void (await compileAndValidate($, check.root, `${check.root}/${check.file}`)))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DOCTOR_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const doctor = await read($, doctorAtom)
    if (!doctor) return (
      <Box flexDirection="column">
        <Text dimColor>No dbt project checked yet. Run /dbt-doctor in a dbt project.</Text>
      </Box>
    )
    const color = { ok: 'success', warn: 'warning', fail: 'error' } as const
    const icon = { ok: '✓', warn: '⚠', fail: '✖' } as const
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>dbt environment</Text>
          <Text dimColor>{doctor.root}</Text>
          {doctor.busy ? <Text color="suggestion">{doctor.busy}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {doctor.checks.map(one => (
            <Text key={`check-${one.id}`}>
              <Text color={color[one.status]}>{icon[one.status]} {one.label.padEnd(11)}</Text>
              <Text>{one.detail}</Text>
              {one.fix ? <Text dimColor>  → {one.fix}</Text> : null}
            </Text>
          ))}
        </Box>
        {!doctor.busy ? (
          <Box>
            {doctor.checks.some(one => one.id === 'manifest' && one.status !== 'ok') ? <Button key="doctor-parse" label="Run dbt parse" onPress={() => later($, () => parseNow($, doctor.root))} /> : null}
            <Button key="doctor-connection" label="Test connection" onPress={() => later($, async () => void (await runDoctor($, doctor.root, true)))} />
            <Button key="doctor-recheck" label="Check again" onPress={() => later($, async () => void (await runDoctor($, doctor.root)))} />
          </Box>
        ) : null}
      </Box>
    )
  })
}

// Where a shell command runs: the session folder, moved by each `cd` in it.
const CD = /(?:^|[;&|(\n]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm
function cdTarget(command: string, cwd: string): string | null {
  let dir = cwd
  for (const match of command.matchAll(CD)) {
    const target = match[1]!.replace(/^['"]|['"]$/g, '')
    // A folder the shell would expand (`~`, a variable) is not one the plugin can name.
    if (/^~|[$`]/.test(target)) return null
    dir = target.startsWith('/') ? target : `${dir.replace(/\/+$/, '')}/${target}`
  }
  return normalize(dir)
}
